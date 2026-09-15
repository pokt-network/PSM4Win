// Smoke test: starts the server with small limits, exercises every route, and checks
// the Pocket design rules (every body is a JSON object, 4xx JSON on bad input, no
// gzip, chunked bodies decode, deterministic output). Run: npm test
import { spawn } from "node:child_process";
import http from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, PORT: String(PORT), PC_MAX_ROWS: "200", PC_MAX_MARKS: "150", PC_MAX_BODY_BYTES: "65536", PC_WORKERS: "1" };
const child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], { env, stdio: ["ignore", "pipe", "inherit"] });
child.stdout.on("data", () => {});

function request(method, path, body, { chunked = false, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", "Accept-Encoding": "gzip", ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      if (chunked) {
        // No Content-Length: Node sends Transfer-Encoding: chunked, as the RelayMiner does.
        const mid = Math.floor(payload.length / 2);
        req.write(payload.slice(0, mid));
        setTimeout(() => req.end(payload.slice(mid)), 10);
        return;
      }
      req.setHeader("Content-Length", Buffer.byteLength(payload));
      req.end(payload);
      return;
    }
    req.end();
  });
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await request("GET", "/healthz");
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not become ready");
}

function json(r) {
  assert.ok(r.text.startsWith("{"), `body must start with '{' (got ${JSON.stringify(r.text.slice(0, 40))})`);
  assert.equal(r.headers["content-encoding"], undefined, "no gzip");
  return JSON.parse(r.text);
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([name, "ok"]);
    console.log(`  ok   ${name}`);
  } catch (e) {
    results.push([name, e.message]);
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}

const CSV = "month,sales,region\nJan,120,north\nFeb,98,south\nMar,143,north";

try {
  await waitReady();

  await test("GET / answers the RelayMiner ping", async () => {
    const r = await request("GET", "/");
    assert.equal(r.status, 200);
    assert.equal(json(r).status, "ok");
  });
  await test("HEAD / is 2xx", async () => {
    const r = await request("HEAD", "/");
    assert.equal(r.status, 200);
  });
  await test("GET /v1/version is the identity probe", async () => {
    const r = await request("GET", "/v1/version");
    const b = json(r);
    assert.equal(r.status, 200);
    assert.equal(b.service, "example-charts");
    assert.match(b.engine.vega_lite, /^\d+\./);
  });
  await test("GET /v1/capabilities lists marks, themes, limits", async () => {
    const b = json(await request("GET", "/v1/capabilities"));
    assert.ok(b.marks.includes("bar") && b.marks.includes("boxplot"));
    assert.ok(b.themes.includes("dark"));
    assert.equal(b.limits.max_rows, 200);
  });
  await test("GET /v1/openapi.json is the OpenAPI document", async () => {
    const b = json(await request("GET", "/v1/openapi.json"));
    assert.equal(b.openapi, "3.1.0");
    assert.ok(b.paths["/v1/chart"]);
  });

  let first;
  await test("shorthand bar chart from CSV renders with native tooltips", async () => {
    const r = await request("POST", "/v1/chart", { data: { csv: CSV }, chart: { type: "bar", x: "month", y: "sales", title: "Sales" } });
    const b = json(r);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(b.format, "svg");
    assert.equal(b.marks, 3);
    assert.equal(b.rows, 3);
    assert.ok(b.html.startsWith("<svg"));
    assert.ok(b.html.includes("<title>month: Jan; sales: 120</title>"), "tooltip title present");
    assert.ok(b.html.includes("Sales"), "title rendered");
    assert.ok(b.html.indexOf(">Jan<") < b.html.indexOf(">Feb<") && b.html.indexOf(">Feb<") < b.html.indexOf(">Mar<"), "categories keep data order");
    assert.equal(Object.keys(b).pop(), "html", "html is the last field");
    first = b.html;
  });
  await test("identical requests are byte-identical (deterministic)", async () => {
    const b = json(await request("POST", "/v1/chart", { data: { csv: CSV }, chart: { type: "bar", x: "month", y: "sales", title: "Sales" } }));
    assert.equal(b.html, first);
  });
  await test("chunked request bodies decode (RelayMiner style)", async () => {
    const r = await request("POST", "/v1/chart", { data: { csv: CSV }, chart: { type: "bar", x: "month", y: "sales" } }, { chunked: true });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(json(r).marks, 3);
  });
  await test("scatter with color series, ranges, colors, chosen tooltip fields, dark theme", async () => {
    const b = json(await request("POST", "/v1/chart", {
      data: { values: [{ x: 1, y: 2, g: "a", note: "first" }, { x: 2, y: 3, g: "b", note: "second" }] },
      chart: { type: "scatter", x: "x", y: "y", color: "g", xRange: [0, 5], yRange: [0, 5], colors: ["#ff0000", "#00ff00"], tooltip: ["g", "note"] },
      options: { theme: "dark", width: 400, height: 300 },
    }));
    assert.equal(b.marks, 2);
    assert.ok(b.html.includes("<title>g: a; note: first</title>"), "custom tooltip");
    assert.ok(b.html.includes("#ff0000") || b.html.includes("#f00"), "custom color used");
    assert.equal(b.width, 400 + (b.width - 400)); // width is a number
  });
  await test("pie shorthand maps x/y to color/theta", async () => {
    const b = json(await request("POST", "/v1/chart", { data: { csv: "k,v\na,1\nb,2\nc,3" }, chart: { type: "donut", x: "k", y: "v" } }));
    assert.equal(b.marks, 3);
    assert.ok(b.html.includes('aria-roledescription="arc mark"'));
  });
  await test("full Vega-Lite spec with layers and a transform; html format", async () => {
    const r = await request("POST", "/v1/chart", {
      data: { csv: "date,value\n2026-01-01,10\n2026-02-01,14\n2026-03-01,9" },
      spec: {
        transform: [{ calculate: "datum.value * 2", as: "double" }],
        layer: [
          { mark: "line", encoding: { x: { field: "date", type: "temporal" }, y: { field: "value", type: "quantitative" } } },
          { mark: "point", encoding: { x: { field: "date", type: "temporal" }, y: { field: "double", type: "quantitative" } } },
        ],
      },
      options: { format: "html", title: "Doubled" },
    });
    const b = json(r);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(b.format, "html");
    assert.ok(b.html.startsWith("<!DOCTYPE html>"));
    assert.ok(b.html.includes("<svg"));
    assert.equal(b.marks, 6);
  });
  await test("line chart tooltips: one title per series path", async () => {
    const b = json(await request("POST", "/v1/chart", { data: { csv: CSV }, chart: { type: "line", x: "month", y: "sales", color: "region" } }));
    assert.equal((b.html.match(/<title>/g) || []).length, 2);
  });
  await test("tooltips can be disabled", async () => {
    const b = json(await request("POST", "/v1/chart", { data: { csv: CSV }, chart: { type: "bar", x: "month", y: "sales" }, options: { tooltips: false } }));
    assert.ok(!b.html.includes("<title>"));
    assert.equal(b.tooltips, false);
  });
  await test("sample transform is deterministic across calls", async () => {
    const body = { data: { values: Array.from({ length: 100 }, (_, i) => ({ i, v: (i * 7) % 13 })) }, spec: { transform: [{ sample: 10 }], mark: "point", encoding: { x: { field: "i", type: "quantitative" }, y: { field: "v", type: "quantitative" } } } };
    const a = json(await request("POST", "/v1/chart", body)), b = json(await request("POST", "/v1/chart", body));
    assert.equal(a.marks, 10);
    assert.equal(a.html, b.html);
  });

  // Error handling
  await test("invalid JSON is a 400 JSON error", async () => {
    const r = await request("POST", "/v1/chart", "{not json");
    assert.equal(r.status, 400);
    assert.equal(json(r).error.code, "invalid_json");
  });
  await test("empty body is a 400", async () => {
    const r = await request("POST", "/v1/chart", "");
    assert.equal(r.status, 400);
    assert.equal(json(r).error.code, "invalid_json");
  });
  await test("neither spec nor chart is a 400", async () => {
    const r = await request("POST", "/v1/chart", { data: { csv: CSV } });
    assert.equal(r.status, 400);
    assert.equal(json(r).error.code, "invalid_request");
  });
  await test("unknown chart type lists the valid ones", async () => {
    const r = await request("POST", "/v1/chart", { data: { csv: CSV }, chart: { type: "bubble", x: "month", y: "sales" } });
    assert.equal(r.status, 400);
    assert.match(json(r).error.message, /scatter/);
  });
  await test("unknown column lists the available columns", async () => {
    const r = await request("POST", "/v1/chart", { data: { csv: CSV }, chart: { type: "bar", x: "month", y: "revenue" } });
    const b = json(r);
    assert.equal(r.status, 400);
    assert.equal(b.error.code, "unknown_field");
    assert.deepEqual(b.error.details.columns, ["month", "sales", "region"]);
  });
  await test("remote data URL is refused", async () => {
    const r = await request("POST", "/v1/chart", { spec: { data: { url: "https://example.com/x.csv" }, mark: "bar", encoding: { x: { field: "a", type: "nominal" } } } });
    assert.equal(r.status, 400);
    assert.equal(json(r).error.code, "remote_data_not_allowed");
  });
  await test("nested url (lookup transform) is refused", async () => {
    const r = await request("POST", "/v1/chart", { data: { csv: CSV }, spec: { transform: [{ lookup: "month", from: { data: { url: "https://example.com/x.json" }, key: "m", fields: ["z"] } }], mark: "bar", encoding: { x: { field: "month", type: "nominal" } } } });
    assert.equal(r.status, 400);
    assert.equal(json(r).error.code, "remote_data_not_allowed");
  });
  await test("invalid spec reports schema errors", async () => {
    const r = await request("POST", "/v1/chart", { data: { csv: CSV }, spec: { mark: "bar", encoding: { x: { field: "month", type: "categorical" } } } });
    const b = json(r);
    assert.equal(r.status, 400);
    assert.equal(b.error.code, "invalid_spec");
    assert.ok(Array.isArray(b.error.details) && b.error.details.length > 0);
  });
  await test("unknown mark name is a 400 naming the valid marks", async () => {
    const r = await request("POST", "/v1/chart", { data: { csv: CSV }, spec: { mark: "bars", encoding: { x: { field: "month", type: "nominal" } } } });
    assert.equal(r.status, 400);
    assert.match(json(r).error.message, /valid marks are/);
  });
  await test("unknown theme is a 400", async () => {
    const r = await request("POST", "/v1/chart", { data: { csv: CSV }, chart: { type: "bar", x: "month", y: "sales" }, options: { theme: "neon" } });
    assert.equal(r.status, 400);
  });
  await test("too many rows is a 413", async () => {
    const r = await request("POST", "/v1/chart", { data: { values: Array.from({ length: 201 }, (_, i) => ({ i })) }, chart: { type: "bar", x: "i" } });
    assert.equal(r.status, 413);
    assert.equal(json(r).error.code, "too_many_rows");
  });
  await test("too many marks is a 413", async () => {
    // 200 rows x 1 layer = 200 items > 150
    const r = await request("POST", "/v1/chart", { data: { values: Array.from({ length: 200 }, (_, i) => ({ i, v: i % 7 })) }, chart: { type: "point", x: "i", y: "v" } });
    assert.equal(r.status, 413);
    assert.equal(json(r).error.code, "too_many_marks");
  });
  await test("oversized body is a 413", async () => {
    const r = await request("POST", "/v1/chart", { data: { csv: "a\n" + "x\n".repeat(40000) }, chart: { type: "bar", x: "a" } });
    assert.equal(r.status, 413);
    assert.equal(json(r).error.code, "body_too_large");
  });
  await test("wrong method is a 405 JSON error", async () => {
    const r = await request("GET", "/v1/chart");
    assert.equal(r.status, 405);
    json(r);
  });
  await test("unknown path is a 404 JSON error", async () => {
    const r = await request("GET", "/nope");
    assert.equal(r.status, 404);
    json(r);
  });
  await test("no error-looking words in the first 2 KB of a success body", async () => {
    const r = await request("POST", "/v1/chart", { data: { csv: CSV }, chart: { type: "bar", x: "month", y: "sales" } });
    const head = r.text.slice(0, 2048).toLowerCase();
    for (const w of ["timeout", "connection refused", "connection reset", "bad gateway", "service unavailable", "gateway timeout"]) {
      assert.ok(!head.includes(w), `found '${w}'`);
    }
  });
} finally {
  child.kill("SIGTERM");
}

const failed = results.filter(([, r]) => r !== "ok");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
