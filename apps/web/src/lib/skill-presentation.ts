import type { SkillVersion } from "@rubrist/shared";

export const LEGACY_SAVE_CONSEQUENCE = "Saving can change the default for future unpinned runs, even when no reference cases exist. Without an approved version, an unvalidated version can be selected. Check Current default in Version history. Saving does not establish accuracy or calibration.";

export function skillEditConsequence(goldenSetSize: number | null): string {
  if (goldenSetSize === null) {
    return "Editing creates a new immutable version. Known-failure checks run when the current Golden set is non-empty.";
  }
  return goldenSetSize > 0
    ? `Editing creates a new immutable version and compares it with ${goldenSetSize} current Golden reference${goldenSetSize === 1 ? "" : "s"}.`
    : "Editing creates a new immutable version. Add a Golden reference to enable known-failure regression checks.";
}

export function skillVersionStateLabel(
  version: Pick<SkillVersion, "version" | "status" | "onboardingAssurance">
): string {
  return `v${version.version} · ${version.onboardingAssurance === "starter_unvalidated"
    ? "Starter · unvalidated"
    : version.status}`;
}
