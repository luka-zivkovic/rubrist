import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { conversationEvidence, evidenceText } from "../src/lib/trace-evidence.js";
import { CaseEvidence } from "../src/components/case-evidence.js";
import { ConversationEvidence } from "../src/components/conversation-evidence.js";

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: any) => createElement("article", props, children),
  CardHeader: ({ children, ...props }: any) => createElement("header", props, children),
  CardTitle: ({ children, ...props }: any) => createElement("h2", props, children),
  CardDescription: ({ children, ...props }: any) => createElement("p", props, children),
  CardContent: ({ children, ...props }: any) => createElement("div", props, children)
}));
const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "Node"] as const) vi.stubGlobal(name, dom.window[name]);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ""; });
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });
function render(input: unknown, output: unknown = "Current response", metadata?: unknown) {
  const html = renderToStaticMarkup(createElement(ConversationEvidence, { input, output, metadata }));
  const container = document.createElement("div"); container.innerHTML = html;
  return { html, container };
}
function raw(container: HTMLElement) {
  const section = [...container.querySelectorAll("details")].find(el => el.querySelector(":scope > summary")?.textContent === "Raw recorded input, output and steps");
  return JSON.parse(section!.querySelector("pre")!.textContent!);
}

describe("recorded conversation evidence", () => {
  it("renders full long policy and tool text without a completeness claim", () => {
    const policy = "policy ".repeat(1500) + "policy final condition";
    const tool = "tool result ".repeat(1500) + "last tool observation";
    const { container } = render({ messages: [{ role: "system", content: policy }, { role: "tool", content: tool }] });
    expect(container.textContent).toContain(policy);
    expect(container.textContent).toContain(tool);
    expect(container.textContent).not.toContain("Truncation marker");
  });

  it("warns about markers even in collapsed earlier context and trajectory steps", () => {
    const input = { messages: [{ role: "system", content: [{ type: "text", text: "old policy…[TRUNCATED]" }] },
      ...Array.from({ length: 8 }, () => ({ role: "user", content: "short" }))] };
    const { container } = render(input);
    expect(container.textContent).toContain("Truncation marker in recorded evidence");
    expect(container.textContent).toContain("Some context may be missing");
    expect(raw(container).input).toEqual(input);
    const html = renderToStaticMarkup(createElement(ConversationEvidence, { input: {}, output: "ok", steps: [{ input: {}, output: "cut…[TRUNCATED]" }] }));
    expect(html).toContain("Truncation marker in recorded evidence");
    expect(render({}, "cut…[TRUNCATED]").container.textContent).toContain("Truncation marker in recorded evidence");
  });

  it("keeps arbitrary payloads as input/output instead of inventing two turns", () => {
    for (const input of [{ question: "Q", evidence: ["E"], unknown: { critical: true } }, "{\"messages\":[1]}", null, [], { messages: [] }, { messages: "bad" }]) {
      expect(conversationEvidence(input)).toBeNull();
      const { html, container } = render(input, { answer: "A", warning: false });
      expect(html).toContain("Case evidence");
      expect(html).not.toContain("2 turns");
      expect(raw(container)).toEqual({ input, output: { answer: "A", warning: false } });
    }
  });

  it("preserves mixed roles, malformed entries, unknown fields and source array order", () => {
    const input = { messages: [
      { role: "assistant", content: "earlier reply", timestamp: "later timestamp" },
      { role: "user", content: "request", timestamp: "earlier timestamp" },
      null,
      { role: "critic", content: "unknown role evidence" },
      { role: "tool", name: "lookup", content: "tool result", tool_call_id: "call_1" },
      { role: "assistant", tool_calls: [{ id: "pending" }], content: null }
    ], context_warning: "not complete" };
    const frozen = JSON.stringify(input);
    const { container, html } = render(input);
    const context = container.querySelector('[aria-label="Conversation context"]')!;
    expect([...context.querySelectorAll("h4")].map(el => el.textContent)).toEqual(["Entry 1 · Assistant", "Entry 2 · User", "Entry 3 · Unrecognized message", "Entry 4 · Unrecognized message", "Entry 5 · Tool · lookup · response", "Entry 6 · Assistant"]);
    expect(html).toContain("input.messages[4]");
    expect(html).toContain("Additional recorded fields · context_warning");
    expect(html).toContain("tool_call_id");
    expect(html).toContain("pending");
    expect(raw(container).input).toEqual(input);
    expect(JSON.stringify(input)).toBe(frozen);
    expect(container.querySelector('[aria-label="Recorded output"]')!.textContent).not.toContain("earlier reply");
    const tool = context.querySelector('[data-message-index="4"]')!;
    expect(tool.querySelector(":scope > div > p")!.textContent).toBe("tool result");
    expect(tool.closest("details")).toBeNull();
  });

  it("retains multimodal blocks without loading images, executing HTML or discarding fields", () => {
    const input = { messages: [{ role: "user", content: [
      { type: "text", text: "<script>alert(1)</script>\n![track](https://bad.invalid/pixel)" },
      { type: "image_url", image_url: { url: "https://bad.invalid/private" } },
      { type: "text", text: "text with extra", citations: ["must retain"] },
      { future_block: "still present" }
    ] }] };
    const { container } = render(input, "<img src=x onerror=alert(1)>");
    expect(container.querySelectorAll("img,script,iframe,a")).toHaveLength(0);
    expect(container.textContent).toContain("must retain");
    expect(container.textContent).toContain("still present");
    expect(raw(container).input).toEqual(input);
  });

  it("keeps preview limitations, earlier replies and tool evidence separate from the selected output", () => {
    const input = { userRequestPreview: "Current request", precedingTurns: [
      { turnIndex: 8, userMessagePreview: "Earlier request", assistantResponsePreview: "Earlier response", toolCallsInSourceOrder: [
        { name: "first", inputPreview: "args one", outputPreview: "result one…", status: "error" },
        { name: "second", inputPreview: null, outputPreview: "result two" }
      ], unknown: "preserve me" },
      { turnIndex: 2, userMessagePreview: "Retain source order", toolCallsInSourceOrder: "malformed tool evidence" },
      null
    ], evidenceLimitations: "Recorded source was clipped.", later_field: "do not infer a future turn" };
    const { container, html } = render(input, "Selected response");
    expect(html).toContain("Preview-only evidence");
    expect(html).toContain("Recorded source was clipped.");
    expect(html).toContain("input.precedingTurns[0].toolCallsInSourceOrder[1]");
    expect(html).toContain("malformed tool evidence");
    const earlier = [...container.querySelectorAll("summary")].find(el => el.textContent === "Earlier context · 3 recorded turns")!;
    expect(earlier.parentElement!.hasAttribute("open")).toBe(false);
    expect([...earlier.parentElement!.querySelectorAll("h4")].map(el => el.textContent)).toEqual(["Earlier turn · source index 8", "Earlier turn · source index 2"]);
    const output = container.querySelector('[aria-label="Recorded output"]')!;
    expect(output.textContent).toContain("Selected response");
    expect(output.textContent).not.toContain("Earlier response");
    expect(raw(container)).toEqual({ input, output: "Selected response" });
  });

  it("shows long histories in order without hiding the early evidence, and resets disclosures per case", async () => {
    const input = { messages: [{ role: "system", content: "Instructions" }, ...Array.from({ length: 200 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `message ${index}` }))] };
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(ConversationEvidence, { key: "case1", input, output: "assessed output" })));
    const context = () => container.querySelector('[aria-label="Conversation context"]')!;
    expect(context().querySelectorAll("h4")).toHaveLength(200);
    expect([...context().querySelectorAll("section > div > p")].map(el => el.textContent)).toEqual(input.messages.slice(1).map(el => el.content));
    const policy = context().querySelector("details")!;
    expect(policy.open).toBe(false);
    policy.open = true;
    await act(async () => root!.render(createElement(ConversationEvidence, { key: "case2", input, output: "second output" })));
    expect(context().querySelector("details")!.open).toBe(false);
    expect(raw(container).input.messages).toHaveLength(201);
  });

  it("makes the explicitly imported whole-trajectory scope and tool errors visible, retaining source output", () => {
    const metadata = { evidenceProjection: "whole-trajectory-v2-lossless-text-blocks" };
    const input = { assessmentScope: "Entire recorded trajectory; output repeats the source final answer.", availableTools: [{ type: "function", function: { name: "lookup", parameters: {} } }], messages: [
      { role: "assistant", content: '[source message 0; role=assistant]\n\nRecorded tool calls:\n[{"id":"a","type":"function","function":{"name":"check_status_bar","arguments":"{}"}}]' },
      { role: "tool", content: "[source message 1; role=tool; tool=check_status_bar; call_id=a]\nError: Tool 'check_status_bar' not found." }
    ] };
    const before = JSON.stringify(input);
    const { container } = render(input, "Hi! How can I help you today?", metadata);
    expect(container.textContent).toContain("Whole conversation · 2 recorded messages");
    const call = container.querySelector('[data-message-index="0"]')!;
    expect(call.querySelector("h4")!.textContent).toBe("Message 0 · Assistant");
    expect(call.querySelector("p.font-mono")!.textContent).toBe("check_status_bar");
    const result = container.querySelector('[data-message-index="1"]')!;
    expect(result.parentElement).toBe(call.parentElement);
    expect(result.querySelector(":scope > div > p")!.textContent).toBe("Error: Tool 'check_status_bar' not found.");
    expect(result.closest("details")).toBeNull();
    const output = container.querySelector('[aria-label="Recorded output"]')!;
    expect(output.tagName).toBe("DETAILS");
    expect(output.hasAttribute("open")).toBe(false);
    expect(output.textContent).toContain("Hi! How can I help you today?");
    expect(container.textContent).toContain("Available tools · 1 recorded definitions");
    expect(raw(container)).toEqual({ input, output: "Hi! How can I help you today?" });
    expect(JSON.stringify(input)).toBe(before);
    // The same words in arbitrary source content do not activate the adapter.
    const generic = render(input).container;
    expect(generic.textContent).not.toContain("Whole conversation");
    expect(generic.querySelector('[aria-label="Recorded output"]')!.tagName).toBe("SECTION");
    expect(generic.querySelector('[data-message-index="0"] > div > p')!.textContent).toContain("Recorded tool calls:");
  });

  it("distinguishes missing, null and empty evidence", () => {
    expect(evidenceText(undefined)).toBe("Not recorded");
    expect(evidenceText(null)).toBe("null");
    expect(evidenceText("")).toBe("");
    const html = renderToStaticMarkup(createElement(ConversationEvidence, { input: "", output: undefined }));
    const container = document.createElement("div"); container.innerHTML = html;
    expect(container.textContent).toContain("Empty text");
    expect(container.querySelector('[aria-label="Recorded output"]')!.textContent).toContain("Not recorded");
    expect(render([], []).container.querySelector('[aria-label="Recorded output"]')!.textContent).toContain("[]");
  });
});


describe("structured evidence limitations", () => {
  it("warns for clipped evidence, claims and steps without claiming completeness", () => {
    for (const props of [
      { input: { evidence: ["source…[TRUNCATED]"] }, output: { claim: "claim" } },
      { input: { evidence: ["source"] }, output: { claim: "claim…[TRUNCATED]" } },
      { input: { evidence: ["source"] }, output: { claim: "claim" }, steps: [{ output: "tool…[TRUNCATED]" }] }
    ]) {
      const html = renderToStaticMarkup(createElement(CaseEvidence, props));
      expect(html).toContain("Truncation marker in recorded evidence");
      expect(html).not.toContain("complete source text");
    }
    const html = renderToStaticMarkup(createElement(CaseEvidence, { input: { evidence: ["source"] }, output: { claim: "claim" } }));
    expect(html).not.toContain("Truncation marker");
  });
});
