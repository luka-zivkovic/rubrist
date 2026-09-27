import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ExceptionDetail } from "@rubrist/shared";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Event", "Node", "localStorage"] as const) {
  vi.stubGlobal(name, (dom.window as unknown as Record<string, unknown>)[name]);
}
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const api = vi.hoisted(() => ({ fetchTraceTests: vi.fn().mockResolvedValue([]), fetchReviewQueueDetail: vi.fn(), fetchCaseDetail: vi.fn(), recordHumanVerdict: vi.fn(), promoteExceptionToGoldenSet: vi.fn() }));
const dashboard = vi.hoisted(() => ({ dashboard: { exceptions: [], skill: { currentVersion: { id: "skillv_new_without_results", criterionVersionId: "criterionv_1" } } }, refresh: vi.fn() }));
vi.mock("@/lib/dashboard-context", () => ({ useDashboard: () => dashboard }));
vi.mock("@/lib/criterion-scope", async () => import("../src/lib/criterion-scope.js"));
vi.mock("@/lib/utils", () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(" ") }));
vi.mock("@/components/review-player", async () => import("../src/components/review-player.js"));
const route = vi.hoisted(() => ({ id: "case_1", search: "", state: null }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn(), useParams: () => ({ id: route.id }), useSearchParams: () => [new URLSearchParams(route.search)], useLocation: () => ({ state: route.state }) }));
vi.mock("@/lib/exception-queue", async () => import("../src/lib/exception-queue.js"));
vi.mock("@/components/view-in-ironside", () => ({ ViewInIronside: () => null }));
vi.mock("@/lib/trace-test-flow", () => ({ intentForVerdict: () => "prevent" }));
vi.mock("@/lib/trace-test-pilot", () => ({ dismissTraceTestPrompt: vi.fn(), traceTestPromptDismissed: () => false }));
vi.mock("@/components/trace-detail", async () => import("../src/components/trace-detail.js"));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: { children?: unknown }) => createElement("section", props, children as never),
  CardHeader: ({ children, ...props }: { children?: unknown }) => createElement("header", props, children as never),
  CardTitle: ({ children, ...props }: { children?: unknown }) => createElement("h2", props, children as never),
  CardDescription: ({ children, ...props }: { children?: unknown }) => createElement("p", props, children as never),
  CardContent: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never)
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children?: unknown }) => createElement("button", props, children as never)
}));
vi.mock("@/components/ui/separator", () => ({
  Separator: (props: Record<string, unknown>) => createElement("hr", props)
}));
vi.mock("@/components/rubrist", () => ({
  Eyebrow: ({ children, ...props }: { children?: unknown }) => createElement("span", props, children as never),
  SectionHead: ({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) =>
    createElement("header", null, `${eyebrow} ${title} ${sub ?? ""}`),
  VerdictChip: ({ verdict }: { verdict: string }) => createElement("span", null, verdict),
  Chip: ({ children, ...props }: { children?: unknown }) => createElement("span", props, children as never),
  MarginNote: ({ children, ...props }: { children?: unknown }) => createElement("aside", props, children as never),
  JudgeCallPanel: () => createElement("div")
}));
vi.mock("@/lib/api", () => api);


const detail: ExceptionDetail = {
  exception: {
    id: "case_1",
    traceId: "trace_1",
    title: "A disputed support answer",
    verdict: "fail",
    reason: "The evaluator considered the response too vague.",
    skillVersionId: "skillv_1",
    criterionVersionId: "criterionv_1",
    reviewerState: "needs_review",
    createdAt: "2026-08-26T09:00:00.000Z"
  },
  trace: {
    id: "trace_1",
    input: { question: "Can I export my data?" },
    output: { answer: "Use Workspace settings." },
    metadata: {}
  },
  judgeRun: {
    id: "judge_1",
    projectId: "project_1",
    caseId: "case_1",
    skillVersionId: "skillv_1",
    verdict: "fail",
    score: 0.2,
    reasoning: "The answer omitted a direct link.",
    createdAt: "2026-08-26T09:00:00.000Z"
  },
  datasetExpectations: [],
  latestHumanLabel: null,
  verdictHistory: [],
  goldenSetEntry: null
};
const { ReviewPlayer } = await import("../src/components/review-player.js");
const { CaseScreen } = await import("../src/screens/trace.js");
const { ReviewScreen } = await import("../src/screens/review.js");
const { QueueDetailScreen } = await import("../src/screens/queue-detail.js");
let root: ReturnType<typeof createRoot> | undefined;
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ""; route.search = ""; vi.clearAllMocks(); });
async function mount(items = [{ key: "item_1", caseId: "case_1", criterionVersionId: "criterionv_1", completed: false }]) {
  const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root!.render(createElement(ReviewPlayer, {
    eyebrow: "Review queue", name: "Old development examples", items,
    onExit: vi.fn(), onItemChanged: vi.fn(), renderDone: () => null
  })));
  return container;
}
describe("historical review player", () => {
  it("loads ad hoc review with the selected criterion when the newest evaluator has no result", async () => {
    route.search = "caseId=case_1";
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(ReviewScreen)));
    expect(api.fetchCaseDetail).toHaveBeenCalledWith("case_1", undefined, "criterionv_1");
    expect(container.textContent).toContain("Accept evaluator opinion");
  });

  it("opens historical case links, but keeps explicitly selected evaluator links exact", async () => {
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(CaseScreen)));
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", undefined, "criterionv_1");
    route.search = "skillVersionId=skillv_selected_without_results";
    api.fetchCaseDetail.mockRejectedValue(new Error("Case not found"));
    await act(async () => root!.render(createElement(CaseScreen)));
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", "skillv_selected_without_results", undefined);
    expect(container.textContent).toContain("Case not found");
    expect(api.fetchCaseDetail).toHaveBeenCalledTimes(2);
  });

  it("carries persisted item criterion pins through the queue screen, including two criteria on one case", async () => {
    api.fetchCaseDetail.mockImplementation(async (_caseId, _version, criterionVersionId) => ({ ...detail, exception: { ...detail.exception, criterionVersionId } }));
    api.fetchReviewQueueDetail.mockResolvedValue({
      queue: { id: "queue_1", name: "Mixed criterion queue", pendingCount: 2, completedCount: 0 },
      items: ["criterionv_1", "criterionv_2"].map((criterionVersionId, position) => ({ id: `item_${position}`, caseId: "case_1", criterionVersionId, position, status: "pending", createdAt: "2026-09-28T00:00:00Z" }))
    });
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(QueueDetailScreen)));
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", undefined, "criterionv_1");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Next")!.click());
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", undefined, "criterionv_2");
  });

  it("loads by the queue criterion instead of today's evaluator, then reviews the displayed evaluator", async () => {
    api.fetchCaseDetail.mockResolvedValue(detail);
    api.recordHumanVerdict.mockResolvedValue({ id: "human_new", skillVersionId: "skillv_1", source: "human", actorName: "Reviewer", payload: { kind: "binary", pass: false, rationale: "Accepted" }, createdAt: "2026-09-28T00:00:00Z" });
    const container = await mount();
    expect(api.fetchCaseDetail).toHaveBeenCalledWith("case_1", undefined, "criterionv_1");
    expect(container.textContent).toContain("The answer omitted a direct link.");
    const accept = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Accept evaluator opinion"));
    expect(accept).toBeDefined();
    await act(async () => accept!.click());
    expect(api.recordHumanVerdict).toHaveBeenCalledWith("case_1", expect.objectContaining({ choice: "fail" }), "skillv_1");
  });

  it("keeps unavailable scoped evidence explicit and retries the same criterion without offering review actions", async () => {
    api.fetchCaseDetail.mockRejectedValue(new Error("No recorded evaluator result is available for this case and criterion version."));
    const container = await mount();
    expect(container.textContent).toContain("No recorded evaluator result");
    expect(container.textContent).not.toContain("Accept evaluator opinion");
    api.fetchCaseDetail.mockResolvedValue(detail);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click());
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", undefined, "criterionv_1");
    expect(container.textContent).toContain("Accept evaluator opinion");
    expect(api.recordHumanVerdict).not.toHaveBeenCalled();
  });
});
