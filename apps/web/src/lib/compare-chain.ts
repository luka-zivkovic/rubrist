import type { RegressionRunResult, SkillVersion } from "@rubrist/shared";
import { loadFailure } from "./load-error";

// One save on the path between two compared versions, with what was recorded
// for it: its regression run, no run at all, or a read that failed.
export type ChainStep =
  | { version: SkillVersion; status: "recorded"; run: RegressionRunResult }
  | { version: SkillVersion; status: "unrecorded" }
  | { version: SkillVersion; status: "failed"; error: string; retryable: boolean };

export interface ChainTotals {
  saves: number;
  // Saves with a recorded run, whatever the run found.
  recorded: number;
  unrecorded: number;
  // Saves whose run couldn't be read.
  failed: number;
  // Recorded runs that compared nothing: the check itself failed, or there
  // were no reference cases to compare.
  checkFailed: number;
  notCompared: number;
  // Sums over the whole path, or null unless every save on it has a recorded
  // run that compared reference cases. Missing, unreadable, failed, and empty
  // checks are unknown, never zero.
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
    const failure = loadFailure(error);
    return { version, status: "failed", error: failure.message, retryable: failure.retryable };
  }
}

// The run to judge a step's regression state by: the run, null when none was
// recorded, and undefined when the read failed.
export function chainStepRun(step: ChainStep): RegressionRunResult | null | undefined {
  if (step.status === "recorded") return step.run;
  return step.status === "unrecorded" ? null : undefined;
}

// Whether a recorded run measured anything. A failed check is stored with
// zero counts, and so is a check with no reference cases to compare; neither
// found zero regressions.
export function runCompared(run: RegressionRunResult): boolean {
  return run.status !== "error" && !run.goldenSetMissing && run.compared > 0;
}

export function chainTotals(steps: ReadonlyArray<ChainStep>): ChainTotals {
  let recorded = 0;
  let unrecorded = 0;
  let failed = 0;
  let checkFailed = 0;
  let notCompared = 0;
  let regressed = 0;
  let improved = 0;
  for (const step of steps) {
    if (step.status === "recorded") {
      recorded += 1;
      if (step.run.status === "error") {
        checkFailed += 1;
      } else if (!runCompared(step.run)) {
        notCompared += 1;
      } else {
        regressed += step.run.regressed;
        improved += step.run.improved;
      }
    } else if (step.status === "unrecorded") {
      unrecorded += 1;
    } else {
      failed += 1;
    }
  }
  const complete = steps.length > 0 && recorded === steps.length && checkFailed === 0 && notCompared === 0;
  return {
    saves: steps.length,
    recorded,
    unrecorded,
    failed,
    checkFailed,
    notCompared,
    regressed: complete ? regressed : null,
    improved: complete ? improved : null
  };
}

// Why a path total is unknown, or null when every save's run compared
// reference cases. The first reason in this order is named.
export function chainTotalsGap(totals: ChainTotals): string | null {
  if (totals.failed > 0) {
    return `${totals.failed} ${totals.failed === 1 ? "save's run" : "saves' runs"} couldn't be loaded`;
  }
  if (totals.checkFailed > 0) {
    return `${totals.checkFailed} ${totals.checkFailed === 1 ? "save's regression check" : "saves' regression checks"} failed`;
  }
  if (totals.notCompared > 0) {
    return `${totals.notCompared} ${totals.notCompared === 1 ? "save" : "saves"} had no reference cases to compare`;
  }
  if (totals.unrecorded > 0) {
    return `${totals.unrecorded} ${totals.unrecorded === 1 ? "save has" : "saves have"} no recorded run`;
  }
  return null;
}

// How many saves have a recorded run, without implying the unreadable ones
// have none.
export function chainRecordedNote(totals: ChainTotals): string {
  const recorded = `${totals.recorded} with a recorded run`;
  return totals.failed > 0 ? `${recorded} · ${totals.failed} couldn't be loaded` : recorded;
}
