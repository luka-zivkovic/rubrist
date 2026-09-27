import { describe, expect, it } from "vitest";
import type { RegressionRunResult, SkillVersion } from "@rubrist/shared";
import { ApiError } from "../src/lib/api/transport.js";
import {
  chainImprovementsGap,
  chainRecordedNote,
  chainStepRun,
  chainTotals,
  chainTotalsGap,
  loadChainStep,
  runCompared,
  runHasVerdicts,
  type ChainStep
} from "../src/lib/compare-chain.js";

// Only the id matters to the chain; the rest of the version is carried through.
const version = (id: string) => ({ id, version: id.replace("skillv_", "") }) as SkillVersion;

function run(
  skillVersionId: string,
  regressed: number,
  improved: number,
  overrides: Partial<RegressionRunResult> = {}
): RegressionRunResult {
  return {
    id: `run_${skillVersionId}`,
    skillVersionId,
    datasetRevisionId: "revision_1",
    status: regressed > 0 ? "overridden" : "passed",
    compared: 5,
    regressed,
    improved,
    flipped: regressed + improved,
    goldenSetMissing: false,
    cases: [{ caseId: `case_${skillVersionId}`, traceId: "trace_1", agreedLabel: "pass", newLabel: "pass", change: "agree", rationale: null }],
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

const recorded = (id: string, regressed: number, improved: number, overrides: Partial<RegressionRunResult> = {}): ChainStep => ({
  version: version(id),
  status: "recorded",
  run: run(id, regressed, improved, overrides)
});
// How the API stores a check that failed, and one with no reference cases.
const checkFailed = (id: string) => recorded(id, 0, 0, { status: "error", compared: 0, flipped: 0, error: "judge timed out", cases: [] });
const noBaseline = (id: string) => recorded(id, 0, 0, { goldenSetMissing: true, compared: 0, cases: [] });
const unrecorded = (id: string): ChainStep => ({ version: version(id), status: "unrecorded" });
// The `from` version: the oldest save's improvements are counted against it.
const from = recorded("skillv_1", 0, 0);
const failed = (id: string): ChainStep => ({
  version: version(id),
  status: "failed",
  error: "Regression run request failed",
  retryable: true
});

describe("run comparison chain", () => {
  it("keeps a failed read distinct from a save with no recorded run", async () => {
    const v = version("skillv_3");

    await expect(loadChainStep(v, async () => run("skillv_3", 1, 0))).resolves.toMatchObject({ status: "recorded" });
    await expect(loadChainStep(v, async () => null)).resolves.toEqual({ version: v, status: "unrecorded" });
    await expect(loadChainStep(v, async () => {
      throw new ApiError("Regression run request failed: 503", 503);
    })).resolves.toEqual({ version: v, status: "failed", error: "Regression run request failed: 503", retryable: true });
    await expect(loadChainStep(v, async () => {
      throw new ApiError("Skill version not found", 404);
    })).resolves.toEqual({ version: v, status: "failed", error: "Skill version not found", retryable: false });
  });

  it("hands the regression state the run, null for none, and undefined for unreadable", () => {
    const recordedRun = run("skillv_3", 0, 1);

    expect(chainStepRun({ version: version("skillv_3"), status: "recorded", run: recordedRun })).toBe(recordedRun);
    expect(chainStepRun(unrecorded("skillv_2"))).toBeNull();
    expect(chainStepRun(failed("skillv_1"))).toBeUndefined();
  });

  it("sums the path only when every save on it has a recorded run", () => {
    const totals = chainTotals([recorded("skillv_3", 1, 0), recorded("skillv_2", 2, 3)], from);

    expect(totals).toEqual({
      saves: 2,
      recorded: 2,
      unrecorded: 0,
      failed: 0,
      checkFailed: 0,
      notCompared: 0,
      improvementsCounted: true,
      regressed: 3,
      improved: 3
    });
    expect(chainTotalsGap(totals)).toBeNull();
    expect(chainRecordedNote(totals)).toBe("2 with a recorded run");
  });

  it("never sums the zeros a failed or empty check recorded", () => {
    expect(runCompared(run("skillv_3", 0, 0, { status: "error", compared: 0 }))).toBe(false);
    expect(runCompared(run("skillv_3", 0, 0, { goldenSetMissing: true, compared: 0 }))).toBe(false);
    expect(runCompared(run("skillv_3", 0, 0, { compared: 0 }))).toBe(false);
    expect(runCompared(run("skillv_3", 0, 0))).toBe(true);

    const failedCheck = chainTotals([recorded("skillv_3", 1, 0), checkFailed("skillv_2")], from);
    expect(failedCheck).toMatchObject({ recorded: 2, checkFailed: 1, notCompared: 0, regressed: null, improved: null });
    expect(chainTotalsGap(failedCheck)).toBe("1 save's regression check failed");

    const empty = chainTotals([noBaseline("skillv_3"), noBaseline("skillv_2")], from);
    expect(empty).toMatchObject({ recorded: 2, checkFailed: 0, notCompared: 2, regressed: null, improved: null });
    expect(chainTotalsGap(empty)).toBe("2 saves had no reference cases to compare");
  });

  it("reports an unknown total, never zero, when a save has no recorded run", () => {
    const totals = chainTotals([recorded("skillv_3", 0, 0), unrecorded("skillv_2")], from);

    expect(totals.regressed).toBeNull();
    expect(totals.improved).toBeNull();
    expect(totals.recorded).toBe(1);
    expect(chainTotalsGap(totals)).toBe("1 save has no recorded run");
    expect(chainTotalsGap(chainTotals([unrecorded("skillv_3"), unrecorded("skillv_2")], from))).toBe("2 saves have no recorded run");
  });

  it("names unreadable runs first when a read failed", () => {
    const totals = chainTotals([failed("skillv_4"), unrecorded("skillv_3"), recorded("skillv_2", 0, 1)], from);

    expect(totals).toMatchObject({ saves: 3, recorded: 1, unrecorded: 1, failed: 1, regressed: null, improved: null });
    expect(chainTotalsGap(totals)).toBe("1 save's run couldn't be loaded");
    // The unreadable save is not counted as one without a run.
    expect(chainRecordedNote(totals)).toBe("1 with a recorded run · 1 couldn't be loaded");
    expect(chainTotalsGap(chainTotals([failed("skillv_3"), failed("skillv_2")], from))).toBe("2 saves' runs couldn't be loaded");
  });

  it("counts improvements only against measured per-case verdicts", () => {
    expect(runHasVerdicts(run("skillv_1", 0, 0))).toBe(true);
    expect(runHasVerdicts(run("skillv_1", 0, 0, { cases: [] }))).toBe(false);

    // The starting version has no run: every improvement on the oldest save
    // is zero by construction, while its regressions were measured.
    const unmeasuredFrom = unrecorded("skillv_1");
    const totals = chainTotals([recorded("skillv_3", 1, 2), recorded("skillv_2", 0, 1)], unmeasuredFrom);
    expect(totals).toMatchObject({ regressed: 1, improved: null, improvementsCounted: false });
    expect(chainTotalsGap(totals)).toBeNull();
    expect(chainImprovementsGap(totals, unmeasuredFrom)).toBe("v1 has no measured run to count improvements from");

    // An earlier save on the path recorded counts without cases.
    const oldFormat = chainTotals([recorded("skillv_3", 0, 2), recorded("skillv_2", 0, 1, { cases: [] })], from);
    expect(oldFormat.improved).toBeNull();
    expect(chainImprovementsGap(oldFormat, from)).toBe("an earlier save has no per-case record to count improvements from");

    const counted = chainTotals([recorded("skillv_3", 0, 2), recorded("skillv_2", 0, 1)], from);
    expect(counted).toMatchObject({ improved: 3, improvementsCounted: true });
    expect(chainImprovementsGap(counted, from)).toBeNull();
  });

  it("has no total for an empty path", () => {
    expect(chainTotals([], from)).toMatchObject({ saves: 0, recorded: 0, regressed: null, improved: null });
  });
});
