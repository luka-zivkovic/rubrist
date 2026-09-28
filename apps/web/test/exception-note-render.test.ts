import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ExceptionCase } from "@rubrist/shared";

vi.mock("react-router-dom", () => ({}));
vi.mock("@/components/ui/card", () => ({}));
vi.mock("@/components/ui/table", () => ({}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: any) => createElement("button", props, children)
}));
vi.mock("@/components/rubrist", () => ({
  VerdictChip: ({ verdict }: any) => createElement("span", null, verdict),
  ProvChip: () => null
}));
vi.mock("@/components/save-queue-modal", () => ({}));
vi.mock("@/components/row-action", () => ({
  RowLink: ({ children, to, state: _state, ...props }: any) => createElement("a", { href: to, ...props }, children)
}));
vi.mock("@/lib/api", () => ({}));
vi.mock("@/lib/dashboard-context", () => ({}));
vi.mock("@/lib/criterion-scope", () => ({}));
vi.mock("@/lib/journey", () => ({}));
vi.mock("@/lib/resolved", () => ({}));
vi.mock("@/lib/exception-queue", async () => import("../src/lib/exception-queue.js"));
vi.mock("@/lib/utils", () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(" "), formatTimestamp: (time: string) => time }));
const { ExceptionQueueRow } = await import("../src/screens/exceptions.js");
const exception: ExceptionCase = {
  id: "case_1", traceId: "trace_1", title: "Question without explanation", verdict: "fail", reason: "",
  skillVersionId: "version_1", criterionVersionId: "criterionv_1", reviewerState: "needs_review", createdAt: "2026-09-28T00:00:00Z"
};
function render(value: ExceptionCase) {
  return renderToStaticMarkup(createElement("table", null, createElement("tbody", null,
    createElement(ExceptionQueueRow, { exception: value, provisional: false, onOpen: () => {}, onReview: () => {}, onCategory: () => {} })
  )));
}
describe("exception note controls", () => {
  it("keeps the full case record and one working set of actions in the stacked row", async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    const onOpen = vi.fn();
    const onReview = vi.fn();
    const reason = "A complete explanation that remains available alongside the verdict.";
    try {
      await act(async () => root.render(createElement("table", null, createElement("tbody", null,
        createElement(ExceptionQueueRow, {
          exception: { ...exception, reason }, provisional: false, onOpen, onReview, onCategory: () => {}
        })
      ))));
      const cells = [...container.querySelectorAll("td")];
      expect(cells.map((cell) => cell.dataset.label)).toEqual(["Case", "Judge category", "Evaluator", "Judge note", "Actions"]);
      expect(cells[2]?.textContent).toContain("fail");
      expect(cells[3]?.textContent).toContain(reason);
      const buttons = [...container.querySelectorAll("button")];
      expect(buttons).toHaveLength(2);
      const note = buttons.find((button) => button.textContent === "Full note")!;
      const review = buttons.find((button) => button.getAttribute("aria-label")?.startsWith("Review "))!;
      await act(async () => note.click());
      expect(note.getAttribute("aria-expanded")).toBe("true");
      expect(dom.window.document.getElementById(note.getAttribute("aria-controls")!)?.textContent).toContain(reason);
      expect(onOpen).not.toHaveBeenCalled();
      await act(async () => review.click());
      expect(onReview).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      vi.unstubAllGlobals();
    }
  });

  it("does not offer an empty note expansion while keeping review available", () => {
    const html = render(exception);
    expect(html).toContain("No explanation recorded.");
    expect(html).not.toContain("Full note");
    expect(html).toContain("Review Question without explanation");
  });

  it("keeps expansion when an actual earlier or newer explanation exists", () => {
    expect(render({ ...exception, reason: "Earlier explanation." })).toContain("Full note");
    expect(render({ ...exception, rejudgedSince: { verdict: "pass", reason: "Newer explanation.", judgeRunId: "judge_2", createdAt: "2026-09-28T01:00:00Z" } })).toContain("Full note");
  });
});
