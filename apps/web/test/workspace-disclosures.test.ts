import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { InlineDetails } from "../src/components/rubrist/inline-details.js";

vi.mock("@/components/ui/card", () => {
  const Component = ({ children }: any) => createElement("div", null, children);
  return { Card: Component, CardHeader: Component, CardTitle: Component, CardDescription: Component, CardContent: Component };
});
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: any) => createElement("button", props, children)
}));
vi.mock("@/lib/utils", () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(" ") }));
const { JudgeCallPanel } = await import("../src/components/rubrist/judge-call-panel.js");
const { Ref } = await import("../src/components/rubrist/ref.js");

async function withDom(test: (container: HTMLElement, root: ReturnType<typeof createRoot>) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://rubrist.example" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try { await test(container, root); }
  finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); dom.window.close(); }
}

describe("workspace technical disclosures", () => {
  it.each([null, "pm", "dev", "exec"])("keeps payloads collapsed but inspectable for preference %s", async (preference) => {
    await withDom(async (container, root) => {
      if (preference) window.localStorage.setItem("rubrist.mode", preference);
      await act(async () => root.render(createElement(JudgeCallPanel, {
        meta: {}, compiledPrompt: "COMPILED_PAYLOAD", rawRequest: "REQUEST_PAYLOAD", rawResponse: "RESPONSE_PAYLOAD"
      })));
      expect(container.querySelectorAll("pre")).toHaveLength(0);
      for (const [label, content] of [["View compiled prompt", "COMPILED_PAYLOAD"], ["View raw request", "REQUEST_PAYLOAD"], ["View raw response", "RESPONSE_PAYLOAD"]]) {
        const trigger = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label!))!;
        await act(async () => trigger.click());
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        expect(document.getElementById(trigger.getAttribute("aria-controls")!)?.textContent).toContain(content);
        expect(container.querySelectorAll("pre")).toHaveLength(1);
      }
      const collapse = [...container.querySelectorAll("button")].find((b) => b.textContent === "Collapse")!;
      await act(async () => collapse.click());
      expect(container.querySelectorAll("pre")).toHaveLength(0);
    });
  });

  it("expands an inline identifier without triggering a containing row action", async () => {
    await withDom(async (container, root) => {
      const navigate = vi.fn();
      await act(async () => root.render(createElement("div", { onClick: navigate },
        createElement(InlineDetails, { label: "Trace ID", children: "trace_one" })
      )));
      const trigger = container.querySelector("button")!;
      const content = document.getElementById(trigger.getAttribute("aria-controls")!)!;
      expect(content.hidden).toBe(true);
      trigger.focus();
      expect(document.activeElement).toBe(trigger);
      await act(async () => trigger.click());
      expect(content.hidden).toBe(false);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      await act(async () => content.click());
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  it("keeps reference actions and identifier disclosure separate", async () => {
    await withDom(async (container, root) => {
      const navigate = vi.fn();
      await act(async () => root.render(createElement(Ref, { kind: "case", label: "Example", id: "case_one", onClick: navigate })));
      expect(container.querySelector("button button")).toBeNull();
      const [link, disclosure] = [...container.querySelectorAll("button")];
      await act(async () => disclosure!.click());
      expect(navigate).not.toHaveBeenCalled();
      await act(async () => link!.click());
      expect(navigate).toHaveBeenCalledOnce();
    });
  });
});
