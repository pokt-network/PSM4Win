// Pretty Charts backend for Pocket Network.
//
// HTTP contract (every response is a JSON object, including errors; see the
// Skill's references/design-rules.md):
//   GET|HEAD /                -> {service, status}            RelayMiner reachability ping
//   GET  /healthz             -> {status: "ok"}               readiness probe (503 until a worker is up)
//   GET  /v1/version          -> {service, version, engine}   identity probe
//   GET  /v1/capabilities     -> marks, shorthand types, themes, formats, limits
//   GET  /v1/openapi.json     -> the OpenAPI document for this service
//   POST /v1/chart            -> {format, width, height, rows, marks, ..., html}
//
// Rendering happens in worker threads (render-worker.js) so the probes stay
// responsive and an over-budget render can be killed without taking the server down.

import http from "node:http";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { config } from "./config.js";

const OPENAPI = readFileSync(new URL("./openapi.json", import.meta.url));
const LIMITS = Object.freeze({
  maxBodyBytes: config.maxBodyBytes,
  maxRows: config.maxRows,
  maxMarks: config.maxMarks,
  maxSvgBytes: config.maxSvgBytes,
  renderBudgetMs: config.renderBudgetMs,
});

// ---------------------------------------------------------------------------
// Worker pool

class RenderPool {
  constructor(size) {
    this.size = size;
    this.workers = new Set();
    this.idle = [];
    this.queue = [];
    this.engine = null;
    this.closing = false;
    this.nextId = 1;
    for (let i = 0; i < size; i++) this.spawn();
  }

  get readyCount() {
    let n = 0;
    for (const w of this.workers) if (w.ready) n++;
    return n;
  }

  spawn() {
    const rec = { worker: new Worker(new URL("./render-worker.js", import.meta.url)), ready: false, job: null, timer: null };
    rec.worker.on("message", (msg) => {
      if (msg.ready) {
        rec.ready = true;
        this.engine = msg.engine;
        this.idle.push(rec);
        this.pump();
        return;
      }
      const job = rec.job;
      if (!job || job.id !== msg.id) return;
      clearTimeout(rec.timer);
      rec.job = null;
      rec.timer = null;
      this.idle.push(rec);
      job.resolve(msg);
      this.pump();
    });
    rec.worker.on("error", (err) => {
      console.error(JSON.stringify({ msg: "render worker error", error: err && err.stack ? err.stack : String(err) }));
      this.failJob(rec, { status: 500, code: "render_failed", message: `render worker crashed: ${err.message}` });
    });
    rec.worker.on("exit", (code) => {
      if (!this.closing) console.error(JSON.stringify({ msg: "render worker exited", code, ready: rec.ready }));
      this.failJob(rec, { status: 500, code: "render_failed", message: "render worker exited" });
      this.workers.delete(rec);
      this.idle = this.idle.filter((r) => r !== rec);
      if (!this.closing) setTimeout(() => this.spawn(), 250);
    });
    this.workers.add(rec);
  }

  failJob(rec, error) {
    const job = rec.job;
    if (!job) return;
    clearTimeout(rec.timer);
    rec.job = null;
    rec.timer = null;
    job.resolve({ id: job.id, ok: false, error });
  }

  submit(body) {
    return new Promise((resolve, reject) => {
      if (this.closing) return reject(Object.assign(new Error("shutting down"), { status: 503, code: "shutting_down" }));
      if (this.queue.length >= config.maxQueue) {
        return reject(Object.assign(new Error("too many renders in flight; retry shortly"), { status: 503, code: "busy" }));
      }
      this.queue.push({ id: this.nextId++, body, resolve });
      this.pump();
    });
  }

  pump() {
    while (this.idle.length && this.queue.length) {
      const rec = this.idle.pop();
      const job = this.queue.shift();
      rec.job = job;
      rec.timer = setTimeout(() => {
        // Over budget: kill the worker (a fresh one is spawned on exit) and answer the caller.
        rec.job = null;
        job.resolve({
          id: job.id, ok: false,
          error: { status: 422, code: "render_budget_exceeded", message: `the render did not finish within ${config.renderBudgetMs} ms; reduce the data or the number of marks`, details: { render_budget_ms: config.renderBudgetMs } },
        });
        rec.worker.terminate();
      }, config.renderBudgetMs);
      rec.worker.postMessage({ id: job.id, body: job.body, limits: LIMITS });
    }
  }

  close() {
    this.closing = true;
    for (const rec of this.workers) rec.worker.terminate();
  }
}

const pool = new RenderPool(config.workers);

// ---------------------------------------------------------------------------
// HTTP helpers

function sendJson(res, status, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendError(res, status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  sendJson(res, status, { error });
}

// Reads a JSON body of at most config.maxBodyBytes. Bodies arrive chunked from the
// RelayMiner (no Content-Length), so the size is enforced while streaming.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const declared = parseInt(req.headers["content-length"] || "", 10);
    if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
      return reject(Object.assign(new Error(`request body is larger than ${config.maxBodyBytes} bytes`), { status: 413, code: "body_too_large" }));
    }
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        reject(Object.assign(new Error(`request body is larger than ${config.maxBodyBytes} bytes`), { status: 413, code: "body_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", (e) => reject(Object.assign(e, { status: 400, code: "invalid_request" })));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") return reject(Object.assign(new Error("request body is empty; send a JSON object"), { status: 400, code: "invalid_json" }));
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(Object.assign(new Error(`body must be valid JSON: ${e.message}`), { status: 400, code: "invalid_json" }));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Routes

const server = http.createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
  const method = req.method || "GET";
  const isGet = method === "GET" || method === "HEAD";

  try {
    if (path === "/") {
      if (!isGet) return sendError(res, 405, "method_not_allowed", "use GET");
      return sendJson(res, 200, { service: config.service, status: "ok" });
    }
    if (path === "/healthz" || path === "/v1/health") {
      if (!isGet) return sendError(res, 405, "method_not_allowed", "use GET");
      if (pool.readyCount === 0) return sendJson(res, 503, { status: "starting" });
      return sendJson(res, 200, { status: "ok" });
    }
    if (path === "/v1/version") {
      if (!isGet) return sendError(res, 405, "method_not_allowed", "use GET");
      const engine = pool.engine || {};
      return sendJson(res, 200, {
        service: config.service,
        version: config.version,
        engine: { vega: engine.vega || null, vega_lite: engine.vega_lite || null, vega_themes: engine.vega_themes || null, node: process.version },
      });
    }
    if (path === "/v1/capabilities") {
      if (!isGet) return sendError(res, 405, "method_not_allowed", "use GET");
      const engine = pool.engine || {};
      return sendJson(res, 200, {
        service: config.service,
        version: config.version,
        endpoint: { method: "POST", path: "/v1/chart" },
        request: {
          data: ["csv", "tsv", "json", "values"],
          one_of: ["spec (a Vega-Lite spec)", "chart (shorthand: type, x, y, color, size, shape, theta, row, column, text, xRange, yRange, colors, colorScheme, stack, tooltip, title, width, height, mark, transform)"],
          options: ["format", "tooltips", "width", "height", "padding", "background", "title", "theme", "seed", "config"],
        },
        marks: engine.marks || [],
        shorthand_types: engine.shorthand_types || [],
        themes: engine.themes || [],
        formats: engine.formats || ["svg", "html"],
        tooltips: "native SVG <title> elements on every data mark; no script is returned or required",
        remote_data: false,
        limits: {
          max_body_bytes: config.maxBodyBytes,
          max_rows: config.maxRows,
          max_marks: config.maxMarks,
          max_svg_bytes: config.maxSvgBytes,
          render_budget_ms: config.renderBudgetMs,
        },
      });
    }
    if (path === "/v1/openapi.json") {
      if (!isGet) return sendError(res, 405, "method_not_allowed", "use GET");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": OPENAPI.length, "Cache-Control": "no-store" });
      return res.end(OPENAPI);
    }
    if (path === "/v1/chart") {
      if (method !== "POST") return sendError(res, 405, "method_not_allowed", "use POST with a JSON body");
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendError(res, e.status || 400, e.code || "invalid_request", e.message);
      }
      let reply;
      try {
        reply = await pool.submit(body);
      } catch (e) {
        return sendError(res, e.status || 503, e.code || "busy", e.message);
      }
      if (!reply.ok) return sendError(res, reply.error.status || 500, reply.error.code, reply.error.message, reply.error.details);
      return sendJson(res, 200, { service: config.service, ...reply.result });
    }
    return sendError(res, 404, "not_found", "unknown path", {
      paths: ["GET /", "GET /healthz", "GET /v1/version", "GET /v1/capabilities", "GET /v1/openapi.json", "POST /v1/chart"],
    });
  } catch (e) {
    return sendError(res, 500, "internal_error", "unexpected failure");
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = 60000;

server.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ msg: "listening", service: config.service, version: config.version, port: config.port, workers: config.workers, limits: LIMITS }));
});

function shutdown() {
  server.close(() => {
    pool.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
