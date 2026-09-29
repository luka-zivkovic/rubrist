import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { humanTruthNextStep, humanTruthNextStepHref } from "../src/lib/human-truth-journey.js";
import { skillEditConsequence, skillVersionStateLabel } from "../src/lib/skill-presentation.js";
import { readFeatureSource } from "./support/web-extraction-contracts.js";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

async function tsxFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  }));
  return nested.flat();
}

describe("beginner-first hierarchy", () => {
  it("keeps Settings directly routable without a criterion or display selection", async () => {
    const [app, rootLayout] = await Promise.all([
      source("../src/App.tsx"), source("../src/components/layout/root-layout.tsx")
    ]);
    expect(app).toContain('{ path: "settings", element: <SettingsScreen /> }');
    expect(rootLayout).toContain("const criterionSelectionRequiredForRoute = routeRequiresCriterionSelection(location.pathname)");
    expect(rootLayout).toContain("criteriaLoading && criterionSelectionRequiredForRoute");
  });

  it("puts the Golden set scope before entries and never upgrades legacy promotion to truth", async () => {
    const golden = await source("../src/screens/golden.tsx");
    const principle = golden.indexOf("<Eyebrow>The principle</Eyebrow>");
    const entries = golden.indexOf("{loading && entries.length === 0 ? (");

    expect(principle).toBeGreaterThan(-1);
    expect(entries).toBeGreaterThan(principle);
    expect(golden).toContain("ungoverned regression evidence");
    expect(golden).toContain("does not measure overall quality");
    expect(golden).not.toMatch(/Human-reviewed reference|useful governed evidence/);
  });

  it("keeps trace-to-test entry labels contextual and explains the compact consequence", async () => {
    const trace = await source("../src/screens/trace.tsx");
    const compactStart = trace.indexOf("if (!draftsError && promptDismissed && !latestDraft)");
    const compact = trace.slice(compactStart, trace.indexOf("\n  return (", compactStart));

    expect(trace).toContain('title: "Prevent this next time"');
    expect(trace).toContain('title: "Protect this behavior"');
    expect(trace).toContain('title: "Make this a test"');
    expect(compact).toContain("draft rerunnable test");
    expect(compact).toContain("{copy.title}");
  });

  it("routes new projects through Overview before the advanced editor", async () => {
    const [projectCreate, skillEdit, firstResult, firstResultState, provisional, dashboard, tracingWelcome, benchWelcome, importTrace] = await Promise.all([
      source("../src/components/project-create.tsx"),
      readFeatureSource("skill-edit"),
      source("../src/screens/first-result.tsx"),
      source("../src/lib/first-result.ts"),
      source("../src/screens/dashboard-provisional.tsx"),
      source("../src/screens/dashboard.tsx"),
      source("../src/screens/dashboard-welcome.tsx"),
      source("../src/screens/dashboard-bench-welcome.tsx"),
      source("../src/components/import-trace-launcher.tsx")
    ]);

    expect(projectCreate.match(/window\.location\.assign\("\/"\)/g)).toHaveLength(2);
    expect(projectCreate).not.toContain("firstRunEditorPath");
    expect(skillEdit).toContain("Starter evaluator v${result.version.version} created. Add a case to see its first assessment.");
    expect(skillEdit).toContain('useState<SkillVersionTimeScope>(firstRun ? "both" : "new")');
    expect(skillEdit).toContain("navigate(firstResultPath(result.version.id, skill.id, skill.criterionId))");
    expect(firstResultState).toContain('run.trigger === "backfill"');
    expect(firstResult).toContain("ensureSkillVersionBackfill(skillId, versionId)");
    expect(firstResult).toContain('const skillId = searchParams.get("skill")');
    expect(firstResult).toContain('const criterionId = searchParams.get("criterionId")');
    expect(firstResult).toContain("dashboard?.skill.currentVersion.id === versionId");
    expect(firstResult).toContain('evidenceScope: "customer"');
    expect(firstResult).toContain("setRetryNonce((value) => value + 1)");
    expect(firstResult).toContain("Date.now() >= nextEnsureAt.current");
    expect(firstResult).toContain("Case saved, waiting to enter the evaluation queue");
    expect(firstResult).toContain("No assessment exists yet");
    expect(firstResult).toContain("ensured.dispatchPending");
    expect(firstResult).toContain("Your first assessment is ready");
    expect(firstResult).toContain("The first assessment could not be produced");
    expect(firstResult).toContain('navigate(dashboard?.viewerRole === "owner" ? "/skill/edit" : "/skill")');
    expect(firstResult).not.toContain("navigate(firstRunEditorPath())");
    expect(firstResult).toContain('aria-live={urgent ? "assertive" : "polite"}');
    expect(provisional).toContain('navigate(owner ? firstRunEditorPath() : "/skill")');
    expect(dashboard).toContain("setReceipt(takeSetupReceipt())");
    expect(tracingWelcome).toContain("emphasizeAction={false}");
    expect(benchWelcome).toContain("emphasizeAction={false}");
    expect(importTrace).toContain("Its evaluator is queued");
    expect(importTrace).not.toContain("The skill ran on the case you imported");
  });

  it("leads the evaluator screen with purpose and action before technical metadata", async () => {
    const skill = await source("../src/screens/skill.tsx");
    const loadedView = skill.slice(skill.indexOf("const v = skill.currentVersion"));
    const heading = loadedView.indexOf("<SectionHead");
    const details = loadedView.indexOf("<details");

    expect(heading).toBeGreaterThan(-1);
    expect(details).toBeGreaterThan(heading);
    expect(loadedView).toContain('eyebrow={`Evaluator definition · current default · v${v.version}`}');
    expect(loadedView).toContain("right={");
    expect(loadedView).toContain("Edit evaluator");
    expect(loadedView).toContain('dashboard?.viewerRole === "owner"');
    expect(loadedView).toContain("requested model, immutable version, and status");
  });

  it("describes the immutable evaluator version honestly when parent state and regression coverage differ", () => {
    const divergentSkill = {
      status: "draft",
      currentVersion: { version: "3.0.0", status: "approved" }
    } as const;

    expect(skillVersionStateLabel(divergentSkill.currentVersion)).toBe("v3.0.0 · approved");
    expect(skillVersionStateLabel(divergentSkill.currentVersion)).not.toContain(divergentSkill.status);
    expect(skillVersionStateLabel({
      ...divergentSkill.currentVersion,
      onboardingAssurance: "starter_unvalidated"
    })).toBe("v3.0.0 · Starter · unvalidated");
    const historicalVersion = { regressionDatasetRevisionId: null };
    expect(historicalVersion.regressionDatasetRevisionId).toBeNull();
    expect(skillEditConsequence(2)).toContain("2 current Golden references");
    expect(skillEditConsequence(2)).not.toContain("Add a Golden reference");
    expect(skillEditConsequence(0)).toContain("Add a Golden reference");
    expect(skillEditConsequence(null)).toContain("when the current Golden set is non-empty");
  });

  it("selects one Human Truth next action from durable prerequisite state", async () => {
    expect(humanTruthNextStep({ criterionVersionId: null, instructionCount: 0, batchStates: [] }).label)
      .toBe("Choose a criterion");
    expect(humanTruthNextStep({ criterionVersionId: "cv_1", instructionCount: 0, batchStates: [] }).label)
      .toBe("Create reviewer instructions");
    expect(humanTruthNextStep({ criterionVersionId: "cv_1", instructionCount: 1, batchStates: [] }).label)
      .toBe("Create a review batch");
    for (const state of ["draft", "open", "labeling_closed", "alignment_open", "adjudicating", "resolved"] as const) {
      expect(humanTruthNextStep({ criterionVersionId: "cv_1", instructionCount: 1, batchStates: [state] }).label)
        .toBe("Manage current batch");
    }
    expect(humanTruthNextStep({ criterionVersionId: "cv_1", instructionCount: 1, batchStates: ["frozen"] }).label)
      .toBe("Create another review batch");
    expect(humanTruthNextStep({ criterionVersionId: "cv_1", instructionCount: 1, batchStates: ["frozen", "open"] }).label)
      .toBe("Manage current batch");
    expect(humanTruthNextStepHref("#review-batches", (path) => `${path}?criterion=cv_1`))
      .toBe("/human-truth?criterion=cv_1#review-batches");

    const humanTruth = await source("../src/screens/human-truth.tsx");
    const beforeEvidenceTables = humanTruth.slice(0, humanTruth.indexOf("Instruction lineage"));
    expect(beforeEvidenceTables.indexOf("Next step")).toBeGreaterThan(humanTruth.indexOf("<SectionHead"));
    expect((beforeEvidenceTables.match(/variant="primary"/g) ?? [])).toHaveLength(1);
    expect(beforeEvidenceTables).toContain("<details");
    expect(beforeEvidenceTables).toContain("Other governed setup actions");
    expect(beforeEvidenceTables).toContain("Other project batches do not appear unless you have an assignment");
  });

  it("gives every primary workspace destination plain-language purpose copy", async () => {
    const screens = await Promise.all([
      "dashboard",
      "criteria",
      "skill",
      "analyze",
      "human-truth",
      "traces",
      "exceptions",
      "review-queues",
      "datasets",
      "golden",
      "reliability",
      "integrations",
      "settings"
    ].map((name) => source(`../src/screens/${name}.tsx`)));

    for (const screen of screens) {
      expect(screen).toContain("<SectionHead");
      expect(screen).toMatch(/\bsub=/);
    }
  });

  it("removes the former display labels from all rendered application source", async () => {
    const files = await tsxFiles(new URL("../src/", import.meta.url).pathname);
    const contents = (await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n");

    expect(contents).not.toMatch(/\b(?:developer|quality|stakeholder) view\b/i);
    expect(contents).not.toMatch(/(?:Guided|Technical|Summary) display|dev-only|pm-only|useMode/);
  });
});
