// Render worker: one Vega runtime per thread. The server posts {id, body, limits};
// the worker answers {id, ok, result} or {id, ok:false, error}. Running renders off
// the main thread keeps the probe endpoints responsive and lets the server kill a
// render that blows its budget (a terminated worker is replaced by a fresh one).

import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as vega from "vega";
import * as vl from "vega-lite";
import * as themes from "vega-themes";
import Ajv from "ajv";
import {
  RequestError, normalizeRequest, applyOptions, countDataItems, injectTitles, svgSize, wrapHtml,
  summarizeSchemaErrors, SHORTHAND_TYPES, FORMATS,
} from "./chart.js";

const require = createRequire(import.meta.url);
const schema = JSON.parse(readFileSync(require.resolve("vega-lite/vega-lite-schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validateSpec = ajv.compile(schema);
const MARK_NAMES = [...schema.definitions.Mark.enum, "boxplot", "errorbar", "errorband"];
const THEME_NAMES = Object.keys(themes).filter((k) => k !== "version" && typeof themes[k] === "object");

// Nothing may be loaded from the network or the filesystem during a render.
const blockedLoader = {
  load: async (uri) => { throw new Error(`remote resources are not allowed (${uri})`); },
  sanitize: async (uri) => { throw new Error(`remote resources are not allowed (${uri})`); },
  http: async (uri) => { throw new Error(`remote resources are not allowed (${uri})`); },
  file: async (uri) => { throw new Error(`remote resources are not allowed (${uri})`); },
};

function makeLogger(sink) {
  const push = (level) => (...args) => { sink.push({ level, message: args.map(String).join(" ") }); return logger; };
  const logger = { level: () => logger, error: push("error"), warn: push("warn"), info: () => logger, debug: () => logger };
  return logger;
}

async function render(body, limits) {
  const started = Date.now();
  const { spec, options, rows, tooltips } = normalizeRequest(body, limits);

  let themeConfig = null;
  if (options.theme !== undefined) {
    if (!THEME_NAMES.includes(options.theme)) {
      throw new RequestError(400, "invalid_request", `options.theme must be one of: ${THEME_NAMES.join(", ")}`);
    }
    themeConfig = themes[options.theme];
  }
  applyOptions(spec, options, themeConfig);

  if (typeof spec.mark === "string" && !MARK_NAMES.includes(spec.mark)) {
    throw new RequestError(400, "invalid_spec", `unknown mark '${spec.mark}'; valid marks are ${MARK_NAMES.join(", ")}`);
  }
  if (!validateSpec(spec)) {
    throw new RequestError(400, "invalid_spec", "the spec does not match the Vega-Lite schema", summarizeSchemaErrors(validateSpec.errors, MARK_NAMES));
  }

  const log = [];
  const logger = makeLogger(log);
  let vgSpec;
  try {
    vgSpec = vl.compile(spec, { logger }).spec;
  } catch (e) {
    throw new RequestError(400, "invalid_spec", `Vega-Lite could not compile the spec: ${e.message}`);
  }

  vega.setRandom(vega.randomLCG(options.seed));
  let view;
  try {
    view = new vega.View(vega.parse(vgSpec), { renderer: "none", logger, loader: blockedLoader });
    await view.runAsync();
  } catch (e) {
    throw new RequestError(422, "render_failed", `Vega could not render the spec: ${e.message}`);
  }
  const errors = log.filter((l) => l.level === "error");
  if (errors.length) {
    throw new RequestError(422, "render_failed", "Vega reported an error while rendering", errors.map((l) => l.message));
  }

  const marks = countDataItems(view.scenegraph().root);
  if (marks > limits.maxMarks) {
    throw new RequestError(413, "too_many_marks", `the chart would draw ${marks} data marks; the limit is ${limits.maxMarks}. Aggregate, bin, or filter before sending`, { max_marks: limits.maxMarks, marks });
  }

  let svg = await view.toSVG();
  view.finalize();
  if (svg.length > limits.maxSvgBytes) {
    throw new RequestError(413, "output_too_large", `the rendered SVG is ${svg.length} bytes; the limit is ${limits.maxSvgBytes}`, { max_svg_bytes: limits.maxSvgBytes, svg_bytes: svg.length });
  }
  if (tooltips) svg = injectTitles(svg);
  const { width, height } = svgSize(svg);
  const html = options.format === "html" ? wrapHtml(svg, typeof spec.title === "string" ? spec.title : (spec.title && spec.title.text)) : svg;

  return {
    format: options.format,
    content_type: options.format === "html" ? "text/html" : "image/svg+xml",
    width,
    height,
    rows,
    marks,
    tooltips,
    render_ms: Date.now() - started,
    warnings: log.filter((l) => l.level === "warn").map((l) => l.message).slice(0, 20),
    html,
  };
}

parentPort.on("message", async (msg) => {
  try {
    const result = await render(msg.body, msg.limits);
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    const error = e instanceof RequestError
      ? { status: e.status, code: e.code, message: e.message, details: e.details }
      : { status: 500, code: "render_failed", message: `unexpected render failure: ${e && e.message ? e.message : String(e)}` };
    parentPort.postMessage({ id: msg.id, ok: false, error });
  }
});

parentPort.postMessage({
  ready: true,
  engine: {
    vega: vega.version,
    vega_lite: vl.version,
    vega_themes: themes.version,
    node: process.version,
    marks: MARK_NAMES,
    shorthand_types: Object.keys(SHORTHAND_TYPES),
    themes: THEME_NAMES,
    formats: FORMATS,
  },
});
