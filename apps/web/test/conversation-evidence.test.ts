import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { conversationEvidence, evidenceText } from "../src/lib/trace-evidence.js";
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
function render(input: unknown, output: unknown = "Current response") {
  const html = renderToStaticMarkup(createElement(ConversationEvidence, { input, output }));
  const container = document.createElement("div"); container.innerHTML = html;
  return { html, container };
}
function raw(container: HTMLElement) {
  const section = [...container.querySelectorAll("details")].find(el => el.querySelector(":scope > summary")?.textContent === "Raw recorded input, output and steps");
  return JSON.parse(section!.querySelector("pre")!.textContent!);
}

describe("recorded conversation evidence", () => {
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
    expect([...context.querySelectorAll("h4")].map(el => el.textContent)).toEqual(["Assistant", "User", "Unrecognized message", "Unrecognized message", "Assistant"]);
    expect(html).toContain("input.messages[4]");
    expect(html).toContain("Additional recorded fields · context_warning");
    expect(html).toContain("tool_call_id");
    expect(html).toContain("pending");
    expect(raw(container).input).toEqual(input);
    expect(JSON.stringify(input)).toBe(frozen);
    expect(container.querySelector('[aria-label="Recorded output"]')!.textContent).not.toContain("earlier reply");
    const tool = [...context.querySelectorAll("summary")].find(el => el.textContent === "Tool · lookup")!;
    expect(tool.parentElement!.hasAttribute("open")).toBe(false);
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

  it("shows every earlier message on request and resets expansion when the case changes", async () => {
    const input = { messages: Array.from({ length: 200 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `message ${index}` })) };
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(ConversationEvidence, { key: "case1", input, output: "assessed output" })));
    const context = () => container.querySelector('[aria-label="Conversation context"]')!;
    expect(context().querySelectorAll("h4")).toHaveLength(6);
    const toggle = context().querySelector("button")!;
    expect(toggle.textContent).toBe("Show 194 earlier entries");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(context().querySelectorAll("h4")).toHaveLength(200);
    expect([...context().querySelectorAll("section > div > p")].map(el => el.textContent)).toEqual(input.messages.map(el => el.content));
    await act(async () => root!.render(createElement(ConversationEvidence, { key: "case2", input, output: "second output" })));
    expect(context().querySelectorAll("h4")).toHaveLength(6);
    expect(raw(container).input.messages).toHaveLength(200);
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
