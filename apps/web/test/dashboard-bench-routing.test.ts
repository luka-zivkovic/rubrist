import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardSummary } from "@rubrist/shared";

const state = {
  dashboard: null as DashboardSummary | null
};

const Element = ({ children, ...props }: { children?: unknown }) =>
  createElement("div", props, children as never);

vi.mock("react-router-dom", () => ({
  useLocation: () => ({ search: "?criterionId=criterion_1" }),
  Link: ({ children, to }: { children?: unknown; to: string }) =>
    createElement("a", { href: to }, children as never),
  useNavigate: () => vi.fn()
}));
vi.mock("@/components/ui/button", () => ({ Button: Element }));
vi.mock("@/components/ui/card", () => ({
  Card: Element,
  CardHeader: Element,
  CardTitle: Element,
  CardDescription: Element,
  CardContent: Element
}));
vi.mock("@/components/ui/table", () => ({ Table: Element }));
vi.mock("@/components/ui/separator", () => ({ Separator: Element }));
vi.mock("@/components/rubrist", () => ({
  Eyebrow: Element,
  SectionHead: Element,
  KPI: Element,
  KPIRow: Element,
  DistBar: Element,
  Legend: Element,
  VerdictChip: Element,
  Chip: Element,
  JourneyPipeline: () => createElement("div", null, "three-act-journey"),
  Receipt: Element,
  Ref: Element
}));
vi.mock("@/components/first-run-setup-ledger", () => ({
  FirstRunSetupLedger: () => createElement("div", null, "three-step-first-run-journey")
}));
vi.mock("@/screens/dashboard-welcome", () => ({
  DashboardWelcome: () => createElement("div", null, "tracing-welcome")
}));
vi.mock("@/screens/dashboard-bench-welcome", () => ({
  DashboardBenchWelcome: () => createElement("div", null, "bench-welcome")
}));
vi.mock("@/screens/dashboard-provisional", () => ({ DashboardProvisional: Element }));
vi.mock("@/components/first-project-key", () => ({ FirstProjectKeyCard: () => null }));
vi.mock("@/components/first-verdict", () => ({ FirstVerdictCard: () => null }));
vi.mock("@/components/row-action", () => ({ RowLink: ({ to, children }: any) => createElement("a", { href: to }, children) }));
vi.mock("@/lib/legacy-human-checks", () => ({ countLegacyHumanCheckedCases: vi.fn() }));
vi.mock("@/lib/journey", async () => import("../src/lib/journey.js"));
vi.mock("@/lib/dashboard-context", () => ({
  useDashboard: () => ({
    dashboard: state.dashboard,
    loading: false,
    error: null,
    reload: vi.fn()
  })
}));

function productionBench(input: { judged: number; golden: number }): DashboardSummary {
  return {
    viewerRole: "owner",
    project: {
      id: "project_bench",
      mode: "bench",
      importedTraceCount: 6,
      autoJudgedTraceCount: input.judged,
      syncBackCoverage: 0,
      traceProvider: "manual",
      updatedAt: "2026-08-26T20:00:00.000Z"
    },
    skill: {
      isStarter: false,
      criterionId: null,
      name: "Support quality",
      ownerName: "Owner",
      currentVersion: {
        version: "1.0.0",
        status: "approved",
        approvedAt: "2026-08-26T19:00:00.000Z",
        goldenSetAgreement: null,
        tooStrictCount: 0,
        tooLenientCount: 0,
        executionBinding: {
          provider: "openai",
          endpoint: { kind: "managed" },
          modelId: "gpt-5",
          modelVersion: "gpt-5",
          sampling: { temperature: 0, topP: null },
          reasoning: null,
          outputTokenLimit: null,
          verdictProtocol: "openai.structured-output/v1",
          routing: null
        },
        customEndpointUrl: null
      }
    },
    currentVersionResultCount: input.judged,
    goldenSetSize: input.golden,
    exceptions: [],
    topCapabilityGaps: [],
    verdictDistribution: { pass: input.judged, fail: 0, ambiguous: 0 }
  } as DashboardSummary;
}

describe("Skill Bench dashboard routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the first-run ledger mounted after examples are imported", async () => {
    const { DashboardScreen } = await import("../src/screens/dashboard.js");
    state.dashboard = productionBench({ judged: 0, golden: 0 });
    const html = renderToStaticMarkup(createElement(DashboardScreen));

    expect(html).toContain("three-step-first-run-journey");
    expect(html).not.toContain("three-act-journey");
  });

  it("keeps the same ledger mounted after the first Result", async () => {
    const { DashboardScreen } = await import("../src/screens/dashboard.js");
    state.dashboard = productionBench({ judged: 6, golden: 1 });
    const html = renderToStaticMarkup(createElement(DashboardScreen));

    expect(html).toContain("three-step-first-run-journey");
  });

  it("shows a no-Run completion update immediately on the day-zero Overview", async () => {
    const { DashboardScreen } = await import("../src/screens/dashboard.js");
    const dashboard = productionBench({ judged: 0, golden: 0 });
    dashboard.project.importedTraceCount = 0;
    state.dashboard = dashboard;
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => key === "rubrist.setup-receipt"
        ? "Starter Check v1.0.0 created. Add a Run to see its first Result."
        : null,
      removeItem: vi.fn()
    });

    const html = renderToStaticMarkup(createElement(DashboardScreen));

    expect(html).toContain("Setup update.");
    expect(html).toContain("Add a Run to see its first Result");
    expect(html).toContain("bench-welcome");
  });
});


it("shows the full backlog while distinguishing the loaded review batch", async () => {
  const { DashboardScreen } = await import("../src/screens/dashboard.js");
  state.dashboard = productionBench({ judged: 200, golden: 5 });
  state.dashboard.exceptionsTotal = 137;
  state.dashboard.exceptions = Array.from({ length: 50 }, (_, index) => ({
    id: `case_${index}`, title: `Case ${index}`, traceId: `trace_${index}`,
    verdict: "fail" as const, reason: "A failure", createdAt: "2026-09-01T00:00:00Z",
    criterionVersionId: `definition_${index}`, capabilityGap: null, rejudgedSince: null
  }));
  const html = renderToStaticMarkup(createElement(DashboardScreen));
  expect(html).toContain("137 are waiting on a person");
  expect(html).toMatch(/Showing 5 of 137 waiting cases/);
  expect(html).toMatch(/Review 50 loaded cases/);
  expect(html).not.toContain("Review all 50");
  expect(html.indexOf("Next")).toBeLessThan(html.indexOf("Result distribution"));
  expect(html.indexOf("Exceptions waiting")).toBeLessThan(html.indexOf("Result distribution"));
  expect(html.match(/variant="primary"/g)).toHaveLength(1);
  expect(html).toContain('aria-label="Waiting case preview"');
  expect(html).toContain('at=case_4');
  expect(html).toContain('criterionId=criterion_1');
  expect(html).toContain('cv.4=definition_4');
  expect(html).not.toContain('href="/cases/case_4"');
  expect(html).not.toContain('Manage integrations');
  expect(html).toContain('Setup progress and first Result');
  expect(html).not.toContain("50 are waiting on a person");

  delete state.dashboard.exceptionsTotal;
  const unknown = renderToStaticMarkup(createElement(DashboardScreen));
  expect(unknown).toContain("Review backlog total unavailable");
  expect(unknown).not.toContain("50 are waiting on a person");
});
