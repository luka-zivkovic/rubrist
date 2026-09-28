import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("trust-aligned frontend flows", () => {
  it("keeps governed workflows separate from operational review and diagnostics", async () => {
    const sidebar = await source("../src/components/layout/sidebar.tsx");
    const operationalGroup = sidebar.slice(sidebar.indexOf('label: "Evidence & review"'), sidebar.indexOf('label: "Evaluator work"'));
    expect(sidebar).toContain('label: "Governed lifecycle"');
    expect(sidebar).toContain('label: "Ungoverned diagnostics"');
    expect(operationalGroup).not.toContain("Human truth");
    expect(operationalGroup).toContain("Review sessions · ungoverned");
    expect(sidebar).not.toMatch(/Golden evidence|Earn trust|Judge real work/);
    expect(sidebar).toContain("h-dvh flex-col overflow-y-auto");
  });

  it("describes dashboard completion as legacy operational progress", async () => {
    const [journey, dashboard] = await Promise.all([
      source("../src/components/rubrist/journey-pipeline.tsx"),
      source("../src/screens/dashboard.tsx")
    ]);

    expect(journey).toContain("Operational setup only");
    expect(journey).toContain("Governed analysis and human truth are tracked separately");
    expect(journey).toContain("ungoverned triage");
    expect(journey).not.toMatch(/Earn trust|Judge real work/);
    expect(dashboard).toContain('label="Legacy human checks"');
    expect(dashboard).toContain('foot="not governed human truth"');
    expect(dashboard).not.toContain("Human-verified");
  });

  it("explains legacy reviewer disagreements without implying blind collection", async () => {
    const exceptions = await source("../src/screens/exceptions.tsx");

    expect(exceptions).toContain("These cases have different recorded verdicts from two or more reviewers");
    expect(exceptions).toContain("Compare and resolve");
    expect(exceptions).not.toMatch(/blind review/i);
  });

  it("gates persistent governed workflows in demo mode without raw API failures", async () => {
    const [notice, criteria, analyze, humanTruth] = await Promise.all([
      source("../src/components/database-mode-required.tsx"),
      source("../src/screens/criteria.tsx"),
      source("../src/screens/analyze.tsx"),
      source("../src/screens/human-truth.tsx")
    ]);

    expect(notice).toContain("Persistent signed-in workspace required");
    for (const screen of [criteria, analyze, humanTruth]) {
      expect(screen).toContain("DatabaseModeRequired");
      expect(screen).toContain("if (demoMode)");
    }
    expect(analyze).toContain("They are a preview, not a reproducible analysis sample");
    expect(humanTruth).toContain("they never become governed truth");
  });

  it("states trace units and binds the version filter to export scope", async () => {
    const [traces, traceExport] = await Promise.all([
      source("../src/screens/traces.tsx"),
      source("../src/lib/trace-export.ts")
    ]);

    expect(traces).toContain('label="Verdict rows"');
    expect(traces).toContain("distinctCases");
    expect(traces).toContain("visibleCaseCount");
    expect(traceExport).toContain("skillVersionId: versionFilter");
    expect(traceExport).toContain("Verdict-label, search, and random-sample filters are not applied");
  });

  it("uses one Golden set name and one workspace without impersonating a role", async () => {
    const [golden, sidebar, rootLayout] = await Promise.all([
      source("../src/screens/golden.tsx"),
      source("../src/components/layout/sidebar.tsx"),
      source("../src/components/layout/root-layout.tsx")
    ]);
    const combined = [golden, sidebar, rootLayout].join("\n");

    expect(golden).toContain('title="Golden set"');
    expect(combined).not.toMatch(/Workspace display|DISPLAY_MODE|useMode/);
    expect(combined).not.toMatch(/Golden evidence|Reviewer view|View as/);
  });
});
