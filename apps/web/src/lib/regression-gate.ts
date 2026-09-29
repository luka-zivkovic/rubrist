import type { RegressionRunResult, SkillVersion } from "@rubrist/shared";

// One vocabulary for evaluator-version regression, used in Version history,
// the version page, and run comparisons.
export type GateState =
  | "clean"
  | "blocked"
  | "error"
  | "override"
  | "inactive"
  | "first"
  | "running"
  | "unrecorded"
  | "unavailable"
  | "loading";

export const GATE_LABEL: Record<GateState, string> = {
  clean: "reference check · matched",
  blocked: "reference disagreements",
  error: "reference check · error",
  override: "reference check · override recorded",
  inactive: "reference check · inactive",
  first: "reference check · no comparison",
  running: "reference check · running",
  unrecorded: "reference check · not recorded",
  unavailable: "reference check · unavailable",
  // Shown while the run is being read; gateStateForVersion never returns it.
  loading: "reference check · loading"
};

// Stored disagreement counts are zeros until a check measures them; while a
// version has no agreement value they are unknown, never zero.
export function measuredCount(version: SkillVersion, count: number, run?: Pick<RegressionRunResult, "compared"> | null): number | "—" {
  return version.goldenSetAgreement == null || run?.compared === 0 ? "—" : count;
}

export function isGateState(value: string): value is GateState {
  return Object.hasOwn(GATE_LABEL, value);
}

// Derive a version's regression state from its status and its persisted
// regression run. `run` is that run, `null` when none was recorded, and
// `undefined` when it could not be read. Only a recorded run can make a version
// clean: a version saved before the gate, signed off as a starter, or whose run
// was lost has no evidence either way, and missing evaluation is never shown
// as a favorable result (PRODUCT.md principle 2).
//
// A recorded run wins over `calibrating`: a governed candidate reads as
// calibrating for its whole candidate life, including after its run is
// recorded, so only a calibrating version without a run is still running.
export function gateStateForVersion(
  version: SkillVersion,
  run: RegressionRunResult | null | undefined
): GateState {
  if (version.status === "failed") return "error";
  if (version.status === "regressing") return "blocked";
  if (run === undefined) return "unavailable";
  if (run === null) return version.status === "calibrating" ? "running" : "unrecorded";
  if (run.status === "error") return "error";
  if (run.status === "blocked") return "blocked";
  if (run.status === "overridden") return "override";
  if (
    run.compared === 0
    || run.goldenSetMissing
    || version.goldenSetAgreement === null
    || version.knownLimitations.some((limitation) => limitation.includes("no golden-set cases"))
  ) {
    return "first";
  }
  if (
    version.knownLimitations.some((limitation) => limitation.includes("regressed on one or more"))
  ) {
    return "override";
  }
  return "clean";
}
