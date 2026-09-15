// Runtime configuration for the Pretty Charts backend. Every cap is an environment
// variable with a default; nothing is hardcoded in the request path. The defaults
// were chosen against the relay pipeline's own limits (RelayMiner 20 MB per body,
// SAGE 75 MiB requests, application clients 16 MiB, SAGE relay budget ~10 s):
// the binding constraints for a chart renderer are render time and output size,
// not input bytes.

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = Object.freeze({
  service: "pretty-charts",
  version: "1.0.0",
  port: intEnv("PORT", 8080),
  // Largest accepted request body, in bytes (CSV or JSON rows plus the spec).
  maxBodyBytes: intEnv("PC_MAX_BODY_BYTES", 1024 * 1024),
  // Largest number of data rows across every inline dataset in one request.
  maxRows: intEnv("PC_MAX_ROWS", 50000),
  // Largest number of data-mark items the scenegraph may contain before SVG generation.
  maxMarks: intEnv("PC_MAX_MARKS", 10000),
  // Largest SVG the service will return, in bytes.
  maxSvgBytes: intEnv("PC_MAX_SVG_BYTES", 2 * 1024 * 1024),
  // Wall-clock budget for one render inside a worker, in milliseconds. Kept well
  // under the gateway's relay budget so an over-budget request still gets a JSON
  // error instead of a gateway-side failure.
  renderBudgetMs: intEnv("PC_RENDER_BUDGET_MS", 5000),
  // Render workers (each is a separate thread with its own Vega runtime).
  workers: intEnv("PC_WORKERS", 2),
  // Requests waiting for a worker before new ones are refused.
  maxQueue: intEnv("PC_MAX_QUEUE", 32),
});
