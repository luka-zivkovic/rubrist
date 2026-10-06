import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  declaredViewEvidence, embedAddress, embedReadyMatches, graphEvidence, parseViewPath, parseViewSpecs, selectViewPath,
  type DisplayBlock, type DisplayField, type DrawnGraph, type GraphViewSpec
} from "../src/lib/view-spec.js";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../public/mods/${path}`, import.meta.url), "utf8"));
const shippedSpec = read("n8n-execution/mod.json").views.find((view: { kind: string }) => view.kind === "graph");
const example = read("n8n-execution/example-case.json");
const parseViewSpec = (value: unknown) => parseViewSpecs([value])?.[0] ?? null;
const spec = parseViewSpec(shippedSpec) as GraphViewSpec;
const evidence = (change: (copy: typeof example) => void = () => {}) => {
  const copy = structuredClone(example);
  change(copy);
  return { input: copy.input, output: copy.output, steps: copy.steps ?? null, metadata: copy.metadata };
};

describe("view paths", () => {
  it("select in source order and remember captured keys", () => {
    const path = parseViewPath("connections.{source}.main.{port}.*")!;
    const matches = selectViewPath({ connections: { A: { main: [[{ node: "B" }], [{ node: "C" }, { node: "D" }]] }, E: { other: [] } } }, path, 100)!;
    expect(matches.map(match => [match.captures.source, match.captures.port, (match.value as { node: string }).node]))
      .toEqual([["A", "0", "B"], ["A", "1", "C"], ["A", "1", "D"]]);
  });

  it("read own keys only and stop at the limit", () => {
    expect(selectViewPath({ a: {} }, parseViewPath("a.constructor")!, 10)).toEqual([]);
    expect(selectViewPath({ a: {} }, parseViewPath("a.__proto__")!, 10)).toEqual([]);
    expect(selectViewPath(["x"], parseViewPath("length")!, 10)).toEqual([]);
    expect(selectViewPath({ items: [1, 2, 3] }, parseViewPath("items.*")!, 2)).toBeNull();
  });

  it("reject malformed paths", () => {
    for (const path of ["", "a..b", "a.**", "a.{Bad}", "a.{x", 7, "a.".repeat(20) + "b"]) expect(parseViewPath(path)).toBeNull();
  });
});

describe("view descriptions", () => {
  it("accept the shipped n8n description", () => {
    expect(spec).toMatchObject({ kind: "graph" });
  });

  it("reject unknown kinds, unknown keys, wildcards in a field, and undeclared captures", () => {
    expect(parseViewSpec({ ...shippedSpec, kind: "chart" })).toBeNull();
    expect(parseViewSpec({ ...shippedSpec, script: "alert(1)" })).toBeNull();
    expect(parseViewSpec({ ...shippedSpec, nodes: { ...shippedSpec.nodes, html: "name" } })).toBeNull();
    expect(parseViewSpec({ ...shippedSpec, nodes: { ...shippedSpec.nodes, label: "tags.*" } })).toBeNull();
    expect(parseViewSpec({ ...shippedSpec, edges: { ...shippedSpec.edges, source: "{nope}" } })).toBeNull();
    expect(parseViewSpec({ ...shippedSpec, nodes: { ...shippedSpec.nodes, id: undefined } })).toBeNull();
  });
});

describe("graph projection of the n8n example", () => {
  it("binds nodes, edges and recorded steps without inventing any", () => {
    const graph = graphEvidence(spec, evidence()) as DrawnGraph;
    expect(graph.title).toBe("Support ticket triage");
    expect(graph.nodes.map(node => [node.id, node.runs.map(run => run.index)])).toEqual([
      ["Webhook", [0]], ["Classify ticket", [1]], ["Refund request?", [2]], ["Look up order", [3]],
      ["Issue refund", [4]], ["Escalate to human", []], ["Reply to customer", [5]]
    ]);
    expect(graph.edges).toContainEqual({ source: "Refund request?", target: "Escalate to human", port: 1, ports: 2 });
    expect(graph.edges).toHaveLength(7);
    expect(graph.nodes[1]!.runs[0]).toMatchObject({ status: "success", isError: false, durationMs: 1840 });
    expect(graph.orphans).toEqual([]);
    expect(graph.undrawnEdges).toBe(0);
  });

  it("keeps repeated runs, recorded errors, unplaced steps and dangling edges visible", () => {
    const graph = graphEvidence(spec, evidence(copy => {
      copy.steps.push({ name: "Classify ticket", input: 1, output: 2, metadata: { status: "error", error: "rate limited" } });
      copy.steps.push({ name: "Deleted node", input: null, output: null });
      copy.steps.push("not a step");
      copy.input.workflow.connections["Reply to customer"] = { main: [[{ node: "Gone", type: "main", index: 0 }]] };
    })) as DrawnGraph;
    expect(graph.nodes[1]!.runs.map(run => [run.index, run.isError, run.error])).toEqual([[1, false, undefined], [6, true, "rate limited"]]);
    expect(graph.orphans).toEqual([{ index: 7, name: "Deleted node" }, { index: 8, name: null }]);
    expect(graph.undrawnEdges).toBe(1);
  });

  it("draws nothing rather than guess when the case lacks the expected shape", () => {
    expect(graphEvidence(spec, { input: "plain text", output: "", steps: null, metadata: {} })).toHaveProperty("problem");
    expect(graphEvidence(spec, evidence(copy => { delete copy.input.workflow.nodes[2].position; }))).toHaveProperty("problem");
    expect(graphEvidence(spec, evidence(copy => { copy.input.workflow.nodes[3].name = "Webhook"; }))).toHaveProperty("problem");
    expect(graphEvidence(spec, evidence(copy => {
      copy.input.workflow.nodes = Array.from({ length: 301 }, (_, index) => ({ name: `n${index}`, position: [index, 0] }));
    }))).toHaveProperty("problem");
  });
});

describe("fields and lists: the LangTracer finding example", () => {
  const views = read("langtracer-finding/mod.json").views;
  const finding = read("langtracer-finding/example-case.json");
  const specs = parseViewSpecs(views)!;
  const project = (change: (copy: typeof finding) => void = () => {}): DisplayBlock[] => {
    const copy = structuredClone(finding);
    change(copy);
    return declaredViewEvidence(specs, { input: copy.input, output: copy.output, steps: null, metadata: copy.metadata });
  };
  const field = (fields: DisplayField[], label: string) => fields.find(item => item.label === label)!;

  it("accepts the shipped description and rejects a link to a list it does not have", () => {
    expect(specs.map(block => block.kind)).toEqual(["fields", "list"]);
    expect(parseViewSpecs([views[0]])).toBeNull();
    expect(parseViewSpecs([views[1], views[1]])).toBeNull();
    expect(parseViewSpecs([{ ...views[1], fields: [{ label: "x", value: "a", then: "b" }] }])).toBeNull();
    expect(parseViewSpecs([{ ...views[1], fields: [{ label: "x", value: "a", decode: "yaml" }] }])).toBeNull();
    expect(parseViewSpecs([{ ...views[1], fields: [{ label: "x", value: "a", as: "html" }] }])).toBeNull();
    expect(parseViewSpecs([])).toBeNull();
  });

  it("labels the finding and keeps a missing field explicit", () => {
    const [fields] = project(copy => { delete copy.output.proposedCheck; });
    if (fields!.kind !== "fields") throw new Error("expected fields");
    expect(field(fields.fields, "Severity")).toEqual({ label: "Severity", value: { kind: "badge", text: "wrong", note: null } });
    expect(field(fields.fields, "Test case candidate")).toMatchObject({ value: { kind: "badge", text: "true" } });
    expect(field(fields.fields, "Description")).toMatchObject({ value: { kind: "text", text: finding.output.description } });
    expect(field(fields.fields, "Proposed check")).toEqual({ label: "Proposed check", value: { kind: "missing" } });
  });

  it("links a citation only to the one run with that id", () => {
    const [fields] = project(copy => { copy.input.toolRuns[1].runId = copy.input.toolRuns[0].runId; });
    if (fields!.kind !== "fields") throw new Error("expected fields");
    const cited = field(fields.fields, "Cited runs");
    if (!("links" in cited)) throw new Error("expected links");
    // Run 0 and run 1 now share an id, the original id of run 1 is gone, and the last id never existed.
    expect(cited.links.map(link => link.index)).toEqual([null, null, 2, null]);
    expect(cited.links[3]!.text).toBe("00000000-0000-0000-0000-000000000404");
  });

  it("decodes declared JSON text into readable code, and leaves it literal when it cannot", () => {
    const [, list] = project();
    if (list!.kind !== "list") throw new Error("expected list");
    expect(list.items.map(item => [item.key, item.heading])).toHaveLength(4);
    expect(list.items[0]!.badges).toContainEqual({ label: "ms", text: "9120" });
    const decoded = field(list.items[2]!.fields, "Written content");
    if (!("value" in decoded) || decoded.value.kind !== "code") throw new Error("expected code");
    expect(decoded.value.text).toBe(JSON.parse(finding.input.toolRuns[2].inputs.content).content);
    expect(decoded.value.text.split("\n").length).toBeGreaterThan(10);
    expect(decoded.value.note).toMatch(/Decoded from JSON text/);
    const cut = field(list.items[3]!.fields, "Written content");
    if (!("value" in cut) || cut.value.kind !== "code") throw new Error("expected code");
    expect(cut.value.text).toBe(finding.input.toolRuns[3].inputs.content);
    expect(cut.value.note).toMatch(/shown exactly as recorded/);
    expect(list.items[3]!.badges).toContainEqual({ label: "stored truncated", text: "true" });
  });

  it("says when the case has no list, and never borrows another shape", () => {
    const [, list] = project(copy => { copy.input = "plain text"; });
    expect(list).toMatchObject({ kind: "problem" });
  });
});

describe("embed block: another origin's page draws part of the view", () => {
  const views = read("n8n-execution/mod.json").views;
  const embed = views[0];

  it("fills the message with only the values the description names", () => {
    const blocks = declaredViewEvidence(parseViewSpecs(views)!, evidence());
    expect(blocks.map(block => block.kind)).toEqual(["embed", "graph"]);
    const block = blocks[0]!;
    if (block.kind !== "embed") throw new Error("expected embed");
    expect(block).toMatchObject({ origin: "https://n8n-preview-service.internal.n8n.cloud", paths: ["input.workflow"], sendAs: "json-text", ready: { command: "n8nReady" } });
    expect(block.message).toEqual({ command: "openWorkflow", workflow: example.input.workflow, hideNodeIssues: true });
    expect(JSON.stringify(block.message)).not.toContain("dana@example.com");
  });

  it("builds the page address and refuses unsafe ones", () => {
    expect(embedAddress(embed.src, "dark")?.href).toBe("https://n8n-preview-service.internal.n8n.cloud/workflows/demo?theme=dark");
    expect(embedAddress("http://localhost:5678/workflows/demo", "light")?.origin).toBe("http://localhost:5678");
    for (const src of ["http://example.com/x", "javascript:alert(1)", "data:text/html,x", "https://user:pw@example.com/x", "https://example.com/x#y", "/mods/x/view.html", ""]) {
      expect(embedAddress(src, "light")).toBeNull();
      expect(parseViewSpecs([{ ...embed, src }])).toBeNull();
    }
  });

  it("rejects a description that sends nothing named, a wildcard, or unknown keys", () => {
    expect(parseViewSpecs([embed])).not.toBeNull();
    expect(parseViewSpecs([{ ...embed, send: { command: "open" } }])).toBeNull();
    expect(parseViewSpecs([{ ...embed, send: { all: { $value: "input.*" } } }])).toBeNull();
    expect(parseViewSpecs([{ ...embed, send: { all: { $value: "input", extra: 1 } } }])).toBeNull();
    expect(parseViewSpecs([{ ...embed, sendAs: "html" }])).toBeNull();
    expect(parseViewSpecs([{ ...embed, script: "x" }])).toBeNull();
    expect(parseViewSpecs([{ ...embed, ready: { command: { nested: true } } }])).toBeNull();
  });

  it("recognises the ready message as an object or as JSON text, and nothing looser", () => {
    const ready = { command: "n8nReady" };
    expect(embedReadyMatches(ready, JSON.stringify({ command: "n8nReady", version: "1" }))).toBe(true);
    expect(embedReadyMatches(ready, { command: "n8nReady" })).toBe(true);
    expect(embedReadyMatches(ready, JSON.stringify({ command: "openNDV" }))).toBe(false);
    expect(embedReadyMatches(ready, "n8nReady")).toBe(false);
    expect(embedReadyMatches(ready, null)).toBe(false);
  });

  it("sends nothing when the case does not record the named value", () => {
    const [block] = declaredViewEvidence(parseViewSpecs([embed])!, { input: {}, output: null, steps: null, metadata: {} });
    expect(block).toMatchObject({ kind: "problem" });
  });
});
