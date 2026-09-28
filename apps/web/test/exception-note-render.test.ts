import { cloneElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ExceptionCase } from "@rubrist/shared";

vi.mock("react-router-dom", () => ({ Link: ({ to, children, ...props }: any) => createElement("a", { href: to, ...props }, children) }));
vi.mock("@/components/ui/card", () => ({}));
vi.mock("@/components/ui/table", () => ({}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, asChild, variant: _variant, size: _size, ...props }: any) => asChild ? cloneElement(children, props) : createElement("button", props, children)
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
    createElement(ExceptionQueueRow, { exception: value, provisional: false, onOpen: () => {}, search: "?criterionId=criterion_1", onCategory: () => {} })
  )));
}
describe("exception note controls", () => {
  it("does not offer an empty note expansion while keeping review available", () => {
    const html = render(exception);
    expect(html).toContain("No explanation recorded.");
    expect(html).not.toContain("Full note");
    expect(html).toContain("Review Question without explanation");
    expect(html).toContain('href="/review?criterionId=criterion_1&amp;criterionVersionId=criterionv_1&amp;caseId=case_1"');
    expect(html).toContain('href="/cases/case_1?from=exceptions&amp;criterionVersionId=criterionv_1&amp;criterionId=criterion_1"');
  });

  it("keeps expansion when an actual earlier or newer explanation exists", () => {
    expect(render({ ...exception, reason: "Earlier explanation." })).toContain("Full note");
    expect(render({ ...exception, rejudgedSince: { verdict: "pass", reason: "Newer explanation.", judgeRunId: "judge_2", createdAt: "2026-09-28T01:00:00Z" } })).toContain("Full note");
  });
});
