import { losslessJson } from "./message-evidence.js";
import { evidenceObject } from "./trace-evidence.js";

// SPIKE: declared views. A view mod can describe a view as data instead of
// shipping code: field paths say where things sit in the recorded case, and
// Rubrist draws the result with its own components. A description is a list
// of blocks: a graph, a set of labelled fields, or a list of repeated items.
// Nothing here executes anything a mod supplies.

type Segment = { key: string } | { any: true; capture?: string };
export interface ViewPath { text: string; segments: Segment[] }
// A value read from one matched item: a path inside it, or a name captured by
// a `{name}` wildcard on the way to it.
export type ViewField = { capture: string } | { path: ViewPath };

const SEGMENT = /^(?:\*|\{([a-z][A-Za-z0-9]{0,30})\}|[^.*{}]{1,120})$/;
const CAPTURE = /^\{([a-z][A-Za-z0-9]{0,30})\}$/;
const INDEX = /^(?:0|[1-9]\d{0,8})$/;
export const GRAPH_NODE_LIMIT = 300;
export const GRAPH_EDGE_LIMIT = 1500;

// Dot-separated keys and array indexes. `*` matches every child; `{name}`
// does the same and remembers the child's key or index under that name.
export function parseViewPath(value: unknown): ViewPath | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 400) return null;
  const parts = value.split(".");
  if (parts.length > 16) return null;
  const segments: Segment[] = [];
  for (const part of parts) {
    const match = SEGMENT.exec(part);
    if (!match) return null;
    segments.push(part === "*" ? { any: true } : match[1] ? { any: true, capture: match[1] } : { key: part });
  }
  return { text: value, segments };
}

function captureNames(path: ViewPath): string[] {
  return path.segments.flatMap(segment => "any" in segment && segment.capture ? [segment.capture] : []);
}

function parseField(value: unknown, captures: readonly string[]): ViewField | null {
  if (typeof value !== "string") return null;
  const capture = CAPTURE.exec(value)?.[1];
  if (capture) return captures.includes(capture) ? { capture } : null;
  const path = parseViewPath(value);
  return path && path.segments.every(segment => "key" in segment) ? { path } : null;
}

function child(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return INDEX.test(key) ? value[Number(key)] : undefined;
  const record = evidenceObject(value);
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

export interface ViewMatch { value: unknown; captures: Record<string, string> }

// Source order is kept. null means the path matched more than `limit` values.
export function selectViewPath(root: unknown, path: ViewPath, limit: number): ViewMatch[] | null {
  let matches: ViewMatch[] = [{ value: root, captures: {} }];
  for (const segment of path.segments) {
    const next: ViewMatch[] = [];
    for (const match of matches) {
      if ("key" in segment) {
        const value = child(match.value, segment.key);
        if (value !== undefined) next.push({ value, captures: match.captures });
        continue;
      }
      const entries: [string, unknown][] = Array.isArray(match.value)
        ? match.value.map((item, index) => [String(index), item]) : Object.entries(evidenceObject(match.value) ?? {});
      for (const [key, value] of entries) {
        next.push({ value, captures: segment.capture ? { ...match.captures, [segment.capture]: key } : match.captures });
        if (next.length > limit) return null;
      }
    }
    matches = next;
  }
  return matches;
}

function read(match: ViewMatch, field: ViewField | null): unknown {
  if (field === null) return undefined;
  if ("capture" in field) return match.captures[field.capture];
  return selectViewPath(match.value, field.path, 1)?.[0]?.value;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
}

export interface GraphViewSpec {
  kind: "graph";
  title: ViewField | null;
  nodes: { each: ViewPath; id: ViewField; label: ViewField | null; caption: ViewField | null; x: ViewField; y: ViewField };
  edges: { each: ViewPath; source: ViewField; target: ViewField; port: ViewField | null } | null;
  // Recorded steps are always read from the case's own `steps`, in order.
  steps: { node: ViewField; status: ViewField | null; errorStatuses: string[]; durationMs: ViewField | null; error: ViewField | null } | null;
}

export type ValueStyle = "text" | "code" | "badge";
// One labelled value. `decode: "json"` reads a string that itself holds JSON,
// and `then` picks a value inside it; both are declared, never guessed.
export interface ValueFieldSpec { label: string; value: ViewField; as: ValueStyle; decodeJson: boolean; then: ViewPath | null }
// Values that point at items of a list block, matched against that list's key.
export interface LinkFieldSpec { label: string; each: ViewPath; linkTo: string }
export type FieldSpec = ValueFieldSpec | LinkFieldSpec;
export interface FieldsViewSpec { kind: "fields"; title: string | null; fields: FieldSpec[] }
export interface ListViewSpec {
  kind: "list"; id: string; title: string; each: ViewPath;
  key: ViewField | null; heading: ViewField | null; badges: ValueFieldSpec[]; fields: FieldSpec[];
}
export type EmbedScalar = string | number | boolean;
// A page on another origin that draws something Rubrist cannot, for example a
// product's own canvas. The description says where the page is, how it says it
// is ready, and exactly which recorded values it is sent: `send` is a JSON
// template in which `{ "$value": "<path>" }` stands for the value at that path.
// Those values leave Rubrist for that page, so every one is named to the reader.
export interface EmbedViewSpec {
  kind: "embed"; title: string; caption: string | null;
  src: string; origin: string; height: number;
  ready: Record<string, EmbedScalar> | null;
  send: unknown; sendAs: "object" | "json-text"; paths: ViewPath[];
}
export type ViewSpec = GraphViewSpec | FieldsViewSpec | ListViewSpec | EmbedViewSpec;

export const VIEW_BLOCK_LIMIT = 8;
export const VIEW_FIELD_LIMIT = 40;
export const LIST_ITEM_LIMIT = 300;
const LIST_ID = /^[a-z][a-z0-9-]{0,30}$/;
const STYLES: readonly string[] = ["text", "code", "badge"];

function onlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every(key => keys.includes(key));
}

function label(value: unknown, max = 60): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max ? value.trim() : null;
}

// null when the key is absent, undefined when it is present but not valid.
function optional(source: Record<string, unknown>, key: string, captures: readonly string[]) {
  return source[key] === undefined ? null : parseField(source[key], captures) ?? undefined;
}

function parseFieldSpec(value: unknown, captures: readonly string[]): FieldSpec | null {
  const record = evidenceObject(value);
  const name = label(record?.label);
  if (!record || !name) return null;
  if (record.each !== undefined) {
    const each = parseViewPath(record.each);
    if (!each || typeof record.linkTo !== "string" || !LIST_ID.test(record.linkTo) || !onlyKeys(record, ["label", "each", "linkTo"])) return null;
    return { label: name, each, linkTo: record.linkTo };
  }
  const field = parseField(record.value, captures);
  const style = record.as ?? "text";
  if (!field || typeof style !== "string" || !STYLES.includes(style) || !onlyKeys(record, ["label", "value", "as", "decode", "then"])) return null;
  if (record.decode !== undefined && record.decode !== "json") return null;
  const then = record.then === undefined ? null : parseViewPath(record.then);
  if (record.then !== undefined && (!then || record.decode !== "json" || !then.segments.every(segment => "key" in segment))) return null;
  return { label: name, value: field, as: style as ValueStyle, decodeJson: record.decode === "json", then };
}

function parseFieldSpecs(value: unknown, captures: readonly string[], required: boolean): FieldSpec[] | null {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > VIEW_FIELD_LIMIT || (required && value.length === 0)) return null;
  const fields = value.map(item => parseFieldSpec(item, captures));
  return fields.every((field): field is FieldSpec => field !== null) ? fields : null;
}

function parseFieldsSpec(record: Record<string, unknown>): FieldsViewSpec | null {
  if (!onlyKeys(record, ["kind", "title", "fields"])) return null;
  const title = record.title === undefined ? null : label(record.title, 80);
  const fields = parseFieldSpecs(record.fields, [], true);
  return fields && (record.title === undefined || title) ? { kind: "fields", title, fields } : null;
}

function parseListSpec(record: Record<string, unknown>): ListViewSpec | null {
  if (!onlyKeys(record, ["kind", "id", "title", "each", "key", "heading", "badges", "fields"])) return null;
  const each = parseViewPath(record.each), title = label(record.title, 80);
  if (!each || !title || typeof record.id !== "string" || !LIST_ID.test(record.id)) return null;
  const captures = captureNames(each);
  const key = optional(record, "key", captures), heading = optional(record, "heading", captures);
  const badges = parseFieldSpecs(record.badges, captures, false), fields = parseFieldSpecs(record.fields, captures, false);
  if (key === undefined || heading === undefined || !badges || !fields || !badges.every((badge): badge is ValueFieldSpec => "value" in badge)) return null;
  return { kind: "list", id: record.id, title, each, key, heading, badges, fields };
}

// Strict on purpose: an unknown key or a misspelt path rejects the whole
// description, so a view never silently draws less than its author meant.
export function parseViewSpecs(value: unknown): ViewSpec[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > VIEW_BLOCK_LIMIT) return null;
  const blocks: ViewSpec[] = [];
  for (const item of value) {
    const record = evidenceObject(item);
    const block = !record ? null : record.kind === "graph" ? parseGraphSpec(record)
      : record.kind === "fields" ? parseFieldsSpec(record) : record.kind === "list" ? parseListSpec(record)
      : record.kind === "embed" ? parseEmbedSpec(record) : null;
    if (!block) return null;
    blocks.push(block);
  }
  const lists = blocks.flatMap(block => block.kind === "list" ? [block.id] : []);
  if (new Set(lists).size !== lists.length) return null;
  const links = blocks.flatMap(block => block.kind === "fields" || block.kind === "list" ? block.fields.flatMap(field => "linkTo" in field ? [field.linkTo] : []) : []);
  return links.every(target => lists.includes(target)) ? blocks : null;
}

// `{theme}` in the address becomes "light" or "dark". The page must be https
// (or http on localhost) and carry no credentials or fragment.
export function embedAddress(src: string, theme: "light" | "dark"): URL | null {
  let url: URL;
  try { url = new URL(src.replaceAll("{theme}", theme)); } catch { return null; }
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  return (url.protocol === "https:" || local) && !url.username && !url.password && !url.hash ? url : null;
}

function templatePaths(value: unknown, found: ViewPath[], depth = 0): boolean {
  if (depth > 8) return false;
  if (Array.isArray(value)) return value.length <= 100 && value.every(item => templatePaths(item, found, depth + 1));
  const record = evidenceObject(value);
  if (!record) return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  if (!Object.hasOwn(record, "$value")) return Object.keys(record).length <= 100 && Object.values(record).every(item => templatePaths(item, found, depth + 1));
  const path = parseViewPath(record.$value);
  if (!path || Object.keys(record).length !== 1 || !path.segments.every(segment => "key" in segment)) return false;
  found.push(path);
  return true;
}

function parseEmbedSpec(record: Record<string, unknown>): EmbedViewSpec | null {
  if (!onlyKeys(record, ["kind", "title", "caption", "src", "height", "ready", "send", "sendAs"])) return null;
  const title = label(record.title, 80), caption = record.caption === undefined ? null : label(record.caption, 400);
  const address = typeof record.src === "string" && record.src.length <= 500 ? embedAddress(record.src, "light") : null;
  const sendAs = record.sendAs ?? "object", paths: ViewPath[] = [];
  if (!title || (record.caption !== undefined && !caption) || !address || (sendAs !== "object" && sendAs !== "json-text")) return null;
  if (record.send === undefined || !templatePaths(record.send, paths) || paths.length === 0 || paths.length > 8) return null;
  let ready: EmbedViewSpec["ready"] = null;
  if (record.ready !== undefined) {
    const entries = Object.entries(evidenceObject(record.ready) ?? {});
    if (entries.length === 0 || entries.length > 8 || !entries.every(([, value]) => ["string", "number", "boolean"].includes(typeof value))) return null;
    ready = Object.fromEntries(entries) as Record<string, EmbedScalar>;
  }
  const height = typeof record.height === "number" && Number.isFinite(record.height) ? Math.min(900, Math.max(120, Math.round(record.height))) : 420;
  return { kind: "embed", title, caption, src: record.src as string, origin: address.origin, height, ready, send: record.send, sendAs, paths };
}

// The page says it is ready with a message, as an object or as JSON text,
// whose top-level values equal the ones the description lists.
export function embedReadyMatches(ready: Record<string, EmbedScalar>, data: unknown): boolean {
  let value = data;
  if (typeof value === "string") {
    if (value.length > 10_000) return false;
    try { value = JSON.parse(value); } catch { return false; }
  }
  const record = evidenceObject(value);
  return record !== null && Object.entries(ready).every(([key, expected]) => Object.hasOwn(record, key) && record[key] === expected);
}

// null when a value the template names is not recorded in this case.
function fillTemplate(value: unknown, evidence: ViewEvidence, missing: string[]): unknown {
  if (Array.isArray(value)) return value.map(item => fillTemplate(item, evidence, missing));
  const record = evidenceObject(value);
  if (!record) return value;
  if (Object.hasOwn(record, "$value")) {
    const path = parseViewPath(record.$value)!;
    const found = selectViewPath(evidence, path, 1)?.[0]?.value;
    if (found === undefined) missing.push(path.text);
    return found ?? null;
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, fillTemplate(item, evidence, missing)]));
}

function parseGraphSpec(record: Record<string, unknown>): GraphViewSpec | null {
  if (!onlyKeys(record, ["kind", "title", "nodes", "edges", "steps"])) return null;

  const title = optional(record, "title", []);
  const nodes = evidenceObject(record.nodes);
  const nodesEach = parseViewPath(nodes?.each);
  if (title === undefined || !nodes || !nodesEach || !onlyKeys(nodes, ["each", "id", "label", "caption", "x", "y"])) return null;
  const nodeCaptures = captureNames(nodesEach);
  const id = parseField(nodes.id, nodeCaptures), x = parseField(nodes.x, nodeCaptures), y = parseField(nodes.y, nodeCaptures);
  const label = optional(nodes, "label", nodeCaptures), caption = optional(nodes, "caption", nodeCaptures);
  if (!id || !x || !y || label === undefined || caption === undefined) return null;

  let edges: GraphViewSpec["edges"] = null;
  if (record.edges !== undefined) {
    const source = evidenceObject(record.edges);
    const each = parseViewPath(source?.each);
    if (!source || !each || !onlyKeys(source, ["each", "source", "target", "port"])) return null;
    const captures = captureNames(each);
    const from = parseField(source.source, captures), to = parseField(source.target, captures), port = optional(source, "port", captures);
    if (!from || !to || port === undefined) return null;
    edges = { each, source: from, target: to, port };
  }

  let steps: GraphViewSpec["steps"] = null;
  if (record.steps !== undefined) {
    const source = evidenceObject(record.steps);
    if (!source || !onlyKeys(source, ["node", "status", "errorStatuses", "durationMs", "error"])) return null;
    const node = parseField(source.node, []), status = optional(source, "status", []);
    const durationMs = optional(source, "durationMs", []), error = optional(source, "error", []);
    const errorStatuses = source.errorStatuses ?? [];
    if (!node || status === undefined || durationMs === undefined || error === undefined) return null;
    if (!Array.isArray(errorStatuses) || errorStatuses.length > 20 || !errorStatuses.every(item => typeof item === "string")) return null;
    steps = { node, status, errorStatuses: errorStatuses as string[], durationMs, error };
  }
  return { kind: "graph", title, nodes: { each: nodesEach, id, label, caption, x, y }, edges, steps };
}

export interface GraphRun { index: number; step: Record<string, unknown>; status: string | null; isError: boolean; durationMs: number | null; error: unknown }
export interface GraphNode { id: string; label: string; caption: string | null; x: number; y: number; runs: GraphRun[] }
export interface GraphEdge { source: string; target: string; port: number; ports: number }
export interface DrawnGraph {
  title: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  // Recorded steps the view cannot place, and edges naming a node it has not got.
  orphans: { index: number; name: string | null }[];
  undrawnEdges: number;
}
export type GraphEvidence = DrawnGraph | { problem: string };

export interface ViewEvidence { input: unknown; output: unknown; steps: unknown; metadata: unknown }

// A display-only projection. When the case does not have the shape the view
// expects, it says so and draws nothing: it never guesses a graph.
export function graphEvidence(spec: GraphViewSpec, evidence: ViewEvidence): GraphEvidence {
  const found = selectViewPath(evidence, spec.nodes.each, GRAPH_NODE_LIMIT);
  if (found === null) return { problem: `This case has more than ${GRAPH_NODE_LIMIT} nodes at ${spec.nodes.each.text}, which is more than this view draws.` };
  if (found.length === 0) return { problem: `This case has no nodes at ${spec.nodes.each.text}, so there is no graph to draw.` };
  const nodes = new Map<string, GraphNode>();
  for (const [position, match] of found.entries()) {
    const id = text(read(match, spec.nodes.id)), x = numeric(read(match, spec.nodes.x)), y = numeric(read(match, spec.nodes.y));
    if (id === null || x === null || y === null) return { problem: `Node ${position + 1} at ${spec.nodes.each.text} has no usable ${id === null ? "id" : "position"}, so the graph is not drawn.` };
    if (nodes.has(id)) return { problem: `Two nodes at ${spec.nodes.each.text} share the id “${id}”, so the graph is not drawn.` };
    nodes.set(id, { id, label: text(read(match, spec.nodes.label)) ?? id, caption: text(read(match, spec.nodes.caption)), x, y, runs: [] });
  }

  const edges: GraphEdge[] = [];
  let undrawnEdges = 0;
  if (spec.edges) {
    const matches = selectViewPath(evidence, spec.edges.each, GRAPH_EDGE_LIMIT);
    if (matches === null) return { problem: `This case has more than ${GRAPH_EDGE_LIMIT} edges at ${spec.edges.each.text}, which is more than this view draws.` };
    for (const match of matches) {
      const source = text(read(match, spec.edges.source)), target = text(read(match, spec.edges.target));
      const port = numeric(read(match, spec.edges.port));
      if (source === null || target === null || !nodes.has(source) || !nodes.has(target)) { undrawnEdges++; continue; }
      edges.push({ source, target, port: port !== null && Number.isInteger(port) && port >= 0 ? port : 0, ports: 1 });
    }
    for (const edge of edges) edge.ports = Math.max(...edges.filter(other => other.source === edge.source).map(other => other.port)) + 1;
  }

  const orphans: DrawnGraph["orphans"] = [];
  if (spec.steps && Array.isArray(evidence.steps)) {
    for (const [index, value] of evidence.steps.entries()) {
      const step = evidenceObject(value) ?? {};
      const match = { value: step, captures: {} };
      const node = nodes.get(text(read(match, spec.steps.node)) ?? "");
      if (!node) { orphans.push({ index, name: text(step.name) }); continue; }
      const status = text(read(match, spec.steps.status));
      node.runs.push({
        index, step, status, isError: status !== null && spec.steps.errorStatuses.includes(status),
        durationMs: numeric(read(match, spec.steps.durationMs)), error: read(match, spec.steps.error)
      });
    }
  }
  const title = text(read({ value: evidence, captures: {} }, spec.title));
  return { title, nodes: [...nodes.values()], edges, orphans, undrawnEdges };
}

export type DisplayValue = { kind: "missing" } | { kind: ValueStyle; text: string; note: string | null };
// index is null when the value names no item, or more than one, in the list.
export interface DisplayLink { text: string; list: string; index: number | null }
export type DisplayField = { label: string; value: DisplayValue } | { label: string; links: DisplayLink[] };
export interface DisplayItem { key: string | null; heading: string | null; badges: { label: string; text: string }[]; fields: DisplayField[] }
export type DisplayBlock =
  | { kind: "graph"; graph: GraphEvidence }
  | { kind: "fields"; title: string | null; fields: DisplayField[] }
  | { kind: "list"; id: string; title: string; items: DisplayItem[] }
  | { kind: "embed"; title: string; caption: string | null; src: string; origin: string; height: number;
      ready: Record<string, EmbedScalar> | null; message: unknown; sendAs: "object" | "json-text"; paths: string[] }
  | { kind: "problem"; title: string | null; problem: string };

function displayText(value: unknown, compact: boolean): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, compact ? undefined : 2) ?? "Not recorded";
}

function displayValue(spec: ValueFieldSpec, match: ViewMatch): DisplayValue {
  let value = read(match, spec.value), note: string | null = null;
  if (value === undefined) return { kind: "missing" };
  if (spec.decodeJson) {
    // The same lossless guard the conversation view uses: decode only when
    // the JSON text survives a round trip unchanged.
    const decoded = typeof value === "string" ? losslessJson(value) : undefined;
    const inner = decoded === undefined || spec.then === null ? decoded : selectViewPath(decoded, spec.then, 1)?.[0]?.value;
    if (inner === undefined) note = "This could not be decoded the way the view describes, so it is shown exactly as recorded.";
    else { value = inner; note = "Decoded from JSON text recorded in this field. The recorded evidence below has the original."; }
  }
  return { kind: spec.as, text: displayText(value, spec.as === "badge"), note };
}

type ListKeys = Map<string, Map<string, number | null>>;

function displayFields(specs: FieldSpec[], match: ViewMatch, keys: ListKeys): DisplayField[] {
  return specs.map(spec => {
    if ("value" in spec) return { label: spec.label, value: displayValue(spec, match) };
    const targets = selectViewPath(match.value, spec.each, LIST_ITEM_LIMIT) ?? [];
    return { label: spec.label, links: targets.map(target => {
      const value = text(target.value);
      return { text: value ?? displayText(target.value, true), list: spec.linkTo, index: value === null ? null : keys.get(spec.linkTo)?.get(value) ?? null };
    }) };
  });
}

// Display-only projections of every block, in the order the view describes
// them. A block whose data is missing says so; it never borrows another shape.
export function declaredViewEvidence(specs: readonly ViewSpec[], evidence: ViewEvidence): DisplayBlock[] {
  const root: ViewMatch = { value: evidence, captures: {} };
  const matches = new Map<string, ViewMatch[] | null>(), keys: ListKeys = new Map();
  for (const spec of specs) {
    if (spec.kind !== "list") continue;
    const found = selectViewPath(evidence, spec.each, LIST_ITEM_LIMIT);
    matches.set(spec.id, found);
    const index = new Map<string, number | null>();
    for (const [position, match] of (found ?? []).entries()) {
      const key = text(read(match, spec.key));
      if (key !== null) index.set(key, index.has(key) ? null : position);
    }
    keys.set(spec.id, index);
  }
  return specs.map((spec): DisplayBlock => {
    if (spec.kind === "graph") return { kind: "graph", graph: graphEvidence(spec, evidence) };
    if (spec.kind === "fields") return { kind: "fields", title: spec.title, fields: displayFields(spec.fields, root, keys) };
    if (spec.kind === "embed") {
      const missing: string[] = [];
      const message = fillTemplate(spec.send, evidence, missing);
      if (missing.length > 0) return { kind: "problem", title: spec.title, problem: `This case records nothing at ${missing.join(", ")}, so there is nothing to send to the page that draws this.` };
      return { kind: "embed", title: spec.title, caption: spec.caption, src: spec.src, origin: spec.origin, height: spec.height,
        ready: spec.ready, message, sendAs: spec.sendAs, paths: spec.paths.map(path => path.text) };
    }
    const found = matches.get(spec.id);
    if (found === null || found === undefined) return { kind: "problem", title: spec.title, problem: `This case has more than ${LIST_ITEM_LIMIT} items at ${spec.each.text}, which is more than this view lists.` };
    if (found.length === 0) return { kind: "problem", title: spec.title, problem: `This case has nothing at ${spec.each.text}.` };
    return { kind: "list", id: spec.id, title: spec.title, items: found.map(match => ({
      key: text(read(match, spec.key)), heading: text(read(match, spec.heading)),
      badges: spec.badges.flatMap(badge => { const value = displayValue(badge, match); return value.kind === "missing" ? [] : [{ label: badge.label, text: value.text }]; }),
      fields: displayFields(spec.fields, match, keys)
    })) };
  });
}
