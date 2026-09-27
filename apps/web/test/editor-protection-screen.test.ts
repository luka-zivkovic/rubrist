import { JSDOM } from "jsdom";
import { act, createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill, SkillVersion } from "@rubrist/shared";

// Exercise the editor state with a real data router and controlled provider reads.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Event", "Node", "localStorage"] as const) {
  vi.stubGlobal(name, (dom.window as unknown as Record<string, unknown>)[name]);
}
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router-dom");

const api = vi.hoisted(() => ({
  fetchLatestSkill: vi.fn(),
  fetchSkillVersions: vi.fn(),
  fetchSkillVersionRegression: vi.fn(),
  fetchJudgeProviders: vi.fn(),
  fetchJudgeModels: vi.fn(),
  fetchDatasetRevisionMetadata: vi.fn(),
  fetchOnboardingEvidenceInventory: vi.fn(),
  fetchSkillVersionCriterion: vi.fn(),
  createSkillVersion: vi.fn(),
  createOnboardingCheck: vi.fn()
}));
const criterion = vi.hoisted(() => ({
  selectedCriterionId: "criterion_1" as string | null,
  selectedChoice: null,
  loading: false,
  href: (pathname: string) => pathname
}));

type Props = Record<string, unknown> & { children?: ReactNode };

vi.mock("@/lib/api", () => api);
vi.mock("@/lib/criterion-context", () => ({ useCriterion: () => criterion }));
// Stable across renders, like the real context: the editor's poll depends on it.
const dashboard = vi.hoisted(() => ({ dashboard: { viewerRole: "owner", goldenSetSize: 0, project: { importedTraceCount: 0 } }, refresh: () => undefined }));
vi.mock("@/lib/dashboard-context", () => ({ useDashboard: () => dashboard }));
vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ")
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: Props) =>
    createElement("button", { type: "button", ...props }, children)
}));
vi.mock("@/components/rubrist", async () => {
  const { PageLoadError } = await import("../src/components/rubrist/load-error.js");
  return {
    PageLoadError,
    SectionHead: ({ title, sub }: Props) => createElement("header", null, title as ReactNode, sub as ReactNode)
  };
});
vi.mock("@/lib/load-error", async () => import("../src/lib/load-error.js"));
vi.mock("@/lib/skill-edit-flow", async () => import("../src/lib/skill-edit-flow.js"));
vi.mock("@/lib/criterion-scope", async () => import("../src/lib/criterion-scope.js"));
vi.mock("@/lib/execution-binding-draft", async () => import("../src/lib/execution-binding-draft.js"));
vi.mock("@/lib/judge-provider-selection", async () => import("../src/lib/judge-provider-selection.js"));
vi.mock("@/lib/journey", async () => import("../src/lib/journey.js"));
vi.mock("@/lib/onboarding-check", async () => import("../src/lib/onboarding-check.js"));
vi.mock("@/lib/starter-skills", async () => import("../src/lib/starter-skills.js"));
vi.mock("@/components/first-run-check-setup", () => ({ FirstRunCheckSetup: () => createElement("section") }));
vi.mock("@/components/skill-edit-flow", () => ({ SkillEditFlow: () => createElement("section") }));
vi.mock("../src/screens/skill-edit/editor.js", () => ({
  SkillVersionEditor: (props: any) => {
    lastEditor = props;
    return createElement("section", null,
      createElement("textarea", { "aria-label": "Rubric", value: props.rubric, onChange: (event: any) => props.setRubric(event.target.value) }),
      createElement("button", { onClick: () => props.navigate("/skill/versions") }, "History"),
      createElement("button", { onClick: props.resetToCurrent }, "Reset"),
      createElement("button", { onClick: () => props.applyStarter({ rubricMarkdown: "Template", prompt: "Prompt", verdictKind: "binary" }) }, "Template"),
      createElement("button", { onClick: () => props.submit(), disabled: !props.canSave }, "Save")
    );
  }
}));
// Stable across renders, like the real hook's callbacks: the editor's effects
// depend on them.
const picker = vi.hoisted(() => ({
  load: () => undefined,
  savedFields: (temperature: string) => ({ temperature }),
  guidance: { temperature: { shown: false } },
  blockingProblems: []
}));
vi.mock("../src/screens/skill-edit/binding-settings.js", () => ({ useBindingPicker: () => picker }));
vi.mock("../src/screens/skill-edit/regression.js", () => ({
  GovernedEvaluatorEditBoundary: () => createElement("section"),
  RegressionResult: ({ onBackToEdit }: { onBackToEdit: () => void }) => createElement("button", { onClick: onBackToEdit }, "Back to edit"),
  RegressionRunning: () => createElement("section")
}));

let lastEditor: any;
const { SkillEditScreen } = await import("../src/screens/skill-edit.js");

function version(id: string, number: string, overrides: Partial<SkillVersion> = {}): SkillVersion {
  return {
    id,
    skillId: "skill_1",
    criterionVersionId: "criterionv_1",
    version: number,
    status: "approved",
    rubricMarkdown: `# Guide ${number}\n\nPass when grounded.`,
    prompt: "Judge against {{rubric_markdown}}.",
    typedQuestion: null,
    decisionThreshold: null,
    executionBinding: { provider: "mock", endpoint: { kind: "managed" }, modelId: "mock", modelVersion: "mock", sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null, verdictProtocol: "mock/v1", routing: null },
    customEndpointUrl: null,
    outputSchema: { type: "object" },
    goldenSetAgreement: 1,
    tooStrictCount: 0,
    tooLenientCount: 0,
    ambiguousCount: 0,
    knownLimitations: [],
    verdictKind: "binary",
    scalarRange: null,
    categoricalChoiceScores: null,
    rubricProvenance: "human-authored",
    regressionDatasetRevisionId: "revision_1",
    createdAt: `2026-09-0${number.split(".")[2] ?? "1"}T00:00:00.000Z`,
    approvedAt: `2026-09-0${number.split(".")[2] ?? "1"}T00:01:00.000Z`,
    ...overrides
  };
}

function skillWith(current: SkillVersion): Skill {
  return {
    id: "skill_1",
    projectId: "proj_1",
    criterionId: "criterion_1",
    name: "Support answer quality",
    description: "Judges support answers.",
    ownerName: "Owner",
    status: "production",
    isStarter: false,
    currentVersion: current
  };
}


let container: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  for (const mock of Object.values(api)) mock.mockReset();
  dashboard.dashboard.viewerRole = "owner";
  lastEditor = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  api.fetchLatestSkill.mockResolvedValue(skillWith(version("v1", "1.0.1")));
  api.fetchJudgeProviders.mockResolvedValue({ providers: [{ provider: "mock", available: true, label: "Mock" }] });
  api.fetchJudgeModels.mockResolvedValue({ models: [{ id: "mock", version: "mock" }] });
  api.fetchDatasetRevisionMetadata.mockResolvedValue({ itemCount: 1 });
});
afterEach(() => { act(() => root.unmount()); container.remove(); router.dispose(); vi.restoreAllMocks(); });
afterAll(() => vi.unstubAllGlobals());
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function renderEditor() {
  router = createMemoryRouter([
    { path: "/skill/edit", element: createElement(SkillEditScreen) },
    { path: "/skill/versions", element: createElement("p", null, "Version history") },
    { path: "/skill", element: createElement("p", null, "Saved evaluator") }
  ], { initialEntries: ["/skill/edit"] });
  await act(async () => root.render(createElement(RouterProvider, { router })));
  await settle();
}
const click = async (label: string) => {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
  await act(async () => button.click());
  await settle();
};
const change = async (field: string, value: unknown) => {
  await act(async () => lastEditor[field](value));
};

describe("editor protects author choices and work", () => {
  it("freezes the entire draft while save is pending, including template actions", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderEditor();
    await change("setRubric", "Submitted guide");
    let finishSave: (result: unknown) => void = () => undefined;
    api.createSkillVersion.mockReturnValueOnce(new Promise((resolve) => { finishSave = resolve; }));
    await click("Save");
    expect(lastEditor.submitting).toBe(true);
    expect(container.querySelector("textarea")?.matches(":disabled")).toBe(true);
    const template = [...container.querySelectorAll("button")].find((button) => button.textContent === "Template")!;
    expect(template.matches(":disabled")).toBe(true);
    await act(async () => template.click());
    expect(lastEditor.rubric).toBe("Submitted guide");
    // App-level navigation still protects the unsaved request while it waits.
    await act(async () => { await router.navigate("/skill/versions"); });
    expect(router.state.location.pathname).toBe("/skill/edit");
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockClear();
    const saved = version("v2", "1.0.2", { rubricMarkdown: "Submitted guide" });
    const run = { status: "passed", compared: 0 };
    api.fetchSkillVersions.mockResolvedValue([saved, version("v1", "1.0.1")]);
    api.fetchSkillVersionRegression.mockResolvedValue(run);
    await act(async () => finishSave({ state: "complete", version: saved, regressionRun: run, blocked: false }));
    await settle();
    expect(router.state.location.search).toContain("version=v2");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("returns from a recorded blocked result to editing without a false discard prompt", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderEditor();
    await change("setRubric", "Blocked guide");
    const saved = version("v2", "1.0.2", { rubricMarkdown: "Blocked guide" });
    const run = { status: "blocked", compared: 1 };
    api.fetchLatestSkill.mockResolvedValue(skillWith(saved));
    api.createSkillVersion.mockResolvedValueOnce({ state: "complete", version: saved, regressionRun: run, blocked: true });
    api.fetchSkillVersions.mockResolvedValue([saved, version("v1", "1.0.1")]);
    api.fetchSkillVersionRegression.mockResolvedValue(run);
    await click("Save");
    await click("Back to edit");
    expect(confirm).not.toHaveBeenCalled();
    expect(router.state.location.search).not.toContain("version=");
    expect(lastEditor.rubric).toBe("Blocked guide");
    expect(container.querySelector("textarea")?.matches(":disabled")).toBe(false);
    await click("History");
    expect(router.state.location.pathname).toBe("/skill/versions");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps a failed save dirty and only clears the warning after a recorded save", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderEditor();
    await change("setRubric", "Updated guide");
    api.createSkillVersion.mockRejectedValueOnce(new Error("Save unavailable"));
    await click("Save");
    expect(lastEditor.rubric).toBe("Updated guide");
    expect(lastEditor.submitError).toBe("Save unavailable");
    await click("History");
    expect(router.state.location.pathname).toBe("/skill/edit");
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockClear();
    const saved = version("v2", "1.0.2", { rubricMarkdown: "Updated guide" });
    const run = { status: "passed", compared: 0 };
    api.createSkillVersion.mockResolvedValueOnce({ state: "complete", version: saved, regressionRun: run, blocked: false });
    api.fetchSkillVersions.mockResolvedValue([saved, version("v1", "1.0.1")]);
    api.fetchSkillVersionRegression.mockResolvedValue(run);
    await click("Save");
    expect(router.state.location.search).toContain("version=v2");
    expect(confirm).not.toHaveBeenCalled();
    const reload = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(reload);
    expect(reload.defaultPrevented).toBe(false);
  });

  it("keeps an unavailable stored provider, model version and endpoint, and blocks saving", async () => {
    const v = version("v1", "1.0.1");
    v.executionBinding = { ...v.executionBinding, provider: "custom", endpoint: { kind: "custom", baseUrl: "https://example.test/v1" }, modelId: "private-model", modelVersion: "pin-42", verdictProtocol: "openai-chat/structured-output/v1" as any };
    v.customEndpointUrl = "https://example.test/v1";
    api.fetchLatestSkill.mockResolvedValue(skillWith(v));
    await renderEditor();
    expect(lastEditor.provider).toBe("custom");
    expect(lastEditor.modelId).toBe("private-model");
    expect(lastEditor.modelVersion).toBe("pin-42");
    expect(lastEditor.baseUrl).toBe("https://example.test/v1");
    expect(lastEditor.canSave).toBe(false);
    expect(api.fetchJudgeModels).not.toHaveBeenCalled();
    await click("Reset");
    expect(lastEditor.provider).toBe("custom");
    expect(lastEditor.modelVersion).toBe("pin-42");
  });

  it.each(["changed", "empty", "error"])("preserves a loaded pin through a %s catalog", async (catalog) => {
    const v = version("v1", "1.0.1");
    v.executionBinding.modelVersion = "saved-pin";
    if (catalog === "error") api.fetchJudgeModels.mockRejectedValue(new Error("Offline"));
    else api.fetchJudgeModels.mockResolvedValue({ models: catalog === "empty" ? [] : [{ id: "mock", version: "new-catalog-pin" }] });
    api.fetchLatestSkill.mockResolvedValue(skillWith(v));
    await renderEditor();
    expect(lastEditor.modelId).toBe("mock");
    expect(lastEditor.modelVersion).toBe("saved-pin");
  });

  it("never picks a model automatically after the author changes provider", async () => {
    api.fetchJudgeProviders.mockResolvedValue({ providers: [{ provider: "mock", available: true }, { provider: "openai", available: true }] });
    await renderEditor();
    await act(async () => { lastEditor.setProvider("openai"); lastEditor.setModelId(""); lastEditor.setModelVersion(""); });
    await settle();
    expect(lastEditor.modelId).toBe("");
    expect(lastEditor.canSave).toBe(false);
  });

  it("blocks direct editing by a member before they enter unsaveable work", async () => {
    dashboard.dashboard.viewerRole = "member";
    await renderEditor();
    expect(lastEditor).toBeNull();
    expect(container.textContent).toContain("Only an owner can save a new version. Ask Owner.");
    await click("View evaluator");
    expect(router.state.location.pathname).toBe("/skill");
    expect(api.createSkillVersion).not.toHaveBeenCalled();
  });

  it("protects navigation, reset, and template replacement while allowing an explicit discard", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderEditor();
    await change("setRubric", "Unsaved work");
    await click("History");
    expect(router.state.location.pathname).toBe("/skill/edit");
    await click("Reset");
    await click("Template");
    expect(lastEditor.rubric).toBe("Unsaved work");
    expect(confirm).toHaveBeenCalledTimes(3);
    confirm.mockReturnValue(true);
    await click("Template");
    expect(lastEditor.rubric).toBe("Template");
    await click("History");
    expect(router.state.location.pathname).toBe("/skill/versions");
  });

  it("guards reload for invalid raw input and becomes clean again when the edit is reverted", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderEditor();
    const original = lastEditor.temperature;
    await change("setTemperature", "invalid");
    const reload = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(reload);
    expect(reload.defaultPrevented).toBe(true);
    await change("setTemperature", original);
    const cleanReload = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanReload);
    expect(cleanReload.defaultPrevented).toBe(false);
    await click("History");
    expect(router.state.location.pathname).toBe("/skill/versions");
    expect(confirm).not.toHaveBeenCalled();
  });
});
