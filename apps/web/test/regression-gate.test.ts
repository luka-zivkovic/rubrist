import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RegressionRunResult, SkillVersion } from "@rubrist/shared";
import { GATE_LABEL, gateStateForVersion, type GateState } from "../src/lib/regression-gate.js";
import { GateChip } from "../src/components/rubrist/gate.js";

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, variant, ...props }: { children?: unknown; variant?: string }) =>
    createElement("span", { ...props, "data-variant": variant }, children as never)
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children?: unknown }) => createElement("button", props, children as never)
}));
vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ")
}));
vi.mock("@/lib/regression-gate", async () => import("../src/lib/regression-gate.js"));

function version(overrides: Partial<SkillVersion> = {}): SkillVersion {
  return {
    id: "skillv_1",
    skillId: "skill_1",
    criterionVersionId: "criterionv_1",
    version: "1.2.0",
    status: "approved",
    rubricMarkdown: "# Guide\n\nPass when grounded.",
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
    createdAt: "2026-09-01T00:00:00.000Z",
    approvedAt: "2026-09-01T00:01:00.000Z",
    ...overrides
  };
}

function run(overrides: Partial<RegressionRunResult> = {}): RegressionRunResult {
  return {
    id: "run_1",
    skillVersionId: "skillv_1",
    datasetRevisionId: "revision_1",
    status: "passed",
    compared: 4,
    regressed: 0,
    improved: 1,
    flipped: 1,
    goldenSetMissing: false,
    cases: [],
    createdAt: "2026-09-01T00:00:30.000Z",
    ...overrides
  };
}

describe("evaluator-version regression state", () => {
  it("reads clean only from a recorded run that passed against a baseline", () => {
    expect(gateStateForVersion(version(), run())).toBe("clean");
  });

  it("never reads a version without a recorded run as clean", () => {
    // Approved, full agreement, no limitations: the old derivation called this
    // clean. Without a recorded run there is no evidence either way.
    expect(gateStateForVersion(version(), null)).toBe("unrecorded");
    expect(gateStateForVersion(version({ onboardingAssurance: "starter_unvalidated" }), null)).toBe("unrecorded");
  });

  it("keeps an unreadable run distinct from a run that was never recorded", () => {
    expect(gateStateForVersion(version(), undefined)).toBe("unavailable");
    expect(GATE_LABEL.unavailable).not.toBe(GATE_LABEL.unrecorded);
  });

  it("lets a failed or regressing version's status win over the run", () => {
    expect(gateStateForVersion(version({ status: "failed" }), run())).toBe("error");
    expect(gateStateForVersion(version({ status: "regressing" }), run())).toBe("blocked");
  });

  it("reads a calibrating version as running only until its run is recorded", () => {
    // A governed candidate reads as calibrating for its whole candidate life,
    // including after its regression run is recorded.
    const candidate = version({ status: "calibrating", approvedAt: null });

    expect(gateStateForVersion(candidate, null)).toBe("running");
    expect(gateStateForVersion(candidate, run())).toBe("clean");
    expect(gateStateForVersion(candidate, run({ status: "blocked", regressed: 1 }))).toBe("blocked");
    expect(gateStateForVersion(candidate, run({ status: "error", error: "judge timed out" }))).toBe("error");
    expect(gateStateForVersion(candidate, undefined)).toBe("unavailable");
  });

  it("reports what the recorded run says", () => {
    expect(gateStateForVersion(version(), run({ status: "error", error: "judge timed out" }))).toBe("error");
    expect(gateStateForVersion(version(), run({ status: "blocked", regressed: 2 }))).toBe("blocked");
    expect(gateStateForVersion(version(), run({ status: "overridden", regressed: 1, overrideReason: "known flake" }))).toBe("override");
    expect(gateStateForVersion(
      version({ knownLimitations: ["regressed on one or more golden-set cases"] }),
      run()
    )).toBe("override");
  });

  it("reads a run with nothing to compare against as no baseline", () => {
    expect(gateStateForVersion(version(), run({ goldenSetMissing: true, compared: 0 }))).toBe("first");
    expect(gateStateForVersion(version({ goldenSetAgreement: null }), run())).toBe("first");
    expect(gateStateForVersion(
      version({ knownLimitations: ["no golden-set cases are available; regression gate is advisory only"] }),
      run({ status: "overridden" })
    )).toBe("first");
  });

  it("labels every state without calling any unknown or missing state clean", () => {
    const states = Object.keys(GATE_LABEL) as GateState[];
    for (const state of states) {
      expect(GATE_LABEL[state]).toMatch(/^regression · /);
      if (state !== "clean") expect(GATE_LABEL[state]).not.toContain("clean");
    }
    expect(GATE_LABEL.unrecorded).toBe("regression · not recorded");
    expect(GATE_LABEL.unavailable).toBe("regression · unavailable");
    expect(GATE_LABEL.running).toBe("regression · running");
  });
});

describe("GateChip", () => {
  it("renders the state's label and a neutral variant for missing evidence", () => {
    const html = renderToStaticMarkup(createElement(GateChip, { state: "unrecorded" }));

    expect(html).toContain("regression · not recorded");
    expect(html).toContain('data-variant="outline"');
  });

  it("falls back to unavailable, never clean, for an unknown state", () => {
    for (const state of ["retired", "constructor", "toString"]) {
      const html = renderToStaticMarkup(createElement(GateChip, { state: state as GateState }));

      expect(html).toContain("regression · unavailable");
      expect(html).not.toContain("clean");
      expect(html).not.toContain('data-variant="pass"');
    }
  });
});
