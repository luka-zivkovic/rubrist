import { JSDOM } from "jsdom";
import { act, createElement, Fragment, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegressionRunResult, SelfConsistencyReport, Skill, SkillVersion } from "@rubrist/shared";

// PRODUCT.md principle 2 on the evaluator pages: a failed read never reads as
// empty, zero, not found, or clean. The screens import app aliases (`@/...`)
// that only the node transform lets these mocks replace, so this test runs in
// node with a jsdom window installed as globals before React DOM loads.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Event", "Node", "localStorage"] as const) {
  vi.stubGlobal(name, (dom.window as unknown as Record<string, unknown>)[name]);
}
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider, useNavigate } = await import("react-router-dom");

const api = vi.hoisted(() => ({
  fetchCurrentSkill: vi.fn(),
  fetchLatestSkill: vi.fn(),
  fetchSkillVersions: vi.fn(),
  fetchSkillVersionHistory: vi.fn(),
  fetchSkillVersionRegression: vi.fn(),
  fetchSkillVersionConvergence: vi.fn(),
  fetchSkillVersionSelfConsistency: vi.fn(),
  fetchJudgeCard: vi.fn(),
  fetchJudgeCardMarkdown: vi.fn(),
  fetchSkillFormat: vi.fn(),
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
const box = (tag: string) => ({ children }: Props) => createElement(tag, null, children);

vi.mock("@/lib/api", () => api);
vi.mock("@/lib/criterion-context", () => ({ useCriterion: () => criterion }));
// Stable across renders, like the real context: the editor's poll depends on it.
const dashboard = vi.hoisted(() => ({ dashboard: null, refresh: () => undefined }));
vi.mock("@/lib/dashboard-context", () => ({ useDashboard: () => dashboard }));
vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ")
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: Props) =>
    createElement("button", { type: "button", ...props }, children)
}));
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, variant }: Props) => createElement("span", { "data-variant": variant }, children)
}));
vi.mock("@/components/ui/card", () => ({
  Card: box("div"),
  CardContent: box("div"),
  CardHeader: box("div"),
  CardTitle: box("h2"),
  CardDescription: box("p")
}));
vi.mock("@/components/ui/table", () => ({ Table: box("table") }));
vi.mock("@/components/row-action", () => ({
  RowLink: ({ children, to }: Props) => createElement("a", { href: to }, children)
}));
vi.mock("@/components/markdown-preview", () => ({
  MarkdownPreview: ({ markdown }: Props) => createElement("div", null, markdown as string)
}));
vi.mock("@/components/binding-resolution-status", () => ({ BindingResolutionStatus: () => createElement("section") }));
vi.mock("@/components/typed-question-view", () => ({ TypedQuestionView: () => createElement("section") }));
vi.mock("@/components/rubrist", async () => {
  const loadError = await import("../src/components/rubrist/load-error.js");
  const gate = await import("../src/components/rubrist/gate.js");
  return {
    Chip: box("span"),
    Eyebrow: box("div"),
    KPIRow: box("div"),
    MarginNote: box("aside"),
    LabelChip: ({ label }: Props) => createElement("span", null, label as string),
    Ref: ({ label }: Props) => createElement("span", null, label as string),
    RegressionDiffTable: ({ title }: Props) => createElement("section", null, title as string),
    ConvergenceCard: () => createElement("section", null, "Convergence audit"),
    KPI: ({ label, num, unit, delta, foot }: Props) =>
      createElement("div", { "data-kpi": label }, `${label}: ${num}${unit ?? ""} | ${delta ?? ""} | ${foot ?? ""}`),
    SectionHead: ({ eyebrow, title, sub, right }: Props) =>
      createElement("header", null, createElement("div", null, eyebrow as ReactNode), createElement("h1", null, title as ReactNode), sub as ReactNode, right as ReactNode),
    GateChip: gate.GateChip,
    gateStateForVersion: gate.gateStateForVersion,
    PageLoadError: loadError.PageLoadError,
    SectionLoadError: loadError.SectionLoadError,
    SectionLoading: loadError.SectionLoading
  };
});
vi.mock("@/lib/load-error", async () => import("../src/lib/load-error.js"));
vi.mock("@/lib/regression-gate", async () => import("../src/lib/regression-gate.js"));
vi.mock("@/lib/compare-chain", async () => import("../src/lib/compare-chain.js"));
vi.mock("@/hooks/use-section-read", async () => import("../src/hooks/use-section-read.js"));
vi.mock("@/lib/skill-edit-flow", async () => import("../src/lib/skill-edit-flow.js"));
vi.mock("@/lib/verdict-kind", async () => import("../src/lib/verdict-kind.js"));
vi.mock("@/lib/criterion-scope", async () => import("../src/lib/criterion-scope.js"));
vi.mock("@/lib/execution-binding-draft", async () => import("../src/lib/execution-binding-draft.js"));
vi.mock("@/lib/judge-provider-selection", async () => import("../src/lib/judge-provider-selection.js"));
vi.mock("@/lib/journey", async () => import("../src/lib/journey.js"));
vi.mock("@/lib/onboarding-check", async () => import("../src/lib/onboarding-check.js"));
vi.mock("@/lib/starter-skills", async () => import("../src/lib/starter-skills.js"));
vi.mock("@/components/first-run-check-setup", () => ({ FirstRunCheckSetup: () => createElement("section") }));
vi.mock("@/components/skill-edit-flow", () => ({ SkillEditFlow: () => createElement("section") }));
vi.mock("../src/screens/skill-edit/editor.js", () => ({
  SkillVersionEditor: () => createElement("section", null, "Evaluator editor")
}));
// Stable across renders, like the real hook's callbacks: the editor's effects
// depend on them.
const picker = vi.hoisted(() => ({
  load: () => undefined,
  savedFields: () => ({}),
  guidance: { temperature: { shown: false } },
  blockingProblems: []
}));
vi.mock("../src/screens/skill-edit/binding-settings.js", () => ({ useBindingPicker: () => picker }));
vi.mock("../src/screens/skill-edit/regression.js", () => ({
  GovernedEvaluatorEditBoundary: () => createElement("section"),
  RegressionResult: () => createElement("section"),
  RegressionRunning: ({ referenceCount, referenceCountUnavailable, pollError }: Props) => {
    const poll = pollError as { message: string; retryable: boolean } | null;
    return createElement("section", null,
      `count=${String(referenceCount)} unavailable=${String(referenceCountUnavailable)} poll=${poll ? `${poll.message} (${poll.retryable ? "retrying" : "stopped"})` : "none"}`);
  }
}));

const { ApiError } = await import("../src/lib/api/transport.js");
const { SkillVersionDetailScreen, SkillVersionsScreen } = await import("../src/screens/skill-versions.js");
const { CompareVersionsScreen } = await import("../src/screens/compare-versions.js");
const { SkillScreen } = await import("../src/screens/skill.js");
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

function run(skillVersionId: string, overrides: Partial<RegressionRunResult> = {}): RegressionRunResult {
  return {
    id: `run_${skillVersionId}`,
    skillVersionId,
    datasetRevisionId: "revision_1",
    status: "passed",
    compared: 5,
    regressed: 0,
    improved: 0,
    flipped: 0,
    goldenSetMissing: false,
    cases: [{ caseId: `case_${skillVersionId}`, traceId: "trace_1", agreedLabel: "pass", newLabel: "pass", change: "agree", rationale: null }],
    createdAt: "2026-09-01T00:00:30.000Z",
    ...overrides
  };
}

const emptyConsistency = (skillVersionId: string): SelfConsistencyReport => ({
  skillVersionId,
  comparedCases: 0,
  consistentCases: 0,
  meanAgreement: null,
  cases: []
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const mock of Object.values(api)) mock.mockReset();
  criterion.selectedCriterionId = "criterion_1";
  api.fetchLatestSkill.mockResolvedValue(skillWith(version("skillv_2", "1.0.2")));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

// Navigates inside the rendered router, so a route param changes in place.
let navigateTo: (path: string) => void = () => undefined;
function Navigator() {
  navigateTo = useNavigate();
  return null;
}

async function render(path: string, routePath: string, screen: () => ReactNode) {
  await act(async () => {
    const router = createMemoryRouter([{ path: routePath, element: createElement(Fragment, null, createElement(Navigator), screen()) }], { initialEntries: [path] });
    root.render(createElement(RouterProvider, { router }));
  });
  await settle();
}

async function settle() {
  for (let tick = 0; tick < 8; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const text = () => container.textContent ?? "";
const buttons = (label: string) => [...container.querySelectorAll("button")].filter((button) => button.textContent?.includes(label));

describe("version page", () => {
  const current = version("skillv_2", "1.0.2");

  function readsSucceed() {
    api.fetchCurrentSkill.mockResolvedValue(skillWith(current));
    api.fetchSkillVersions.mockResolvedValue([current, version("skillv_1", "1.0.1")]);
    api.fetchSkillVersionRegression.mockResolvedValue(null);
    api.fetchSkillVersionConvergence.mockResolvedValue({ audit: null });
    api.fetchSkillVersionSelfConsistency.mockResolvedValue(emptyConsistency(current.id));
    api.fetchJudgeCard.mockRejectedValue(new ApiError("Judge Card not available", 404));
  }

  it("identifies the exact selected default separately from recorded approval", async () => {
    readsSucceed();
    await render("/skill/versions/skillv_1", "/skill/versions/:id", () => createElement(SkillVersionDetailScreen));
    expect(text()).toContain("This saved version is not the default.");
    expect(text()).toContain("Current default: v1.0.2");
    expect(text()).toContain("Recorded status: approved");
    expect(text()).not.toContain("Approved ");
  });

  it("keeps governed candidate history visible without an eligible default", async () => {
    readsSucceed();
    const candidate = version("skillv_2", "1.0.2", { status: "calibrating" });
    api.fetchLatestSkill.mockResolvedValue(skillWith(candidate));
    api.fetchSkillVersions.mockResolvedValue([candidate]);
    api.fetchCurrentSkill.mockRejectedValue(new ApiError("No evaluator exists", 404, { code: "no_current_evaluator" }));
    await render("/skill/versions/skillv_2", "/skill/versions/:id", () => createElement(SkillVersionDetailScreen));
    expect(text()).toContain("No current default");
    expect(text()).toContain("Guide 1.0.2");
    expect(text()).not.toContain("Couldn't load this version");
  });

  it.each([503, 404])("keeps an unreadable default distinct from no default (%i)", async (status) => {
    readsSucceed();
    api.fetchCurrentSkill.mockRejectedValue(new ApiError("Default read unavailable", status));
    await render("/skill/versions/skillv_2", "/skill/versions/:id", () => createElement(SkillVersionDetailScreen));
    expect(text()).toContain("Couldn't load the current default.");
    expect(text()).toContain("Guide 1.0.2");
    expect(text()).not.toContain("No current default");
  });

  it("does not present zero compared cases as a passed check", async () => {
    readsSucceed();
    api.fetchSkillVersionRegression.mockResolvedValue(run(current.id, { compared: 0, cases: [] }));
    await render("/skill/versions/skillv_2", "/skill/versions/:id", () => createElement(SkillVersionDetailScreen));
    expect(text()).toContain("Current default: v1.0.2");
    expect(text()).toContain("regression · no comparison");
    expect(text()).toContain("0 reference cases compared");
    expect(text()).not.toContain("regression · clean");
  });

  it("keeps the version readable when one evidence read fails, and retries only that section", async () => {
    readsSucceed();
    let finishRetry: (report: SelfConsistencyReport) => void = () => undefined;
    api.fetchSkillVersionSelfConsistency
      .mockRejectedValueOnce(new ApiError("Self-consistency request failed: 503", 503))
      .mockReturnValueOnce(new Promise<SelfConsistencyReport>((resolve) => {
        finishRetry = resolve;
      }));

    await render("/skill/versions/skillv_2", "/skill/versions/:id", () => createElement(SkillVersionDetailScreen));

    expect(text()).toContain("Guide 1.0.2");
    expect(text()).toContain("regression · not recorded");
    expect(text()).toContain("Couldn't load self-consistency.");
    expect(text()).toContain("Self-consistency request failed: 503");
    // A refused read offers no Retry: retrying fails the same way.
    expect(text()).toContain("Couldn't load the Judge Card.");
    expect(buttons("Retry")).toHaveLength(1);
    expect(text()).not.toContain("Version not found");

    await act(async () => buttons("Retry")[0]!.click());
    await settle();
    // While the retry is in flight, the section keeps its error and the page
    // keeps its content.
    expect(text()).toContain("Retrying…");
    expect(text()).toContain("Couldn't load self-consistency.");
    expect(text()).toContain("Guide 1.0.2");
    expect(text()).not.toContain("Loading version");

    await act(async () => finishRetry(emptyConsistency(current.id)));
    await settle();

    expect(text()).toContain("No repeat runs under this version yet.");
    expect(text()).not.toContain("Couldn't load self-consistency.");
    expect(text()).toContain("Guide 1.0.2");
    expect(api.fetchCurrentSkill).toHaveBeenCalledTimes(1);
    expect(api.fetchSkillVersionSelfConsistency).toHaveBeenCalledTimes(2);
    expect(api.fetchSkillVersionRegression).toHaveBeenCalledTimes(1);
  });

  it("never reads a version the page hasn't loaded yet as not found", async () => {
    readsSucceed();
    const created = version("skillv_3", "1.0.3");
    api.fetchSkillVersions
      .mockResolvedValueOnce([current, version("skillv_1", "1.0.1")])
      .mockResolvedValue([created, current, version("skillv_1", "1.0.1")]);
    await render("/skill/versions/skillv_2", "/skill/versions/:id", () => createElement(SkillVersionDetailScreen));
    expect(text()).toContain("Guide 1.0.2");

    // Every rendered state, including ones replaced before the next check.
    let sawNotFound = false;
    const observer = new dom.window.MutationObserver((records) => {
      for (const record of records) {
        const texts = [...record.addedNodes].map((node) => node.textContent ?? "");
        if (record.type === "characterData") texts.push(record.oldValue ?? "", record.target.textContent ?? "");
        if (texts.some((value) => value.includes("Version not found"))) sawNotFound = true;
      }
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
    await act(async () => navigateTo("/skill/versions/skillv_3"));
    await settle();
    observer.disconnect();

    expect(sawNotFound).toBe(false);
    expect(text()).toContain("Guide 1.0.3");
  });

  it("shows the version while slow sections say they are loading", async () => {
    readsSucceed();
    const pending = () => new Promise<never>(() => undefined);
    api.fetchSkillVersionRegression.mockReturnValue(pending());
    api.fetchJudgeCard.mockReturnValue(pending());
    api.fetchSkillVersionSelfConsistency.mockReturnValue(pending());

    await render("/skill/versions/skillv_2", "/skill/versions/:id", () => createElement(SkillVersionDetailScreen));

    expect(text()).toContain("Guide 1.0.2");
    expect(text()).not.toContain("Loading version");
    expect(text()).toContain("regression · loading");
    expect(text()).toContain("Loading the Judge Card…");
    expect(text()).toContain("Loading the regression run…");
    expect(text()).toContain("Loading self-consistency…");
    // A section still loading never reads as empty.
    expect(text()).not.toContain("No repeat runs under this version yet.");
    expect(text()).not.toContain("regression · not recorded");
  });

  it("shows unmeasured disagreement counts as unknown", async () => {
    readsSucceed();
    const unmeasured = version("skillv_2", "1.0.2", { goldenSetAgreement: null });
    api.fetchCurrentSkill.mockResolvedValue(skillWith(unmeasured));
    api.fetchSkillVersions.mockResolvedValue([unmeasured]);

    await render("/skill/versions/skillv_2", "/skill/versions/:id", () => createElement(SkillVersionDetailScreen));

    expect(text()).toContain("Too strict—");
    expect(text()).toContain("Too lenient—");
    expect(text()).toContain("Ambiguous—");
  });

  it("reads a run that couldn't be loaded as unavailable, never as not recorded or clean", async () => {
    readsSucceed();
    api.fetchSkillVersionRegression.mockRejectedValue(new ApiError("Regression run request failed: 500", 500));

    await render("/skill/versions/skillv_2", "/skill/versions/:id", () => createElement(SkillVersionDetailScreen));

    expect(text()).toContain("regression · unavailable");
    expect(text()).toContain("Couldn't load the regression run.");
    expect(text()).not.toContain("regression · not recorded");
    expect(text()).not.toContain("regression · clean");
  });

  it("shows a failed page read as an error with Retry, and a missing version as not found", async () => {
    readsSucceed();
    api.fetchSkillVersions.mockRejectedValueOnce(new ApiError("Skill versions request failed: 500", 500));

    await render("/skill/versions/skillv_9", "/skill/versions/:id", () => createElement(SkillVersionDetailScreen));

    expect(text()).toContain("Couldn't load this version");
    expect(text()).toContain("Skill versions request failed: 500");
    expect(text()).not.toContain("Version not found");

    await act(async () => buttons("Retry")[0]!.click());
    await settle();

    expect(text()).toContain("Version not found");
    expect(text()).not.toContain("Couldn't load this version");
  });
});

describe("skill page", () => {
  it("shows unmeasured counts as unknown", async () => {
    api.fetchCurrentSkill.mockResolvedValue(skillWith(version("skillv_2", "1.0.2", { goldenSetAgreement: null })));

    await render("/skill", "/skill", () => createElement(SkillScreen));

    expect(text()).toContain("Strict — · Lenient —");
  });

  it("offers a next step instead of Retry when retrying can't help", async () => {
    api.fetchCurrentSkill.mockRejectedValue(new ApiError("No evaluator exists for this criterion", 404));

    await render("/skill", "/skill", () => createElement(SkillScreen));

    expect(text()).toContain("Couldn't load the skill");
    expect(buttons("Retry")).toHaveLength(0);
    expect(buttons("Open criteria")).toHaveLength(1);
  });
});

describe("version history", () => {
  it("reads each version from its recorded run, and unmeasured counts as unknown", async () => {
    // A governed candidate stays calibrating after its run is recorded.
    const candidate = version("skillv_3", "1.0.3", { status: "calibrating", approvedAt: null });
    const newest = version("skillv_2", "1.0.2");
    const oldest = version("skillv_1", "1.0.1", { goldenSetAgreement: null });
    api.fetchCurrentSkill.mockResolvedValue(skillWith(newest));
    api.fetchSkillVersionHistory.mockResolvedValue({
      versions: [candidate, newest, oldest],
      regressionRuns: [run(candidate.id), run(newest.id)]
    });

    await render("/skill/versions", "/skill/versions", () => createElement(SkillVersionsScreen));

    const row = (label: string) => container.querySelector(`tbody tr:has(a[href="/skill/versions/${label}"])`);
    const cells = (label: string) => [...(row(label)?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent);
    expect(row("skillv_3")?.textContent).toContain("candidate");
    expect(row("skillv_3")?.textContent).toContain("regression · clean");
    expect(row("skillv_3")?.textContent).not.toContain("regression running");
    expect(row("skillv_2")?.textContent).toContain("regression · clean");
    expect(row("skillv_2")?.textContent).toContain("Current default");
    expect(row("skillv_1")?.textContent).toContain("Saved version");
    expect(row("skillv_1")?.textContent).toContain("regression · not recorded");
    // Agreement, strict, and lenient: stored zeros are not shown as results.
    expect(cells("skillv_1").slice(3, 6)).toEqual(["—", "—", "—"]);
  });

  it("polls quickly while a check runs, and slowly while only candidates remain", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const delays = () => intervals.mock.calls.map(([, delay]) => delay);
    const running = version("skillv_3", "1.0.3", { status: "calibrating", approvedAt: null });
    const newest = version("skillv_2", "1.0.2");
    api.fetchCurrentSkill.mockResolvedValue(skillWith(newest));

    api.fetchSkillVersionHistory.mockResolvedValue({ versions: [running, newest], regressionRuns: [] });
    await render("/skill/versions", "/skill/versions", () => createElement(SkillVersionsScreen));
    expect(delays()).toContain(3_000);

    // Once its run is recorded, a calibrating version is a governed candidate.
    act(() => root.unmount());
    intervals.mockClear();
    root = createRoot(container);
    api.fetchSkillVersionHistory.mockResolvedValue({ versions: [running, newest], regressionRuns: [run(running.id)] });
    await render("/skill/versions", "/skill/versions", () => createElement(SkillVersionsScreen));
    expect(delays()).not.toContain(3_000);
    expect(delays()).toContain(30_000);

    act(() => root.unmount());
    intervals.mockClear();
    root = createRoot(container);
    api.fetchSkillVersionHistory.mockResolvedValue({ versions: [newest], regressionRuns: [run(newest.id)] });
    await render("/skill/versions", "/skill/versions", () => createElement(SkillVersionsScreen));
    expect(delays()).not.toContain(3_000);
    expect(delays()).not.toContain(30_000);
  });
});

describe("run comparison", () => {
  const v1 = version("skillv_1", "1.0.1");
  const v2 = version("skillv_2", "1.0.2");
  const v3 = version("skillv_3", "1.0.3");
  const v4 = version("skillv_4", "1.0.4");

  function kpi(label: string) {
    return container.querySelector(`[data-kpi="${label}"]`)?.textContent ?? "";
  }

  it("keeps totals unknown and says why when a check failed or a run couldn't be loaded", async () => {
    api.fetchCurrentSkill.mockResolvedValue(skillWith(v4));
    api.fetchSkillVersions.mockResolvedValue([v4, v3, v2, v1]);
    let v2Reads = 0;
    api.fetchSkillVersionRegression.mockImplementation(async (_skillId: string, versionId: string) => {
      if (versionId === v4.id) return run(v4.id, { status: "overridden", regressed: 1, improved: 2, overrideReason: "known flake" });
      if (versionId === v3.id) return run(v3.id, { status: "error", compared: 0, error: "judge timed out", cases: [] });
      if (versionId === v1.id) return run(v1.id);
      v2Reads += 1;
      if (v2Reads === 1) throw new ApiError("Regression run request failed: 503", 503);
      return run(v2.id);
    });

    await render("/skill/compare?from=skillv_1&to=skillv_4", "/skill/compare", () => createElement(CompareVersionsScreen));

    expect(text()).toContain("3 saves between them · 2 with a recorded run · 1 couldn't be loaded");
    expect(kpi("Regressions across versions")).toContain("Regressions across versions: — | 1 save's run couldn't be loaded");
    expect(kpi("Improvements")).toContain("Improvements: — |");
    expect(text()).toContain("Regression check failed");
    expect(text()).toContain("Couldn't load this save's run");
    expect(text()).toContain("regression · unavailable");
    expect(text()).not.toContain("0 reference cases compared");
    // The failed check's stored zeros are not shown as counts.
    const failedCheckRow = [...container.querySelectorAll("tbody tr")].find((row) => row.textContent?.includes("v1.0.3"));
    const cells = [...(failedCheckRow?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent);
    expect(cells.slice(3, 5)).toEqual(["—", "—"]);

    await act(async () => buttons("Retry")[0]!.click());
    await settle();

    expect(kpi("Regressions across versions")).toContain("Regressions across versions: — | 1 save's regression check failed");
    expect(text()).not.toContain("Couldn't load this save's run");
    expect(buttons("Retry")).toHaveLength(0);
  });

  it("sums the path when every save's check compared reference cases", async () => {
    api.fetchCurrentSkill.mockResolvedValue(skillWith(v3));
    api.fetchSkillVersions.mockResolvedValue([v3, v2, v1]);
    api.fetchSkillVersionRegression.mockImplementation(async (_skillId: string, versionId: string) => {
      if (versionId === v3.id) return run(v3.id, { status: "overridden", regressed: 1, overrideReason: "accepted" });
      if (versionId === v2.id) return run(v2.id, { improved: 2 });
      return run(v1.id);
    });

    await render("/skill/compare?from=skillv_1&to=skillv_3", "/skill/compare", () => createElement(CompareVersionsScreen));

    expect(kpi("Regressions across versions")).toContain("Regressions across versions: 1 | changes against recorded labels");
    expect(kpi("Improvements")).toContain("Improvements: 2 | flips toward the label");
    // Equal agreement is unchanged, not improved.
    expect(kpi("Known-failure agreement")).toContain("100 → 100% | unchanged");
  });

  it("keeps improvements unknown when the starting version has no measured run", async () => {
    api.fetchCurrentSkill.mockResolvedValue(skillWith(v3));
    api.fetchSkillVersions.mockResolvedValue([v3, v2, v1]);
    api.fetchSkillVersionRegression.mockImplementation(async (_skillId: string, versionId: string) => {
      if (versionId === v3.id) return run(v3.id, { improved: 1 });
      if (versionId === v2.id) return run(v2.id, { improved: 2 });
      return null;
    });

    await render("/skill/compare?from=skillv_1&to=skillv_3", "/skill/compare", () => createElement(CompareVersionsScreen));

    // v1.0.2's improvements had no verdicts on v1.0.1 to be counted against.
    expect(kpi("Regressions across versions")).toContain("Regressions across versions: 0 | changes against recorded labels");
    expect(kpi("Improvements")).toContain("Improvements: — | v1.0.1 has no measured run to count improvements from");
  });

  it("keeps a failed read of the starting version's run a failure, with Retry", async () => {
    api.fetchCurrentSkill.mockResolvedValue(skillWith(v3));
    api.fetchSkillVersions.mockResolvedValue([v3, v2, v1]);
    api.fetchSkillVersionRegression.mockImplementation(async (_skillId: string, versionId: string) => {
      if (versionId === v1.id) throw new ApiError("Regression run request failed: 503", 503);
      return run(versionId, { improved: 1 });
    });

    await render("/skill/compare?from=skillv_1&to=skillv_3", "/skill/compare", () => createElement(CompareVersionsScreen));

    expect(kpi("Improvements")).toContain("Improvements: — | v1.0.1's run couldn't be loaded");
    expect(kpi("Improvements")).not.toContain("no measured run");
    expect(buttons("Retry")).toHaveLength(1);
  });

  it("doesn't count improvements across a change of criterion revision", async () => {
    const onNewRevision = version("skillv_2", "1.0.2", { criterionVersionId: "criterionv_2" });
    api.fetchCurrentSkill.mockResolvedValue(skillWith(onNewRevision));
    api.fetchSkillVersions.mockResolvedValue([onNewRevision, v1]);
    api.fetchSkillVersionRegression.mockImplementation(async (_skillId: string, versionId: string) => run(versionId));

    await render("/skill/compare?from=skillv_1&to=skillv_2", "/skill/compare", () => createElement(CompareVersionsScreen));

    expect(kpi("Improvements")).toContain("Improvements: — | v1.0.1 and v1.0.2 are on different criterion revisions");
    // The newest save's own card doesn't claim its improvements either.
    expect(text()).toContain("improvements not counted");
    expect(text()).not.toContain("0 improved");
  });

  it("never shows another pair's runs for the pair on screen", async () => {
    api.fetchCurrentSkill.mockResolvedValue(skillWith(v4));
    api.fetchSkillVersions.mockResolvedValue([v4, v3, v2, v1]);
    let finishNewPair: () => void = () => undefined;
    const newPairRead = new Promise<void>((resolve) => {
      finishNewPair = resolve;
    });
    api.fetchSkillVersionRegression.mockImplementation(async (_skillId: string, versionId: string) => {
      if (versionId === v4.id) await newPairRead;
      return run(versionId);
    });
    await render("/skill/compare?from=skillv_2&to=skillv_3", "/skill/compare", () => createElement(CompareVersionsScreen));
    expect(kpi("Saves between")).toContain("1 with a recorded run");

    await act(async () => navigateTo("/skill/compare?from=skillv_1&to=skillv_4"));
    await settle();

    // The v1.0.2 → v1.0.3 path's totals don't stand in for this one's.
    expect(kpi("Saves between")).toContain("Saves between: 3");
    expect(kpi("Saves between")).toContain("loading recorded runs");
    expect(text()).toContain("Loading recorded runs…");

    await act(async () => finishNewPair());
    await settle();
    expect(kpi("Saves between")).toContain("3 with a recorded run");
  });

  it("doesn't read the loading version list as nothing to compare", async () => {
    let resolveVersions: (value: SkillVersion[]) => void = () => undefined;
    api.fetchCurrentSkill.mockResolvedValue(skillWith(v1));
    api.fetchSkillVersions.mockReturnValue(new Promise<SkillVersion[]>((resolve) => {
      resolveVersions = resolve;
    }));

    await render("/skill/compare", "/skill/compare", () => createElement(CompareVersionsScreen));

    expect(text()).toContain("Loading versions");
    expect(text()).not.toContain("Nothing to compare yet");

    await act(async () => resolveVersions([v1]));
    await settle();

    expect(text()).toContain("Nothing to compare yet");
  });
});

describe("evaluator editor", () => {
  it("says a count is loading until its read settles, and stops polling on a refused read", async () => {
    const base = version("skillv_1", "1.0.1");
    const running = version("skillv_2", "1.0.2", { status: "calibrating", approvedAt: null, regressionDatasetRevisionId: "revision_2" });
    let finishCount: (metadata: { itemCount: number }) => void = () => undefined;
    api.fetchLatestSkill.mockResolvedValue(skillWith(base));
    api.fetchJudgeProviders.mockResolvedValue({ providers: [] });
    api.fetchJudgeModels.mockResolvedValue([]);
    api.fetchSkillVersions.mockResolvedValue([running, base]);
    api.fetchSkillVersionRegression
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new ApiError("Skill version not found", 404));
    api.fetchDatasetRevisionMetadata.mockReturnValue(new Promise((resolve) => {
      finishCount = resolve;
    }));

    const timers = vi.spyOn(globalThis, "setTimeout");

    await render("/skill/edit?criterion=criterion_1&version=skillv_2", "/skill/edit", () => createElement(SkillEditScreen));

    expect(text()).toContain("count=null unavailable=false");
    expect(text()).toContain("poll=Skill version not found (stopped)");
    // The refused read fails the same way every time, so no next poll is set.
    expect(timers.mock.calls.some(([, delay]) => delay === 2000)).toBe(false);
    timers.mockRestore();

    await act(async () => finishCount({ itemCount: 7 }));
    await settle();

    expect(text()).toContain("count=7 unavailable=false");
    expect(api.fetchDatasetRevisionMetadata).toHaveBeenCalledWith("revision_2");
  });

  it("says the count is unavailable when its read fails", async () => {
    const base = version("skillv_1", "1.0.1");
    const running = version("skillv_2", "1.0.2", { status: "calibrating", approvedAt: null, regressionDatasetRevisionId: "revision_2" });
    api.fetchLatestSkill.mockResolvedValue(skillWith(base));
    api.fetchJudgeProviders.mockResolvedValue({ providers: [] });
    api.fetchJudgeModels.mockResolvedValue([]);
    api.fetchSkillVersions.mockResolvedValue([running, base]);
    api.fetchSkillVersionRegression.mockResolvedValue(null);
    api.fetchDatasetRevisionMetadata.mockRejectedValue(new ApiError("Dataset revision request failed: 500", 500));

    await render("/skill/edit?criterion=criterion_1&version=skillv_2", "/skill/edit", () => createElement(SkillEditScreen));

    expect(text()).toContain("count=null unavailable=true");
  });

  it("replaces the loading state with a load error when a criterion is selected", async () => {
    api.fetchLatestSkill.mockRejectedValueOnce(new ApiError("Skill request failed: 503", 503));
    api.fetchLatestSkill.mockRejectedValueOnce(new ApiError("No evaluator exists for this criterion", 404));
    api.fetchJudgeProviders.mockResolvedValue({ providers: [] });

    await render("/skill/edit?criterion=criterion_1", "/skill/edit", () => createElement(SkillEditScreen));

    expect(text()).not.toContain("Loading skill");
    expect(text()).toContain("Couldn't load the skill");
    expect(text()).toContain("Skill request failed: 503");

    await act(async () => buttons("Retry")[0]!.click());
    await settle();

    expect(api.fetchLatestSkill).toHaveBeenCalledTimes(2);
    expect(text()).toContain("No evaluator exists for this criterion");
    // Retrying a refused read fails the same way, so it isn't offered.
    expect(buttons("Retry")).toHaveLength(0);
    expect(text()).toContain("Back to skill");
  });
});

it("leaves each row improvement unknown when its baseline is unmeasured", async () => {
  const first = version("skillv_1", "1.0.1");
  const second = version("skillv_2", "1.0.2");
  api.fetchCurrentSkill.mockResolvedValue(skillWith(second));
  api.fetchSkillVersions.mockResolvedValue([second, first]);
  api.fetchSkillVersionRegression.mockImplementation(async (_skillId: string, versionId: string) =>
    versionId === first.id ? null : run(second.id, { improved: 0 }));
  await render("/skill/compare?from=skillv_1&to=skillv_2", "/skill/compare", () => createElement(CompareVersionsScreen));
  expect(container.querySelector('[data-kpi="Improvements"]')?.textContent).toContain("Improvements: —");
  const row = [...container.querySelectorAll("tbody tr")].find((entry) => entry.textContent?.includes("v1.0.2"));
  expect(row?.querySelectorAll("td")[4]?.textContent).toBe("—");
});
