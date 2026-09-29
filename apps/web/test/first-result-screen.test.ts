import { act, createElement, type ReactNode } from "react";
import { JSDOM } from "jsdom";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  params: new URLSearchParams("version=version&skill=skill&criterionId=criterion"),
  navigate: vi.fn(), refresh: vi.fn(), ensure: vi.fn(), runs: vi.fn(), verdicts: vi.fn(), detail: vi.fn(),
  dashboard: { viewerRole: "owner", project: { importedTraceCount: 20 },
    skill: { currentVersion: { id: "version", version: "1.0" } }, currentVersionResultCount: 1 }
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => harness.navigate, useSearchParams: () => [harness.params] }));
vi.mock("@/lib/dashboard-context", () => ({ useDashboard: () => ({ dashboard: harness.dashboard, refresh: harness.refresh }) }));
vi.mock("@/lib/api", () => ({
  ensureSkillVersionBackfill: harness.ensure, fetchEvalRuns: harness.runs, fetchProjectVerdicts: harness.verdicts,
  fetchEvalRunDetail: harness.detail, fetchCaseVerdicts: vi.fn(),
  fetchSkillVersionCriterion: async () => ({ criterionId: "criterion", name: "Question", definition: "Is it correct?" })
}));
vi.mock("@/lib/first-result", async () => import("../src/lib/first-result.js"));
vi.mock("@/lib/journey", () => ({ firstResultPath: () => "/first-result", markSetupReceipt: vi.fn() }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => createElement("button", { onClick }, children) }));
vi.mock("@/components/ui/card", () => {
  const Div = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return { Card: Div, CardContent: Div, CardHeader: Div, CardTitle: Div, CardDescription: Div };
});
vi.mock("@/components/rubrist", () => ({
  Eyebrow: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  SectionHead: ({ title, sub }: { title: string; sub: string }) => createElement("header", null, title, sub),
  VerdictChip: ({ verdict }: { verdict: string }) => createElement("span", null, verdict)
}));
const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "Node"] as const) vi.stubGlobal(name, dom.window[name]);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { FirstResultScreen } = await import("../src/screens/first-result.js");
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  harness.runs.mockResolvedValue([]); harness.verdicts.mockResolvedValue([]);
  harness.ensure.mockResolvedValue({ run: null, dispatchPending: false, retryAfterMs: 0 });
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

it("never starts historical evaluation while polling an import without a saved run", async () => {
  await act(async () => root.render(createElement(FirstResultScreen)));
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(harness.runs).toHaveBeenCalledWith(100, "version", "first_assessment");
  expect(harness.ensure).not.toHaveBeenCalled();
  const button = [...document.querySelectorAll("button")].find(button => button.textContent === "Evaluate existing cases")!;
  expect(button).toBeDefined();
  await act(async () => button.click());
  expect(harness.ensure).toHaveBeenCalledTimes(1);
});

it("shows the recorded assessment when a newer imported case failed", async () => {
  harness.runs.mockResolvedValue([{ id: "failed_b", skillVersionId: "version", trigger: "api_batch", datasetId: null, status: "failed" }]);
  harness.verdicts.mockResolvedValue([{ id: "result_a", caseId: "case_a", skillVersionId: "version", source: "llm_judge", payload: { kind: "binary", pass: true, rationale: "Recorded A assessment" } }]);
  await act(async () => root.render(createElement(FirstResultScreen)));
  expect(document.body.textContent).toContain("Your first assessment is ready");
  expect(document.body.textContent).toContain("Recorded A assessment");
  expect(document.body.textContent).not.toContain("The first assessment could not be produced");
  expect(harness.ensure).not.toHaveBeenCalled();
  expect(harness.detail).not.toHaveBeenCalled();
});


it.each(["running", "failed"])("keeps polling unfinished work after the tracked run becomes %s", async (status) => {
  const pending = { id: "pending_a", skillVersionId: "version", trigger: "api_batch", datasetId: null, status: "pending" };
  const failed = { ...pending, id: "failed_b", status: "failed" };
  harness.runs.mockResolvedValueOnce([failed, pending]).mockResolvedValue([{ ...pending, id: "pending_c" }]);
  harness.ensure.mockResolvedValue({ run: { ...pending, status, items: [], totalItems: 1, completedItems: 0, failedItems: status === "failed" ? 1 : 0 }, dispatchPending: false, retryAfterMs: 0 });
  await act(async () => root.render(createElement(FirstResultScreen)));
  harness.verdicts.mockResolvedValue([{ id: "eventual_result", caseId: "case_pending", skillVersionId: "version", source: "llm_judge", payload: { kind: "binary", pass: true, rationale: "Outstanding work completed" } }]);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(document.body.textContent).toContain("Outstanding work completed");
  expect(document.body.textContent).toContain("Your first assessment is ready");
});
