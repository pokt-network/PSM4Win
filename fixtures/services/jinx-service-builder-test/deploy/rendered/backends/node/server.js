// Minimal jinx-service-builder-test backend skeleton for Pocket Network.
// Implements only what Pocket requires: the three probe endpoints, JSON-object
// responses, JSON 4xx for bad input, and one example resource that wraps non-JSON
// output (HTML) in a string field. Replace render() with your service.
//
// No dependencies, Node's http module only. Run: node server.js (listens on :8080)
// The rules enforced here are explained in the skill's references/design-rules.md.
const http = require("http");

const SERVICE = "jinx-service-builder-test";
const VERSION = "1.0.0";

function render(body) {
  // REPLACE with your service. Return a JSON-serializable object.
  // Non-JSON output (HTML here) is carried as a string field so the body starts with '{'.
  const csv = body.csv;
  if (typeof csv !== "string" || csv.trim() === "") {
    const err = new Error("field 'csv' is required and must be a non-empty string");
    err.status = 422;
    throw err;
  }
  const html = `<!DOCTYPE html><html><body><pre>${csv}</pre></body></html>`;
  return { content_type: "text/html", body: html };
}

function sendJson(res, status, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": payload.length });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/version") {
    return sendJson(res, 200, { service: SERVICE, version: VERSION });
  }
  if (req.method === "GET" && req.url === "/healthz") {
    return sendJson(res, 200, { status: "ok" });
  }
  if (req.method === "POST" && req.url === "/v1/REPLACE-resource") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch {
        return sendJson(res, 400, { error: { code: "invalid_json", message: "body must be JSON" } });
      }
      try {
        return sendJson(res, 200, render(body));
      } catch (e) {
        return sendJson(res, e.status || 422, { error: { code: "invalid_input", message: e.message } });
      }
    });
    return;
  }
  return sendJson(res, 404, { error: { code: "not_found", message: "unknown path" } });
});

server.listen(8080, "0.0.0.0");
