import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RegressionRunResultSchema } from "@rubrist/shared";
import { PageLoadError, SectionLoadError } from "../src/components/rubrist/load-error.js";
import { loadErrorMessage } from "../src/lib/load-error.js";
import { readFeatureSource, readWebSource } from "./support/web-extraction-contracts.js";

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, variant, size: _size, ...props }: { children?: unknown; variant?: string; size?: string }) =>
    createElement("button", { ...props, "data-variant": variant }, children as never)
}));
vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ")
}));

// PRODUCT.md principle 2: missing or failed evaluation is never converted into
// a favorable result. On these pages that also means a failed read never
// reads as empty, zero, not found, or clean.
describe("missing evidence never reads as a result", () => {
  it("names a response the page couldn't parse instead of printing the validation dump", () => {
    const parsed = RegressionRunResultSchema.safeParse({ status: "passed" });
    expect(parsed.success).toBe(false);

    expect(loadErrorMessage(parsed.error)).toBe("Rubrist returned a response this page couldn't read.");
    expect(loadErrorMessage(new Error("Skill request failed: 503"))).toBe("Skill request failed: 503");
    expect(loadErrorMessage("offline")).toBe("offline");
  });

  it("offers Retry on a failed page and a failed section", () => {
    const page = renderToStaticMarkup(createElement(PageLoadError, {
      eyebrow: "Judge card",
      title: "Couldn't load this version",
      message: "Skill versions request failed: 500",
      onRetry: () => undefined,
      back: createElement("button", null, "Back to versions")
    }));
    const section = renderToStaticMarkup(createElement(SectionLoadError, {
      title: "Couldn't load the Judge Card.",
      message: "Judge card request failed: 500",
      onRetry: () => undefined
    }));

    expect(page).toContain("Couldn&#x27;t load this version");
    expect(page).toContain("Skill versions request failed: 500");
    expect(page).toContain("Retry");
    expect(page).toContain("Back to versions");
    expect(section).toContain("Couldn&#x27;t load the Judge Card.");
    expect(section).toContain("Judge card request failed: 500");
    expect(section).toContain("Retry");
  });

  it("gives every evaluator page a retryable load error instead of a developer instruction", async () => {
    const [skill, editor, versions, compare] = await Promise.all([
      readWebSource("screens/skill.tsx"),
      readFeatureSource("skill-edit"),
      readWebSource("screens/skill-versions.tsx"),
      readWebSource("screens/compare-versions.tsx")
    ]);

    for (const source of [skill, editor, versions, compare]) {
      expect(source).toContain("<PageLoadError");
      expect(source).toContain("loadErrorMessage(err)");
      expect(source).not.toContain("pnpm dev:api");
    }
  });

  it("derives version regression state from the recorded run, not the version alone", async () => {
    const versions = await readWebSource("screens/skill-versions.tsx");

    expect(versions).toContain("gateStateForVersion(v, regressionRun ?? null)");
    expect(versions).toContain("gateStateForVersion(v, regression)");
    expect(versions).not.toMatch(/gateStateForVersion\(v\)/);
  });

  it("keeps a failed evidence read on the version page visible in its own section", async () => {
    const versions = await readWebSource("screens/skill-versions.tsx");
    const detail = versions.slice(versions.indexOf("export function SkillVersionDetailScreen"));

    expect(detail).toContain('title="Couldn\'t load the Judge Card."');
    expect(detail).toContain('title="Couldn\'t load the regression run."');
    expect(detail).toContain('title="Couldn\'t load the convergence audit."');
    expect(detail).toContain('title="Couldn\'t load self-consistency."');
    expect(detail).not.toMatch(/catch \{\s*if \(!cancelled\) set(?:Convergence|Consistency|JudgeCard)\(null\)/);
    // "Version not found" is for a version that isn't there, never for a failed read.
    expect(detail).not.toContain("{error ?? \"This version may have been archived or removed.\"}");
  });

  it("keeps compare totals unknown until every recorded run on the path has loaded", async () => {
    const compare = await readWebSource("screens/compare-versions.tsx");

    expect(compare).toContain("loadChainStep(version, () => fetchSkillVersionRegression(skillId, version.id))");
    expect(compare).not.toContain(".catch(() => null)");
    expect(compare).toContain('num={totals?.regressed ?? "—"}');
    expect(compare).toContain('num={totals?.improved ?? "—"}');
    expect(compare).toContain("Couldn't load this save's run");
    // The empty list while versions load is not "nothing to compare".
    expect(compare.indexOf("if (listLoading)")).toBeGreaterThan(-1);
    expect(compare.indexOf("if (listLoading)")).toBeLessThan(compare.indexOf('title="Nothing to compare yet"'));
  });

  it("shows unknown top-bar counts as unknown, never zero", async () => {
    const layout = await readWebSource("components/layout/root-layout.tsx");

    expect(layout).toContain("dashboard?.exceptions.length ?? null");
    expect(layout).toContain("dashboard?.project.importedTraceCount ?? null");
    expect(layout).toContain('importedTotal === null ? "—"');
    expect(layout).toContain('exceptionsCount ?? "—"');
    expect(layout).not.toContain("traces this week");
  });

  it("says when the pinned revision's case count can't be read", async () => {
    const editor = await readFeatureSource("skill-edit");

    expect(editor).toContain('"Count unavailable"');
    expect(editor).toContain("referenceCountUnavailable={pinnedReferenceCountUnavailable}");
  });
});
