import { JSDOM } from "jsdom";
import { act, cloneElement, createElement } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ExceptionDetail } from "@rubrist/shared";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Event", "Node", "localStorage"] as const) {
  vi.stubGlobal(name, (dom.window as unknown as Record<string, unknown>)[name]);
}
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const api = vi.hoisted(() => ({ fetchTraceTests: vi.fn().mockResolvedValue([]), fetchReviewQueueDetail: vi.fn(), fetchCaseDetail: vi.fn(), recordHumanVerdict: vi.fn(), promoteExceptionToGoldenSet: vi.fn() }));
const dashboard = vi.hoisted(() => ({
  dashboard: { exceptions: [], skill: { currentVersion: { id: "skillv_new_without_results", criterionVersionId: "criterionv_1" } } } as { exceptions: never[]; skill: { currentVersion: { id: string; criterionVersionId: string } } } | null,
  loading: false, error: null as string | null, errorStatus: null as number | null,
  refresh: vi.fn(), reload: vi.fn()
}));
vi.mock("@/lib/dashboard-context", () => ({ useDashboard: () => dashboard }));
vi.mock("@/lib/criterion-scope", async () => import("../src/lib/criterion-scope.js"));
vi.mock("@/lib/utils", () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(" ") }));
vi.mock("@/components/review-player", async () => import("../src/components/review-player.js"));
const route = vi.hoisted(() => ({ id: "case_1", search: "", state: null as { caseIds: string[] } | null }));
vi.mock("react-router-dom", () => ({ Link: ({ to, children, ...props }: any) => createElement("a", { href: to, ...props }, children), useNavigate: () => vi.fn(), useParams: () => ({ id: route.id }), useSearchParams: () => [new URLSearchParams(route.search)], useLocation: () => ({ state: route.state, search: route.search }) }));
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
  Button: ({ children, asChild, ...props }: any) => asChild ? cloneElement(children, props) : createElement("button", props, children as never)
}));
vi.mock("@/components/ui/separator", () => ({
  Separator: (props: Record<string, unknown>) => createElement("hr", props)
}));
vi.mock("@/components/rubrist", () => ({
  EmptyGlyph: () => null,
  EmptyShell: ({ title, body, primary, secondary }: any) => createElement("section", null, createElement("h1", null, title), body, primary, secondary),
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
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ""; route.search = ""; route.state = null;
  dashboard.dashboard = { exceptions: [], skill: { currentVersion: { id: "skillv_new_without_results", criterionVersionId: "criterionv_1" } } };
  dashboard.loading = false; dashboard.error = null; dashboard.errorStatus = null;
  vi.clearAllMocks(); });
async function mount(items = [{ key: "item_1", caseId: "case_1", criterionVersionId: "criterionv_1", completed: false }]) {
  const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root!.render(createElement(ReviewPlayer, {
    eyebrow: "Review queue", name: "Old development examples", items,
    onExit: vi.fn(), onItemChanged: vi.fn(), renderDone: () => null
  })));
  return container;
}
describe("historical review player", () => {
  it.each(["legacy URL", "router state", "partially pinned URL"])("offers recovery for %s when dashboard scope is unavailable", async (entry) => {
    route.search = entry === "legacy URL" ? "caseId=case_1"
      : entry === "partially pinned URL" ? "caseId=case_1&caseId=case_2&cv.0=old_definition" : "";
    route.state = entry === "router state" ? { caseIds: ["case_1"] } : null;
    dashboard.dashboard = null; dashboard.error = "Server unavailable"; dashboard.errorStatus = 503;
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(ReviewScreen)));
    expect(container.textContent).toContain("server returned an error while loading the review queue");
    expect(container.textContent).toContain("HTTP 503");
    expect(container.textContent).not.toContain("Loading case");
    expect(api.fetchCaseDetail).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Try again"))!.click());
    expect(dashboard.reload).toHaveBeenCalledTimes(1);
    dashboard.dashboard = { exceptions: [], skill: { currentVersion: { id: "skillv_new_without_results", criterionVersionId: "criterionv_1" } } };
    dashboard.error = null; dashboard.errorStatus = null;
    await act(async () => root!.render(createElement(ReviewScreen)));
    expect(api.fetchCaseDetail).toHaveBeenCalledWith("case_1", undefined, entry === "partially pinned URL" ? "old_definition" : "criterionv_1");
    expect(container.textContent).toContain("Agree with evaluator");
    expect(api.recordHumanVerdict).not.toHaveBeenCalled();
  });

  it("loads a fully pinned review URL despite a dashboard 503", async () => {
    route.search = "caseId=case_1&caseId=case_2&criterionVersionId=old_definition&cv.1=other_definition";
    dashboard.dashboard = null; dashboard.error = "Server unavailable"; dashboard.errorStatus = 503;
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(ReviewScreen)));
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", undefined, "old_definition");
    expect(container.textContent).toContain("Agree with evaluator");
    expect(container.textContent).not.toContain("HTTP 503");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Next")!.click());
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_2", undefined, "other_definition");
    expect(api.recordHumanVerdict).not.toHaveBeenCalled();
  });

  it("loads ad hoc review with the selected criterion when the newest evaluator has no result", async () => {
    route.search = "caseId=case_1";
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(ReviewScreen)));
    expect(api.fetchCaseDetail).toHaveBeenCalledWith("case_1", undefined, "criterionv_1");
    expect(container.textContent).toContain("Agree with evaluator");
  });

  it("reloads a Review all URL with every case and its pinned definition, independent of the current dashboard", async () => {
    route.search = "criterionId=c1&caseId=case_1&caseId=case_2&criterionVersionId%5Bcase_1%5D=old_definition&criterionVersionId%5Bcase_2%5D=other_definition";
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(ReviewScreen)));
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", undefined, "old_definition");
    expect(container.querySelector("h1")?.getAttribute("aria-label")).toContain("Case 1 of 2");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Next")!.click());
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_2", undefined, "other_definition");
    expect(container.querySelector("h1")?.getAttribute("aria-label")).toContain("Case 2 of 2");
  });

  it("offers real case-back and test-builder links preserving criterion and the displayed evaluator", async () => {
    route.search = "?from=exceptions&criterionId=c1&criterionVersionId=criterionv_1";
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(CaseScreen)));
    expect(container.querySelector('a[href="/exceptions?criterionId=c1"]')?.textContent).toContain("Back to queue");
    const builder = [...container.querySelectorAll("a")].find((link) => link.href.includes("/make-test"));
    expect(builder).toBeDefined();
    const params = new URL(builder!.href).searchParams;
    expect(params.get("skillVersionId")).toBe("skillv_1");
    expect(params.get("criterionId")).toBe("c1");
    expect(params.get("from")).toBe("exceptions");
    expect(api.recordHumanVerdict).not.toHaveBeenCalled();
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

  it.each(["pass", "fail", "ambiguous"] as const)("agreeing with %s records that displayed label and its historical evaluator", async (label) => {
    api.fetchCaseDetail.mockResolvedValue({ ...detail, exception: { ...detail.exception, verdict: label }, judgeRun: { ...detail.judgeRun, verdict: label } });
    api.recordHumanVerdict.mockResolvedValue({ id: "human_new", skillVersionId: "skillv_1", source: "human", actorName: "Reviewer", payload: { kind: "categorical", choice: label, choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 }, rationale: "Accepted" }, createdAt: "2026-09-28T00:00:00Z" });
    const container = await mount();
    expect(api.fetchCaseDetail).toHaveBeenCalledWith("case_1", undefined, "criterionv_1");
    expect(container.textContent).toContain("The answer omitted a direct link.");
    const accept = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Agree with evaluator"));
    expect(accept).toBeDefined();
    expect(accept!.textContent).toContain(`Record ${label.toUpperCase()} as my ruling`);
    await act(async () => accept!.click());
    expect(api.recordHumanVerdict).toHaveBeenCalledWith("case_1", expect.objectContaining({ choice: label }), "skillv_1");
  });


  it("disagreeing opens a different-ruling form without immediately recording a verdict", async () => {
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = await mount();
    const disagree = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Disagree with evaluator"));
    expect(disagree?.textContent).toContain("Choose a different ruling and explain why");
    await act(async () => disagree!.click());
    expect(api.recordHumanVerdict).not.toHaveBeenCalled();
    const submit = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Record PASS ruling"));
    expect(submit?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[role="radio"][title="This is already the current ruling."]')?.disabled).toBe(true);
  });

  it("keeps unavailable scoped evidence explicit and retries the same criterion without offering review actions", async () => {
    api.fetchCaseDetail.mockRejectedValue(new Error("No recorded evaluator result is available for this case and criterion version."));
    const container = await mount();
    expect(container.textContent).toContain("No recorded evaluator result");
    expect(container.textContent).not.toContain("Agree with evaluator");
    api.fetchCaseDetail.mockResolvedValue(detail);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click());
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", undefined, "criterionv_1");
    expect(container.textContent).toContain("Agree with evaluator");
    expect(api.recordHumanVerdict).not.toHaveBeenCalled();
  });
});
