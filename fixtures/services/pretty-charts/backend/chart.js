// Pure request logic for Pretty Charts: request normalization, the chart shorthand
// that compiles to Vega-Lite, the inline-data audit (no remote resources, row caps),
// the native-tooltip pass over the rendered SVG, and the HTML wrapper.
//
// Nothing here touches the network or the filesystem. The render worker imports it.

import * as vega from "vega";

export class RequestError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// Shorthand chart types and the Vega-Lite mark each compiles to.
export const SHORTHAND_TYPES = Object.freeze({
  bar: "bar",
  line: "line",
  area: "area",
  point: "point",
  scatter: "point",
  circle: "circle",
  square: "square",
  tick: "tick",
  rect: "rect",
  heatmap: "rect",
  arc: "arc",
  pie: "arc",
  donut: "arc",
  boxplot: "boxplot",
  errorbar: "errorbar",
  errorband: "errorband",
  rule: "rule",
  text: "text",
  trail: "trail",
});

// Encoding channels the shorthand accepts, in the order they are copied.
const CHANNELS = [
  "x", "y", "x2", "y2", "xOffset", "yOffset", "theta", "theta2", "radius", "radius2",
  "color", "fill", "stroke", "opacity", "fillOpacity", "strokeOpacity", "strokeWidth", "strokeDash",
  "size", "shape", "angle", "text", "detail", "order", "key", "row", "column", "facet",
];

export const FORMATS = Object.freeze(["svg", "html"]);

// ---------------------------------------------------------------------------
// Data

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Parses body.data into an array of row objects, or returns null when absent.
export function parseData(data) {
  if (data === undefined || data === null) return null;
  if (!isPlainObject(data)) {
    throw new RequestError(400, "invalid_request", "'data' must be an object with one of: csv, tsv, json, values");
  }
  const keys = ["csv", "tsv", "json", "values"].filter((k) => data[k] !== undefined);
  if (keys.length !== 1) {
    throw new RequestError(400, "invalid_request", "'data' must contain exactly one of: csv, tsv, json, values", { given: keys });
  }
  const key = keys[0];
  let rows;
  try {
    if (key === "values") {
      rows = data.values;
    } else if (key === "json") {
      rows = typeof data.json === "string" ? JSON.parse(data.json) : data.json;
    } else {
      const text = data[key];
      if (typeof text !== "string" || text.trim() === "") {
        throw new RequestError(400, "invalid_request", `'data.${key}' must be a non-empty string`);
      }
      rows = vega.read(text, { type: key, parse: data.parse === undefined ? "auto" : data.parse });
    }
  } catch (e) {
    if (e instanceof RequestError) throw e;
    throw new RequestError(400, "invalid_data", `could not parse data.${key}: ${e.message}`);
  }
  if (!Array.isArray(rows)) {
    throw new RequestError(400, "invalid_data", `data.${key} must produce an array of row objects`);
  }
  for (let i = 0; i < rows.length; i++) {
    if (!isPlainObject(rows[i])) {
      throw new RequestError(400, "invalid_data", `row ${i} is not an object`);
    }
  }
  return rows;
}

export function columnsOf(rows) {
  const seen = new Set();
  const limit = Math.min(rows.length, 50);
  for (let i = 0; i < limit; i++) for (const k of Object.keys(rows[i])) seen.add(k);
  return [...seen];
}

// Infers a Vega-Lite field type from sample values.
export function inferType(rows, field) {
  let seen = 0, numeric = 0, temporal = 0;
  const limit = Math.min(rows.length, 500);
  for (let i = 0; i < limit; i++) {
    const v = rows[i][field];
    if (v === null || v === undefined || v === "") continue;
    seen++;
    if (typeof v === "number" || typeof v === "boolean") numeric++;
    else if (v instanceof Date) temporal++;
    else if (typeof v === "string") {
      if (v.trim() !== "" && !Number.isNaN(Number(v))) numeric++;
      else if (/^\d{4}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))) temporal++;
    }
  }
  if (seen === 0) return "nominal";
  if (numeric === seen) return "quantitative";
  if (temporal === seen) return "temporal";
  return "nominal";
}

// ---------------------------------------------------------------------------
// Shorthand -> Vega-Lite

function channelDef(name, raw, rows, columns) {
  if (raw === undefined || raw === null) return undefined;
  let def = raw;
  if (typeof def === "string") def = { field: def };
  if (!isPlainObject(def)) {
    throw new RequestError(400, "invalid_request", `chart.${name} must be a column name or an object`);
  }
  def = { ...def };
  const scale = isPlainObject(def.scale) ? { ...def.scale } : {};
  for (const k of ["domain", "range", "scheme", "zero", "nice", "padding", "reverse", "clamp"]) {
    if (def[k] !== undefined) { scale[k] = def[k]; delete def[k]; }
  }
  if (Object.keys(scale).length) def.scale = scale;
  if (def.value !== undefined || def.datum !== undefined) return def;
  if (def.aggregate === "count" && def.field === undefined) {
    if (!def.type) def.type = "quantitative";
    return def;
  }
  if (typeof def.field !== "string" || def.field === "") {
    throw new RequestError(400, "invalid_request", `chart.${name} needs a 'field' (a column name)`);
  }
  if (columns && !columns.includes(def.field)) {
    throw new RequestError(400, "unknown_field", `chart.${name} refers to column '${def.field}', which is not in the data`, { columns });
  }
  if (!def.type) {
    if (def.bin || def.aggregate) def.type = "quantitative";
    else if (def.timeUnit) def.type = "temporal";
    else def.type = inferType(rows, def.field);
  }
  return def;
}

function tooltipExpression(fields) {
  return fields.map((f) => `'${String(f).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}: ' + datum[${JSON.stringify(f)}]`).join(" + '; ' + ");
}

// Compiles the shorthand form into a Vega-Lite unit spec. Returns { spec, tooltips }.
export function shorthandToSpec(chart, rows) {
  if (!isPlainObject(chart)) throw new RequestError(400, "invalid_request", "'chart' must be an object");
  if (!rows) throw new RequestError(400, "invalid_request", "'chart' needs 'data' (csv, tsv, json, or values)");
  const kind = typeof chart.type === "string" ? chart.type.toLowerCase() : undefined;
  const markType = kind ? SHORTHAND_TYPES[kind] : undefined;
  if (!markType) {
    throw new RequestError(400, "invalid_request", `chart.type must be one of: ${Object.keys(SHORTHAND_TYPES).join(", ")}`, { given: chart.type });
  }
  const columns = columnsOf(rows);
  const mark = { type: markType, ...(isPlainObject(chart.mark) ? chart.mark : {}) };
  if (kind === "donut" && mark.innerRadius === undefined) mark.innerRadius = chart.innerRadius === undefined ? 60 : chart.innerRadius;
  if (chart.point !== undefined) mark.point = chart.point;
  if (chart.interpolate !== undefined) mark.interpolate = chart.interpolate;
  if (typeof chart.opacity === "number") mark.opacity = chart.opacity;
  if (typeof chart.cornerRadius === "number") mark.cornerRadius = chart.cornerRadius;

  const encoding = {};
  const source = { ...chart };
  // Pie and donut sugar: x -> color (slice), y -> theta (size).
  if ((kind === "pie" || kind === "donut" || kind === "arc") && source.theta === undefined && source.y !== undefined) {
    source.theta = source.y; delete source.y;
    if (source.color === undefined && source.x !== undefined) { source.color = source.x; delete source.x; }
  }
  for (const ch of CHANNELS) {
    const def = channelDef(ch, source[ch], rows, columns);
    if (def !== undefined) encoding[ch] = def;
  }
  // Categories on a positional axis keep the data's order unless the caller sorts;
  // Vega-Lite's alphabetical default is rarely what a CSV author means.
  for (const ch of ["x", "y"]) {
    const def = encoding[ch];
    if (def && def.field && def.type === "nominal" && def.sort === undefined && !def.aggregate && !def.bin && !def.timeUnit) def.sort = null;
  }
  if (kind === "heatmap" && encoding.color === undefined) encoding.color = { aggregate: "count", type: "quantitative" };
  if (Array.isArray(chart.xRange)) encoding.x = { ...(encoding.x || {}), scale: { ...((encoding.x || {}).scale || {}), domain: chart.xRange } };
  if (Array.isArray(chart.yRange)) encoding.y = { ...(encoding.y || {}), scale: { ...((encoding.y || {}).scale || {}), domain: chart.yRange } };
  if (Array.isArray(chart.colors) && chart.colors.length) {
    if (encoding.color) encoding.color.scale = { ...(encoding.color.scale || {}), range: chart.colors };
    else if (encoding.fill) encoding.fill.scale = { ...(encoding.fill.scale || {}), range: chart.colors };
    else mark.color = chart.colors[0];
  }
  if (typeof chart.colorScheme === "string" && encoding.color) encoding.color.scale = { ...(encoding.color.scale || {}), scheme: chart.colorScheme };
  if (chart.stack !== undefined && encoding.y) encoding.y.stack = chart.stack;
  if (Object.keys(encoding).length === 0) {
    throw new RequestError(400, "invalid_request", "chart needs at least one channel (x, y, color, theta, ...)", { columns });
  }

  const spec = { $schema: "https://vega.github.io/schema/vega-lite/v6.json", data: { values: rows }, mark, encoding };
  if (chart.title !== undefined) spec.title = chart.title;
  if (chart.description !== undefined) spec.description = String(chart.description);
  if (Array.isArray(chart.transform)) spec.transform = chart.transform;
  spec.width = typeof chart.width === "number" ? chart.width : 600;
  spec.height = typeof chart.height === "number" ? chart.height : 360;

  let tooltips = true;
  if (chart.tooltip === false) tooltips = false;
  else if (Array.isArray(chart.tooltip) && chart.tooltip.length) {
    for (const f of chart.tooltip) {
      if (typeof f !== "string" || !columns.includes(f)) {
        throw new RequestError(400, "unknown_field", `chart.tooltip refers to column '${f}', which is not in the data`, { columns });
      }
    }
    spec.transform = [...(spec.transform || []), { calculate: tooltipExpression(chart.tooltip), as: "__tooltip" }];
    encoding.description = { field: "__tooltip", type: "nominal" };
  }
  return { spec, tooltips };
}

// ---------------------------------------------------------------------------
// Spec audit: no remote resources, count inline rows.

export function auditSpec(spec, maxRows) {
  let rows = 0;
  const stack = [[spec, "$"]];
  while (stack.length) {
    const [node, path] = stack.pop();
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) if (node[i] && typeof node[i] === "object") stack.push([node[i], `${path}[${i}]`]);
      continue;
    }
    if (!isPlainObject(node)) continue;
    for (const [k, v] of Object.entries(node)) {
      if (k === "url") {
        throw new RequestError(400, "remote_data_not_allowed", `'${path}.url' is not allowed: data and images must be inline (data.values, data.csv, ...)`);
      }
      if (k === "values") {
        if (Array.isArray(v)) rows += v.length;
        else if (typeof v === "string") rows += v.split("\n").length;
        if (rows > maxRows) {
          throw new RequestError(413, "too_many_rows", `inline data has more than ${maxRows} rows; aggregate or bin before sending`, { max_rows: maxRows });
        }
        continue; // row objects are data, not spec
      }
      if (v && typeof v === "object") stack.push([v, `${path}.${k}`]);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Options

export function normalizeOptions(raw) {
  const o = raw === undefined ? {} : raw;
  if (!isPlainObject(o)) throw new RequestError(400, "invalid_request", "'options' must be an object");
  const out = { format: "svg", tooltips: true, seed: 1 };
  if (o.format !== undefined) {
    if (!FORMATS.includes(o.format)) throw new RequestError(400, "invalid_request", `options.format must be one of: ${FORMATS.join(", ")}`);
    out.format = o.format;
  }
  if (o.tooltips !== undefined) {
    if (typeof o.tooltips !== "boolean") throw new RequestError(400, "invalid_request", "options.tooltips must be true or false");
    out.tooltips = o.tooltips;
  }
  for (const k of ["width", "height", "padding", "seed"]) {
    if (o[k] !== undefined) {
      if (typeof o[k] !== "number" || !Number.isFinite(o[k])) throw new RequestError(400, "invalid_request", `options.${k} must be a number`);
      out[k] = o[k];
    }
  }
  for (const k of ["background", "theme", "title"]) {
    if (o[k] !== undefined) {
      if (typeof o[k] !== "string") throw new RequestError(400, "invalid_request", `options.${k} must be a string`);
      out[k] = o[k];
    }
  }
  if (o.config !== undefined) {
    if (!isPlainObject(o.config)) throw new RequestError(400, "invalid_request", "options.config must be a Vega-Lite config object");
    out.config = o.config;
  }
  return out;
}

function isCompositeSpec(spec) {
  return ["layer", "hconcat", "vconcat", "concat", "facet", "repeat", "spec"].some((k) => spec[k] !== undefined);
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function applyOptions(spec, options, themeConfig) {
  if (!isCompositeSpec(spec)) {
    if (options.width !== undefined) spec.width = options.width;
    if (options.height !== undefined) spec.height = options.height;
  }
  if (options.background !== undefined) spec.background = options.background;
  if (options.padding !== undefined) spec.padding = options.padding;
  if (options.title !== undefined && spec.title === undefined) spec.title = options.title;
  let cfg = themeConfig ? deepMerge({}, themeConfig) : null;
  if (options.config) cfg = deepMerge(cfg || {}, options.config);
  if (isPlainObject(spec.config)) cfg = deepMerge(cfg || {}, spec.config);
  if (cfg) spec.config = cfg;
  return spec;
}

// ---------------------------------------------------------------------------
// Request -> { spec, options, rows, tooltips }

export function normalizeRequest(body, limits) {
  if (!isPlainObject(body)) throw new RequestError(400, "invalid_request", "body must be a JSON object");
  const hasSpec = body.spec !== undefined, hasChart = body.chart !== undefined;
  if (hasSpec === hasChart) {
    throw new RequestError(400, "invalid_request", "send exactly one of 'spec' (a Vega-Lite spec) or 'chart' (the shorthand form)");
  }
  const options = normalizeOptions(body.options);
  const rows = parseData(body.data);
  if (rows && rows.length > limits.maxRows) {
    throw new RequestError(413, "too_many_rows", `data has ${rows.length} rows; the limit is ${limits.maxRows}. Aggregate or bin before sending`, { max_rows: limits.maxRows });
  }
  let spec, tooltips = options.tooltips;
  if (hasChart) {
    const r = shorthandToSpec(body.chart, rows);
    spec = r.spec;
    if (!r.tooltips) tooltips = false;
  } else {
    if (!isPlainObject(body.spec)) throw new RequestError(400, "invalid_request", "'spec' must be a Vega-Lite spec object");
    spec = JSON.parse(JSON.stringify(body.spec));
    if (rows) {
      if (spec.data !== undefined) throw new RequestError(400, "invalid_request", "data was given twice: drop 'spec.data' when sending 'data'");
      spec.data = { values: rows };
    } else if (spec.data === undefined && !isCompositeSpec(spec)) {
      throw new RequestError(400, "invalid_request", "no data: send 'data' (csv, tsv, json, values) or inline 'spec.data.values'");
    }
  }
  const rowCount = auditSpec(spec, limits.maxRows);
  return { spec, options, rows: rowCount, tooltips };
}

// ---------------------------------------------------------------------------
// Scenegraph and SVG post-processing

// Counts data-mark items (bars, points, line vertices, slices) in a rendered scenegraph.
export function countDataItems(root) {
  let total = 0;
  const walk = (mark) => {
    const items = mark.items || [];
    if (mark.role === "mark" && mark.marktype !== "group") { total += items.length; return; }
    for (const it of items) for (const child of it.items || []) walk(child);
  };
  walk(root);
  return total;
}

// Turns Vega's per-mark aria-label into a child <title>, which browsers show as a
// native hover tooltip. Only data marks (role="graphics-symbol" on a shape element)
// get one; axis and legend groups keep their aria-label for screen readers.
const SELF_CLOSING = /<(path|circle|rect|line|ellipse|polygon|polyline|image)\b([^>]*?\brole="graphics-symbol"[^>]*?\baria-label="([^"]*)"[^>]*?)\/>/g;
const SELF_CLOSING_REV = /<(path|circle|rect|line|ellipse|polygon|polyline|image)\b([^>]*?\baria-label="([^"]*)"[^>]*?\brole="graphics-symbol"[^>]*?)\/>/g;
const TEXT_OPEN = /<text\b([^>]*?\brole="graphics-symbol"[^>]*?\baria-label="([^"]*)"[^>]*)>/g;
const TEXT_OPEN_REV = /<text\b([^>]*?\baria-label="([^"]*)"[^>]*?\brole="graphics-symbol"[^>]*)>/g;

export function injectTitles(svg) {
  return svg
    .replace(SELF_CLOSING, (m, tag, attrs, label) => `<${tag}${attrs}><title>${label}</title></${tag}>`)
    .replace(SELF_CLOSING_REV, (m, tag, attrs, label) => `<${tag}${attrs}><title>${label}</title></${tag}>`)
    .replace(TEXT_OPEN, (m, attrs, label) => `<text${attrs}><title>${label}</title>`)
    .replace(TEXT_OPEN_REV, (m, attrs, label) => `<text${attrs}><title>${label}</title>`);
}

export function svgSize(svg) {
  const head = svg.slice(0, 600);
  const w = /\bwidth="([\d.]+)"/.exec(head), h = /\bheight="([\d.]+)"/.exec(head);
  return { width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function wrapHtml(svg, title) {
  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title || "Chart")}</title><style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:transparent}svg{max-width:100%;height:auto}</style></head><body>${svg}</body></html>`;
}

// Compact, deduplicated view of ajv's error list for a Vega-Lite spec.
export function summarizeSchemaErrors(errors, markNames) {
  const seen = new Set();
  const out = [];
  const sorted = [...errors].sort((a, b) => b.instancePath.length - a.instancePath.length);
  for (const e of sorted) {
    let msg = e.message;
    if (e.keyword === "enum" && e.params && e.params.allowedValues) msg += ` [${e.params.allowedValues.join(", ")}]`;
    if (e.keyword === "additionalProperties" && e.params) msg += ` ('${e.params.additionalProperty}')`;
    if (e.keyword === "const" || e.keyword === "anyOf" || e.keyword === "oneOf") continue;
    const key = `${e.instancePath}|${msg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${e.instancePath || "$"}: ${msg}`);
    if (out.length >= 6) break;
  }
  if (out.length === 0 && markNames) out.push(`the spec does not match the Vega-Lite schema; valid mark types are ${markNames.join(", ")}`);
  return out;
}
