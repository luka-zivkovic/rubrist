import type { RegressionRunResult, SkillVersion } from "@rubrist/shared";
import { loadErrorMessage } from "./load-error";

// One save on the path between two compared versions, with what was recorded
// for it: its regression run, no run at all, or a read that failed.
export type ChainStep =
  | { version: SkillVersion; status: "recorded"; run: RegressionRunResult }
  | { version: SkillVersion; status: "unrecorded" }
  | { version: SkillVersion; status: "failed"; error: string };

export interface ChainTotals {
  saves: number;
  recorded: number;
  unrecorded: number;
  failed: number;
  // Sums over the whole path, or null unless every save on it has a recorded
  // run. A missing or unreadable run is unknown, never zero.
  regressed: number | null;
  improved: number | null;
}

export async function loadChainStep(
  version: SkillVersion,
  readRun: () => Promise<RegressionRunResult | null>
): Promise<ChainStep> {
  try {
    const run = await readRun();
    return run ? { version, status: "recorded", run } : { version, status: "unrecorded" };
  } catch (error) {
    return { version, status: "failed", error: loadErrorMessage(error) };
  }
}

// The run to judge a step's regression state by: the run, null when none was
// recorded, and undefined when the read failed.
export function chainStepRun(step: ChainStep): RegressionRunResult | null | undefined {
  if (step.status === "recorded") return step.run;
  return step.status === "unrecorded" ? null : undefined;
}

export function chainTotals(steps: ReadonlyArray<ChainStep>): ChainTotals {
  let recorded = 0;
  let unrecorded = 0;
  let failed = 0;
  let regressed = 0;
  let improved = 0;
  for (const step of steps) {
    if (step.status === "recorded") {
      recorded += 1;
      regressed += step.run.regressed;
      improved += step.run.improved;
    } else if (step.status === "unrecorded") {
      unrecorded += 1;
    } else {
      failed += 1;
    }
  }
  const complete = steps.length > 0 && recorded === steps.length;
  return {
    saves: steps.length,
    recorded,
    unrecorded,
    failed,
    regressed: complete ? regressed : null,
    improved: complete ? improved : null
  };
}

// Why a path total is unknown, or null when every save has a recorded run.
export function chainTotalsGap(totals: ChainTotals): string | null {
  if (totals.failed > 0) {
    return `${totals.failed} ${totals.failed === 1 ? "save's run" : "saves' runs"} couldn't be loaded`;
  }
  if (totals.unrecorded > 0) {
    return `${totals.unrecorded} ${totals.unrecorded === 1 ? "save has" : "saves have"} no recorded run`;
  }
  return null;
}
