import { describe, expect, it } from "vitest";
import type { RegressionRunResult, SkillVersion } from "@rubrist/shared";
import {
  chainStepRun,
  chainTotals,
  chainTotalsGap,
  loadChainStep,
  type ChainStep
} from "../src/lib/compare-chain.js";

// Only the id matters to the chain; the rest of the version is carried through.
const version = (id: string) => ({ id, version: id.replace("skillv_", "") }) as SkillVersion;

function run(skillVersionId: string, regressed: number, improved: number): RegressionRunResult {
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
    cases: [],
    createdAt: "2026-09-01T00:00:00.000Z"
  };
}

const recorded = (id: string, regressed: number, improved: number): ChainStep => ({
  version: version(id),
  status: "recorded",
  run: run(id, regressed, improved)
});
const unrecorded = (id: string): ChainStep => ({ version: version(id), status: "unrecorded" });
const failed = (id: string): ChainStep => ({ version: version(id), status: "failed", error: "Regression run request failed" });

describe("run comparison chain", () => {
  it("keeps a failed read distinct from a save with no recorded run", async () => {
    const v = version("skillv_3");

    await expect(loadChainStep(v, async () => run("skillv_3", 1, 0))).resolves.toMatchObject({ status: "recorded" });
    await expect(loadChainStep(v, async () => null)).resolves.toEqual({ version: v, status: "unrecorded" });
    await expect(loadChainStep(v, async () => {
      throw new Error("Regression run request failed (503)");
    })).resolves.toEqual({ version: v, status: "failed", error: "Regression run request failed (503)" });
  });

  it("hands the regression state the run, null for none, and undefined for unreadable", () => {
    const recordedRun = run("skillv_3", 0, 1);

    expect(chainStepRun({ version: version("skillv_3"), status: "recorded", run: recordedRun })).toBe(recordedRun);
    expect(chainStepRun(unrecorded("skillv_2"))).toBeNull();
    expect(chainStepRun(failed("skillv_1"))).toBeUndefined();
  });

  it("sums the path only when every save on it has a recorded run", () => {
    const totals = chainTotals([recorded("skillv_3", 1, 0), recorded("skillv_2", 2, 3)]);

    expect(totals).toEqual({ saves: 2, recorded: 2, unrecorded: 0, failed: 0, regressed: 3, improved: 3 });
    expect(chainTotalsGap(totals)).toBeNull();
  });

  it("reports an unknown total, never zero, when a save has no recorded run", () => {
    const totals = chainTotals([recorded("skillv_3", 0, 0), unrecorded("skillv_2")]);

    expect(totals.regressed).toBeNull();
    expect(totals.improved).toBeNull();
    expect(totals.recorded).toBe(1);
    expect(chainTotalsGap(totals)).toBe("1 save has no recorded run");
    expect(chainTotalsGap(chainTotals([unrecorded("skillv_3"), unrecorded("skillv_2")]))).toBe("2 saves have no recorded run");
  });

  it("names unreadable runs first when a read failed", () => {
    const totals = chainTotals([failed("skillv_4"), unrecorded("skillv_3"), recorded("skillv_2", 0, 1)]);

    expect(totals).toMatchObject({ saves: 3, recorded: 1, unrecorded: 1, failed: 1, regressed: null, improved: null });
    expect(chainTotalsGap(totals)).toBe("1 save's run couldn't be loaded");
    expect(chainTotalsGap(chainTotals([failed("skillv_3"), failed("skillv_2")]))).toBe("2 saves' runs couldn't be loaded");
  });

  it("has no total for an empty path", () => {
    expect(chainTotals([])).toEqual({ saves: 0, recorded: 0, unrecorded: 0, failed: 0, regressed: null, improved: null });
  });
});
