import { JSDOM } from "jsdom";
import { act, cloneElement, createElement, useSyncExternalStore } from "react";
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
const route = vi.hoisted(() => ({ setSearch: vi.fn(), navigate: vi.fn(), listeners: new Set<() => void>(), id: "case_1", search: "", state: null as { caseIds: string[] } | null }));
vi.mock("react-router-dom", () => {
  const updateRoute = (search: string) => { route.search = search; route.state = null; route.listeners.forEach((listener) => listener()); };
  const navigate = (to: string, options?: unknown) => { route.navigate(to, options); updateRoute(to.includes("?") ? to.slice(to.indexOf("?")) : ""); };
  return {
    Link: ({ to, children, ...props }: any) => createElement("a", { href: to, ...props }, children),
    useNavigate: () => navigate, useParams: () => ({ id: route.id }),
    useSearchParams: () => {
      const search = useSyncExternalStore((listener) => { route.listeners.add(listener); return () => { route.listeners.delete(listener); }; }, () => route.search);
      return [new URLSearchParams(search), (update: (params: URLSearchParams) => URLSearchParams, options: unknown) => { route.setSearch(update, options); updateRoute("?" + update(new URLSearchParams(route.search))); }];
    },
    useLocation: () => { const search = useSyncExternalStore((listener) => { route.listeners.add(listener); return () => { route.listeners.delete(listener); }; }, () => route.search); return { state: route.state, search }; }
  };
});
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
  KPI: ({ label, num }: any) => createElement("div", null, `${label}: ${num}`),
  KPIRow: ({ children }: any) => createElement("div", null, children),
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
const savedRuling = { id: "human_new", skillVersionId: "skillv_1", source: "human", actorName: "Reviewer", payload: { kind: "categorical", choice: "fail", choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 }, rationale: "Accepted" }, createdAt: "2026-09-28T00:00:00Z" };
function queueFixture(id: string, completed = false) {
  return {
    queue: { id, name: id, status: completed ? "completed" : "active", pendingCount: completed ? 0 : 1, completedCount: completed ? 1 : 0 },
    items: [{ id: `${id}_item`, caseId: "case_1", criterionVersionId: "criterionv_1", position: 0, status: completed ? "completed" : "pending", createdAt: "2026-09-28T00:00:00Z" }]
  };
}
const { ReviewPlayer } = await import("../src/components/review-player.js");
const { CaseScreen } = await import("../src/screens/trace.js");
const { ReviewScreen } = await import("../src/screens/review.js");
const { QueueDetailScreen } = await import("../src/screens/queue-detail.js");
let root: ReturnType<typeof createRoot> | undefined;
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ""; route.search = ""; route.state = null; route.id = "case_1";
  dashboard.dashboard = { exceptions: [], skill: { currentVersion: { id: "skillv_new_without_results", criterionVersionId: "criterionv_1" } } };
  dashboard.loading = false; dashboard.error = null; dashboard.errorStatus = null;
  vi.clearAllMocks(); });
async function mount(items: import("../src/components/review-player.js").ReviewPlayerItem[] = [{ key: "item_1", caseId: "case_1", criterionVersionId: "criterionv_1", completed: false }]) {
  const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root!.render(createElement(ReviewPlayer, {
    eyebrow: "Review queue", name: "Old development examples", items,
    onExit: vi.fn(), onItemChanged: vi.fn(), renderDone: () => null
  })));
  return container;
}
describe("historical review player", () => {
  it("links recorded source references, opens instructions, and clears message focus on another case", async () => {
    const { TraceDetail } = await import("../src/components/trace-detail.js");
    const view = structuredClone(detail);
    view.trace.metadata = { evidenceProjection: "whole-trajectory-v2-lossless-text-blocks" };
    view.trace.input = { assessmentScope: "Entire recorded trajectory; output repeats the source final answer.", messages: [
      { role: "system", content: "[source message 0; role=system]\nPolicy" },
      { role: "tool", content: "[source message 1; role=tool; tool=lookup; call_id=a]\nError: unavailable" }
    ] };
    view.judgeRun.reasoning = "Read message 0 then message 1; message 99 has no source.";
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(TraceDetail, { detail: view })));
    const refs = () => [...container.querySelectorAll<HTMLAnchorElement>("a[href^='#']")];
    expect(refs().map(a => a.textContent)).toEqual(["message 0", "message 1"]);
    expect(refs()[0]!.parentElement!.textContent).toBe(view.judgeRun.reasoning);
    const target = container.querySelector<HTMLElement>('[data-message-index="0"]')!;
    target.scrollIntoView = vi.fn();
    await act(async () => refs()[0]!.click());
    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(target);
    expect(target.querySelector("details")!.open).toBe(true);
    expect(target.textContent).toContain("Referenced by the evaluator");
    expect(api.recordHumanVerdict).not.toHaveBeenCalled();
    const next = structuredClone(view); next.exception.id = "another-case";
    await act(async () => root!.render(createElement(TraceDetail, { detail: next })));
    expect(container.textContent).not.toContain("Referenced by the evaluator");
    expect(container.querySelector('[data-message-index="0"] details')!.hasAttribute("open")).toBe(false);
    await act(async () => root!.render(createElement(TraceDetail, { detail: view })));
    expect(container.textContent).not.toContain("Referenced by the evaluator");
    const revisit = container.querySelector<HTMLElement>('[data-message-index="0"]')!;
    revisit.scrollIntoView = vi.fn();
    await act(async () => refs()[0]!.click());
    expect(container.textContent).toContain("Referenced by the evaluator");
    const anotherRun = structuredClone(view); anotherRun.judgeRun.id = "judge_2";
    anotherRun.judgeRun.reasoning = "Different assessment without a citation.";
    await act(async () => root!.render(createElement(TraceDetail, { detail: anotherRun })));
    expect(container.textContent).not.toContain("Referenced by the evaluator");
    expect(container.querySelector('[data-message-index="0"] details')!.hasAttribute("open")).toBe(false);
    // An unknown import cannot establish what the judge meant by “message 0”.
    next.trace.metadata = {};
    await act(async () => root!.render(createElement(TraceDetail, { detail: { ...next } })));
    expect(refs()).toHaveLength(0);
  });
  it("loads a pinned result, preserves it across refresh, and records the task even when a prior human agrees", async () => {
    const prior = { id: "prior", projectId: "project_1", caseId: "case_1", skillVersionId: "skillv_other", source: "human" as const, actorUserId: null,
      payload: { kind: "binary" as const, pass: false, rationale: "Previous review" }, externalRunId: null, createdAt: "2026-08-26T10:00:00Z" };
    api.fetchCaseDetail.mockResolvedValue({ ...detail, verdictHistory: [prior] });
    api.recordHumanVerdict.mockResolvedValue({ ...prior, id: "new_review", skillVersionId: "skillv_1" });
    const items = [{ key: "item_1", queueItemId: "item_1", caseId: "case_1", criterionVersionId: "criterionv_1", skillVersionId: "skillv_1", judgeRunId: detail.judgeRun.id, completed: false }];
    const container = await mount(items);
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", "skillv_1", "criterionv_1", detail.judgeRun.id);
    expect(container.textContent).toContain("Recorded assessment");
    const accept = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Agree with assessment:"));
    expect(accept).toBeDefined();
    await act(async () => accept!.click());
    expect(api.recordHumanVerdict).toHaveBeenCalledWith("case_1", expect.objectContaining({ choice: "fail" }), "skillv_1",
      { queueItemId: "item_1", judgeRunId: detail.judgeRun.id, submissionId: expect.any(String) });
    await act(async () => root!.unmount()); root = undefined;
    await mount(items);
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", "skillv_1", "criterionv_1", detail.judgeRun.id);
  });

  it("reuses a submission ID after a lost response without completing another task", async () => {
    api.fetchCaseDetail.mockResolvedValue(detail);
    api.recordHumanVerdict.mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce({ id: "saved" });
    const container = await mount([{ key: "item_1", queueItemId: "item_1", caseId: "case_1", criterionVersionId: "criterionv_1", skillVersionId: "skillv_1", judgeRunId: detail.judgeRun.id, completed: false }]);
    const accept = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Agree with assessment:"))!;
    await act(async () => accept().click());
    expect(container.textContent).toContain("Connection lost");
    await act(async () => accept().click());
    expect(api.recordHumanVerdict.mock.calls[1]![3]).toEqual(api.recordHumanVerdict.mock.calls[0]![3]);
  });

  it("opens the requested queue position and preserves its exact definition when navigating", async () => {
    route.search = "criterionId=c1&at=item_2&cluster=scope";
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = await mount([
      { key: "item_1", caseId: "case_1", criterionVersionId: "old", completed: false },
      { key: "item_2", caseId: "case_2", criterionVersionId: "other", completed: false }
    ]);
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_2", undefined, "other", undefined);
    expect(container.querySelector("h1")?.getAttribute("aria-label")).toContain("Case 2 of 2");
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Prev")!.click());
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", undefined, "old", undefined);
    const update = route.setSearch.mock.calls.at(-1)![0];
    const params = update(new URLSearchParams(route.search));
    expect(params.get("at")).toBe("item_1");
    expect(params.get("criterionId")).toBe("c1");
    expect(params.get("cluster")).toBe("scope");
  });

  it("canonicalizes a state-only selection before navigation drops router state", async () => {
    route.state = { caseIds: ["case_1", "case_2"] };
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(ReviewScreen)));
    expect(new URLSearchParams(route.search).getAll("caseId")).toEqual(["case_1", "case_2"]);
    expect(new URLSearchParams(route.search).get("criterionVersionId")).toBe("criterionv_1");
    expect(route.state).toBeNull();
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Next")!.click());
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_2", undefined, "criterionv_1", undefined);
    expect(container.querySelector("h1")?.getAttribute("aria-label")).toContain("Case 2 of 2");
  });

  it("lands an Overview preview link on its selected case within the whole loaded batch", async () => {
    const { queueReviewUrl } = await import("../src/lib/exception-queue.js");
    route.search = queueReviewUrl([{ id: "case_1", criterionVersionId: "old" }, { id: "case_2", criterionVersionId: "other" }], "?criterionId=c1").split("?")[1] + "&at=case_2";
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(ReviewScreen)));
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_2", undefined, "other", undefined);
    expect(container.querySelector("h1")?.getAttribute("aria-label")).toContain("Case 2 of 2");
    expect(api.recordHumanVerdict).not.toHaveBeenCalled();
  });

  it("reopens the exact completed saved item from its position URL", async () => {
    route.search = "at=item_2";
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = await mount([
      { key: "item_1", caseId: "case_1", criterionVersionId: "old", completed: true },
      { key: "item_2", caseId: "case_2", criterionVersionId: "other", completed: true }
    ]);
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_2", undefined, "other", undefined);
    expect(container.querySelector("h1")?.getAttribute("aria-label")).toContain("Case 2 of 2");
  });

  it("skips the last case without a review write and keeps it visibly unfinished", async () => {
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = await mount();
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Skip for now")!.click());
    expect(container.textContent).toContain("1 skipped this session; skipping does not record a human label");
    expect(api.recordHumanVerdict).not.toHaveBeenCalled();
  });

  it("keeps save confirmation after advancing and can return to change that human label", async () => {
    api.fetchCaseDetail.mockResolvedValue(detail);
    api.recordHumanVerdict.mockResolvedValue({ id: "human_new", skillVersionId: "skillv_1", source: "human", actorName: "Reviewer", payload: { kind: "categorical", choice: "fail", choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 }, rationale: "Accepted" }, createdAt: "2026-09-28T00:00:00Z" });
    const container = await mount([
      { key: "item_1", caseId: "case_1", criterionVersionId: "criterionv_1", completed: false },
      { key: "item_2", caseId: "case_2", criterionVersionId: "criterionv_1", completed: false }
    ]);
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Agree with assessment:"))!.click());
    expect(container.textContent).toContain("Case 1: human label recorded");
    expect(dashboard.refresh).toHaveBeenCalledTimes(1);
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_2", undefined, "criterionv_1", undefined);
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === "Change human label")!.click());
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", undefined, "criterionv_1", undefined);
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(api.recordHumanVerdict).toHaveBeenCalledTimes(1);
  });

  it("shows a destination queue failure instead of retaining the prior queue's loading state", async () => {
    route.id = "queue_a";
    api.fetchCaseDetail.mockResolvedValue(detail);
    api.fetchReviewQueueDetail.mockResolvedValueOnce(queueFixture("queue_a")).mockRejectedValueOnce(new Error("Destination unavailable"));
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(QueueDetailScreen)));
    expect(container.textContent).toContain("queue_a");
    route.id = "queue_b";
    await act(async () => root!.render(createElement(QueueDetailScreen)));
    expect(container.textContent).toContain("Could not load queue");
    expect(container.textContent).toContain("Destination unavailable");
    expect(container.textContent).not.toContain("Loading queue");
    expect(container.textContent).not.toContain("Agree with assessment:");
  });

  it("does not apply a late saved human label or progress reload to another queue", async () => {
    route.id = "queue_a";
    api.fetchCaseDetail.mockResolvedValue(detail);
    api.fetchReviewQueueDetail.mockResolvedValueOnce(queueFixture("queue_a")).mockResolvedValueOnce(queueFixture("queue_b"));
    let resolveSave!: (value: unknown) => void;
    api.recordHumanVerdict.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve; }));
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(QueueDetailScreen)));
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Agree with assessment:"))!.click());
    expect(api.recordHumanVerdict).toHaveBeenCalledTimes(1);
    route.id = "queue_b";
    await act(async () => root!.render(createElement(QueueDetailScreen)));
    await act(async () => resolveSave(savedRuling));
    expect(container.querySelector("h1")?.textContent).toContain("queue_b");
    expect(container.textContent).not.toContain("human label recorded");
    expect(api.fetchReviewQueueDetail.mock.calls.map(([id]) => id)).toEqual(["queue_a", "queue_b"]);
    expect(route.setSearch).not.toHaveBeenCalled();
    expect(dashboard.refresh).not.toHaveBeenCalled();
  });

  it("preserves a saved human label receipt when progress refresh fails and retries to the completed summary", async () => {
    route.id = "queue_a";
    api.fetchCaseDetail.mockResolvedValue(detail);
    api.recordHumanVerdict.mockResolvedValueOnce(savedRuling);
    api.fetchReviewQueueDetail.mockResolvedValueOnce(queueFixture("queue_a"))
      .mockRejectedValueOnce(new Error("Progress unavailable"))
      .mockResolvedValueOnce(queueFixture("queue_a", true));
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(QueueDetailScreen)));
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Agree with assessment:"))!.click());
    expect(container.textContent).toContain("Case 1: human label recorded");
    expect(container.textContent).toContain("queue progress could not refresh");
    expect(container.textContent).not.toContain("Queue complete");
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Retry queue progress")!.click());
    expect(container.textContent).toContain("1 of 1 cases have a recorded human label");
    expect(container.textContent).toContain("Queue complete");
    expect(container.textContent).not.toContain("queue progress could not refresh");
    expect(api.recordHumanVerdict).toHaveBeenCalledTimes(1);
    expect(api.fetchReviewQueueDetail).toHaveBeenCalledTimes(3);
  });

  it("keeps the original ad hoc selection and partial summary after a dashboard refresh removes reviewed cases", async () => {
    route.state = { caseIds: ["case_1", "case_2"] };
    api.fetchCaseDetail.mockResolvedValue(detail);
    api.recordHumanVerdict.mockResolvedValueOnce(savedRuling);
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(ReviewScreen)));
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Agree with assessment:"))!.click());
    dashboard.dashboard = { exceptions: [], skill: { currentVersion: { id: "skillv_after_edit", criterionVersionId: "criterionv_after_edit" } } };
    await act(async () => root!.render(createElement(ReviewScreen)));
    expect(new URLSearchParams(route.search).getAll("caseId")).toEqual(["case_1", "case_2"]);
    expect(new URLSearchParams(route.search).get("criterionVersionId")).toBe("criterionv_1");
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_2", undefined, "criterionv_1", undefined);
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Session summary")!.click());
    expect(container.textContent).toContain("1 of 2 cases reviewed this session");
    expect(container.textContent).toContain("1 cases were not reviewed in this session");
    expect(container.textContent).toContain("Accepted: 1");
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Continue reviewing")!.click());
    expect(container.querySelector("h1")?.getAttribute("aria-label")).toContain("Case 2 of 2");
    expect(api.recordHumanVerdict).toHaveBeenCalledTimes(1);
  });

  it("resets session counts and receipt when the selected criterion changes", async () => {
    route.search = "caseId=case_1&caseId=case_2&criterionVersionId=criterionv_1";
    api.fetchCaseDetail.mockResolvedValue(detail);
    api.recordHumanVerdict.mockResolvedValueOnce(savedRuling);
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(ReviewScreen)));
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Agree with assessment:"))!.click());
    expect(container.textContent).toContain("Case 1: human label recorded");
    route.search = "caseId=case_1&caseId=case_2&criterionVersionId=criterionv_2";
    await act(async () => root!.render(createElement(ReviewScreen)));
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", undefined, "criterionv_2", undefined);
    expect(container.textContent).not.toContain("human label recorded");
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Session summary")!.click());
    expect(container.textContent).toContain("0 of 2 cases reviewed this session");
    expect(container.textContent).toContain("Accepted: 0");
    expect(api.recordHumanVerdict).toHaveBeenCalledTimes(1);
  });

  it("discards an in-flight progress response from the queue left behind", async () => {
    route.id = "queue_a";
    api.fetchCaseDetail.mockResolvedValue(detail);
    api.recordHumanVerdict.mockResolvedValueOnce(savedRuling);
    let resolveProgress!: (value: unknown) => void;
    api.fetchReviewQueueDetail.mockResolvedValueOnce(queueFixture("queue_a"))
      .mockReturnValueOnce(new Promise((resolve) => { resolveProgress = resolve; }))
      .mockResolvedValueOnce(queueFixture("queue_b"));
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(QueueDetailScreen)));
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Agree with assessment:"))!.click());
    route.id = "queue_b";
    await act(async () => root!.render(createElement(QueueDetailScreen)));
    await act(async () => resolveProgress(queueFixture("queue_a", true)));
    expect(container.querySelector("h1")?.textContent).toContain("queue_b");
    expect(container.textContent).not.toContain("Queue complete");
    expect(container.textContent).not.toContain("human label recorded");
    expect(api.fetchReviewQueueDetail.mock.calls.map(([id]) => id)).toEqual(["queue_a", "queue_a", "queue_b"]);
  });

  it("never interprets modified browser shortcuts as review actions", async () => {
    api.fetchCaseDetail.mockResolvedValue(detail);
    await mount();
    await act(async () => {
      window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "a", metaKey: true }));
      window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "a", ctrlKey: true }));
    });
    expect(api.recordHumanVerdict).not.toHaveBeenCalled();
  });

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
    expect(api.fetchCaseDetail).toHaveBeenCalledWith("case_1", undefined, entry === "partially pinned URL" ? "old_definition" : "criterionv_1", undefined);
    expect(container.textContent).toContain("Agree with assessment:");
    expect(api.recordHumanVerdict).not.toHaveBeenCalled();
  });

  it("loads a fully pinned review URL despite a dashboard 503", async () => {
    route.search = "caseId=case_1&caseId=case_2&criterionVersionId=old_definition&cv.1=other_definition";
    dashboard.dashboard = null; dashboard.error = "Server unavailable"; dashboard.errorStatus = 503;
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(ReviewScreen)));
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", undefined, "old_definition", undefined);
    expect(container.textContent).toContain("Agree with assessment:");
    expect(container.textContent).not.toContain("HTTP 503");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Next")!.click());
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_2", undefined, "other_definition", undefined);
    expect(api.recordHumanVerdict).not.toHaveBeenCalled();
  });

  it("loads ad hoc review with the selected criterion when the newest evaluator has no result", async () => {
    route.search = "caseId=case_1";
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(ReviewScreen)));
    expect(api.fetchCaseDetail).toHaveBeenCalledWith("case_1", undefined, "criterionv_1", undefined);
    expect(container.textContent).toContain("Agree with assessment:");
  });

  it("reloads a Review all URL with every case and its pinned definition, independent of the current dashboard", async () => {
    route.search = "criterionId=c1&caseId=case_1&caseId=case_2&criterionVersionId%5Bcase_1%5D=old_definition&criterionVersionId%5Bcase_2%5D=other_definition";
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(ReviewScreen)));
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", undefined, "old_definition", undefined);
    expect(container.querySelector("h1")?.getAttribute("aria-label")).toContain("Case 1 of 2");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Next")!.click());
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_2", undefined, "other_definition", undefined);
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
    route.id = "queue_1";
    api.fetchCaseDetail.mockImplementation(async (_caseId, _version, criterionVersionId) => ({ ...detail, exception: { ...detail.exception, criterionVersionId } }));
    api.fetchReviewQueueDetail.mockResolvedValue({
      queue: { id: "queue_1", name: "Mixed criterion queue", pendingCount: 2, completedCount: 0 },
      items: ["criterionv_1", "criterionv_2"].map((criterionVersionId, position) => ({ id: `item_${position}`, caseId: "case_1", criterionVersionId, position, status: "pending", createdAt: "2026-09-28T00:00:00Z" }))
    });
    const container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(createElement(QueueDetailScreen)));
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", undefined, "criterionv_1", undefined);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Next")!.click());
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", undefined, "criterionv_2", undefined);
  });

  it.each(["pass", "fail", "ambiguous"] as const)("agreeing with %s records that displayed label and its historical evaluator", async (label) => {
    api.fetchCaseDetail.mockResolvedValue({ ...detail, exception: { ...detail.exception, verdict: label }, judgeRun: { ...detail.judgeRun, verdict: label } });
    api.recordHumanVerdict.mockResolvedValue({ id: "human_new", skillVersionId: "skillv_1", source: "human", actorName: "Reviewer", payload: { kind: "categorical", choice: label, choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 }, rationale: "Accepted" }, createdAt: "2026-09-28T00:00:00Z" });
    const container = await mount();
    expect(api.fetchCaseDetail).toHaveBeenCalledWith("case_1", undefined, "criterionv_1", undefined);
    expect(container.textContent).toContain("The answer omitted a direct link.");
    const accept = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Agree with assessment:"));
    expect(accept).toBeDefined();
    expect(accept!.textContent).toContain(`Agree with assessment: ${label[0]!.toUpperCase()}${label.slice(1)}`);
    await act(async () => accept!.click());
    expect(api.recordHumanVerdict).toHaveBeenCalledWith("case_1", expect.objectContaining({ choice: label }), "skillv_1", undefined);
  });


  it("disagreeing opens a different-human label form without immediately recording a verdict", async () => {
    api.fetchCaseDetail.mockResolvedValue(detail);
    const container = await mount();
    const disagree = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Correct assessment"));
    expect(disagree?.textContent).toContain("Choose a different human label and explain why");
    await act(async () => disagree!.click());
    expect(api.recordHumanVerdict).not.toHaveBeenCalled();
    const submit = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Record PASS human label"));
    expect(submit?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[role="radio"][title="This is already the current human label."]')?.disabled).toBe(true);
  });

  it("keeps unavailable scoped evidence explicit and retries the same criterion without offering review actions", async () => {
    api.fetchCaseDetail.mockRejectedValue(new Error("No recorded evaluator result is available for this case and criterion version."));
    const container = await mount();
    expect(container.textContent).toContain("No recorded evaluator result");
    expect(container.textContent).not.toContain("Agree with assessment:");
    api.fetchCaseDetail.mockResolvedValue(detail);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click());
    expect(api.fetchCaseDetail).toHaveBeenLastCalledWith("case_1", undefined, "criterionv_1", undefined);
    expect(container.textContent).toContain("Agree with assessment:");
    expect(api.recordHumanVerdict).not.toHaveBeenCalled();
  });
});
