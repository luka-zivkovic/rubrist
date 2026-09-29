import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, afterEach, afterAll, expect, it, vi } from "vitest";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "HTMLSelectElement", "Event", "Node"] as const) vi.stubGlobal(name, (dom.window as any)[name]);
const { createRoot } = await import("react-dom/client");
afterAll(() => { vi.unstubAllGlobals(); dom.window.close(); });
const api = vi.hoisted(() => ({ fetchReviewQueues: vi.fn(), fetchSkillVersions: vi.fn(), fetchReviewQueueSuggestion: vi.fn(), createReviewQueue: vi.fn(), navigate: vi.fn() }));
const versions = [{ id: "v2", skillId: "skill", version: "0.2.0", criterionVersionId: "cv2" }, { id: "v1", skillId: "skill", version: "0.1.0", criterionVersionId: "cv1" }];
vi.mock("@/lib/api", () => api);
vi.mock("@/components/review-evaluator-picker", async () => import("../src/components/review-evaluator-picker.js"));
vi.mock("@/lib/criterion-scope", async () => import("../src/lib/criterion-scope.js"));
vi.mock("@/lib/utils", async () => import("../src/lib/utils.js"));
vi.mock("@/lib/dashboard-context", () => ({ useDashboard: () => ({ dashboard: { skill: { id: "skill", currentVersion: versions[0] } } }) }));
vi.mock("@/lib/journey", () => ({ journeyStage: () => "production" }));
vi.mock("react-router-dom", () => ({ useNavigate: () => api.navigate }));
vi.mock("@/hooks/use-dialog-focus", () => ({ useDialogFocus: () => ({ current: null }) }));
vi.mock("@/components/row-action", () => ({ RowLink: ({ children }: any) => createElement("span", null, children) }));
vi.mock("@/components/ui/card", () => Object.fromEntries(["Card", "CardHeader", "CardTitle", "CardDescription", "CardContent", "CardFooter"].map(name => [name, ({ children, ...props }: any) => createElement("div", props, children)])));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, variant, size, ...props }: any) => createElement("button", props, children) }));
vi.mock("@/components/rubrist", () => ({ Eyebrow: ({ children }: any) => createElement("span", null, children), SectionHead: ({ title, right }: any) => createElement("header", null, title, right) }));
const { ReviewQueuesScreen } = await import("../src/screens/review-queues.js");
const suggestion = { method: "review-priority/v1", skillVersionId: "v2", criterionVersionId: "cv2", seed: "seed", consideredCount: 6, capped: false, items: [
  { caseId: "case_fail", judgeRunId: "run_fail", reason: "flagged" }, { caseId: "case_pass", judgeRunId: "run_pass", reason: "spot_check" }
] };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  api.fetchReviewQueues.mockResolvedValue([]); api.fetchSkillVersions.mockResolvedValue(versions);
  api.fetchReviewQueueSuggestion.mockResolvedValue(suggestion); api.createReviewQueue.mockResolvedValue({ id: "queue" });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
function button(label: string) { return [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === label)!; }
async function click(label: string) { await act(async () => button(label).click()); }
async function mount() { await act(async () => root.render(createElement(ReviewQueuesScreen))); await click("New queue"); }
it("previews selection reasons, hides duplicate IDs, and submits the exact previewed results", async () => {
  await mount(); await click("Suggest 10 cases");
  expect(api.fetchReviewQueueSuggestion).toHaveBeenCalledWith("v2");
  expect(container.textContent).toContain("Evaluator flagged"); expect(container.textContent).toContain("Passing spot check");
  expect(container.textContent).toContain("Saves the exact results shown");
  expect(container.querySelector("details")!.open).toBe(false);
  await click("Create queue");
  expect(api.createReviewQueue).toHaveBeenCalledWith({ name: "Suggested review", skillVersionId: "v2", criterionVersionId: "cv2", caseIds: ["case_fail", "case_pass"], judgeRunIds: { case_fail: "run_fail", case_pass: "run_pass" } });
  expect(api.navigate).toHaveBeenCalledWith("/review-queues/queue");
});
it("drops stale suggestions when the selected evaluator changes", async () => {
  let resolve!: (value: unknown) => void;
  api.fetchReviewQueueSuggestion.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await mount(); await click("Suggest 10 cases");
  expect(button("Create queue").disabled).toBe(true);
  const select = container.querySelector("select")!;
  await act(async () => { select.value = "v1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => resolve(suggestion));
  expect(container.textContent).not.toContain("Passing spot check");
  expect((container.querySelector("#new-queue-case-ids") as HTMLTextAreaElement).value).toBe("");
  expect(button("Create queue").disabled).toBe(true);
});
it("clears suggestion pins when an owner edits case IDs and keeps an empty suggestion unsaveable", async () => {
  await mount(); await click("Suggest 10 cases");
  const ids = container.querySelector<HTMLTextAreaElement>("#new-queue-case-ids")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ids, "manual_case");
    ids.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Create queue");
  expect(api.createReviewQueue).toHaveBeenCalledWith({ name: "Suggested review", skillVersionId: "v2", criterionVersionId: "cv2", caseIds: ["manual_case"] });
  await click("New queue");
  api.fetchReviewQueueSuggestion.mockResolvedValueOnce({ ...suggestion, consideredCount: 0, items: [] });
  await click("Suggest 10 cases");
  expect(button("Create queue").disabled).toBe(true);
  expect(container.textContent).toContain("No eligible results");
});
