import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RegressionRunResultSchema, type Skill, type SkillVersion } from "@rubrist/shared";
import { ApiError } from "../src/lib/api/transport.js";
import { loadFailure } from "../src/lib/load-error.js";
import { PageLoadError, SectionLoadError } from "../src/components/rubrist/load-error.js";
import { readWebSource } from "./support/web-extraction-contracts.js";

type Props = Record<string, unknown> & { children?: ReactNode };
const box = (tag: string) => ({ children }: Props) => createElement(tag, null, children);

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, variant, size: _size, ...props }: Props) =>
    createElement("button", { ...props, "data-variant": variant }, children)
}));
vi.mock("@/components/ui/card", () => ({
  Card: box("div"),
  CardContent: box("div"),
  CardHeader: box("div"),
  CardTitle: box("h2"),
  CardDescription: box("p")
}));
vi.mock("@/components/rubrist", () => ({
  Chip: box("span"),
  Eyebrow: box("div"),
  KPI: box("div"),
  KPIRow: box("div"),
  MarginNote: box("aside"),
  RegressionDiffTable: box("section"),
  SectionHead: ({ title }: Props) => createElement("h1", null, title as ReactNode)
}));
vi.mock("@/components/skill-edit-flow", () => ({ SkillEditFlow: () => createElement("section") }));
vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ")
}));

// Imported after the mocks above: they use `box`, which static imports would
// run ahead of.
const { RegressionRunning } = await import("../src/screens/skill-edit/regression.js");

// PRODUCT.md principle 2: missing or failed evaluation is never converted into
// a favorable result. On these pages that also means a failed read never
// reads as empty, zero, not found, or clean. missing-evidence-screens.test.ts
// covers the same rule on the rendered screens.
describe("missing evidence never reads as a result", () => {
  it("names a failed read, and offers Retry only when retrying can work", () => {
    const parsed = RegressionRunResultSchema.safeParse({ status: "passed" });
    expect(parsed.success).toBe(false);

    expect(loadFailure(parsed.error)).toEqual({
      message: "Rubrist returned a response this page couldn't read.",
      retryable: false
    });
    expect(loadFailure(new ApiError("Skill request failed: 503", 503))).toEqual({ message: "Skill request failed: 503", retryable: true });
    expect(loadFailure(new ApiError("Request timed out", 408)).retryable).toBe(true);
    expect(loadFailure(new ApiError("Too many requests", 429)).retryable).toBe(true);
    expect(loadFailure(new ApiError("No evaluator exists for this criterion", 404)).retryable).toBe(false);
    expect(loadFailure(new ApiError("Forbidden", 403)).retryable).toBe(false);
    expect(loadFailure(new ApiError("Not configured", 501)).retryable).toBe(false);
    // Signing in again can make the same read work.
    expect(loadFailure(new ApiError("Sign in required", 401)).retryable).toBe(true);
    // Some helpers rethrow a parse failure as an ApiError with the success status.
    expect(loadFailure(new ApiError('[{"code":"invalid_type"}]', 200))).toEqual({
      message: "Rubrist returned a response this page couldn't read.",
      retryable: false
    });
    expect(loadFailure(new TypeError("Failed to fetch"))).toEqual({ message: "Failed to fetch", retryable: true });
    // A body that isn't JSON, often a proxy's error page, can be transient.
    expect(loadFailure(new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON"))).toEqual({
      message: "Rubrist returned a response this page couldn't read.",
      retryable: true
    });
    expect(loadFailure("offline")).toEqual({ message: "offline", retryable: true });
  });

  it("offers Retry on a failed page only when retrying can work", () => {
    const back = createElement("button", null, "Back to versions");
    const retryable = renderToStaticMarkup(createElement(PageLoadError, {
      eyebrow: "Judge card",
      title: "Couldn't load this version",
      failure: { message: "Skill versions request failed: 500", retryable: true },
      onRetry: () => undefined,
      back
    }));
    const refused = renderToStaticMarkup(createElement(PageLoadError, {
      title: "Couldn't load the skill",
      failure: { message: "No evaluator exists for this criterion", retryable: false },
      onRetry: () => undefined,
      back
    }));

    expect(retryable).toContain("Couldn&#x27;t load this version");
    expect(retryable).toContain("Skill versions request failed: 500");
    expect(retryable).toContain("Retry");
    expect(retryable).toContain("Back to versions");
    expect(refused).toContain("No evaluator exists for this criterion");
    expect(refused).not.toContain("Retry");
    expect(refused).toContain("Back to versions");
  });

  it("keeps a failed section's error in place while its retry is in flight", () => {
    const failure = { message: "Judge card request failed: 500", retryable: true };
    const idle = renderToStaticMarkup(createElement(SectionLoadError, {
      title: "Couldn't load the Judge Card.",
      failure,
      onRetry: () => undefined
    }));
    const retrying = renderToStaticMarkup(createElement(SectionLoadError, {
      title: "Couldn't load the Judge Card.",
      failure,
      onRetry: () => undefined,
      retrying: true
    }));

    expect(idle).toContain("Couldn&#x27;t load the Judge Card.");
    expect(idle).toContain("Judge card request failed: 500");
    expect(idle).toContain("Retry");
    expect(retrying).toContain("Judge card request failed: 500");
    expect(retrying).toContain("Retrying…");
    expect(retrying).toMatch(/<button[^>]*disabled/);
  });

  it("says when the pinned revision's case count can't be read, instead of loading it forever", () => {
    const version = { id: "skillv_2", version: "1.0.2", regressionDatasetRevisionId: "revision_1" } as SkillVersion;
    const skill = { name: "Support answer quality" } as Skill;
    const running = (referenceCount: number | null, referenceCountUnavailable: boolean) =>
      renderToStaticMarkup(createElement(RegressionRunning, {
        skill,
        baseVersion: "1.0.1",
        version,
        firstRun: false,
        criterionVersion: null,
        referenceCount,
        referenceCountUnavailable,
        pollError: null,
        onOpenHistory: () => undefined
      }));

    expect(running(null, false)).toContain("Loading exact count…");
    expect(running(null, true)).toContain("Count unavailable");
    expect(running(null, true)).not.toContain("Loading exact count…");
    expect(running(7, false)).toContain("<dd>7</dd>");
  });

  it("says polling stopped when retrying the status refresh can't work", () => {
    const version = { id: "skillv_2", version: "1.0.2", regressionDatasetRevisionId: "revision_1" } as SkillVersion;
    const skill = { name: "Support answer quality" } as Skill;
    const running = (pollError: { message: string; retryable: boolean }) =>
      renderToStaticMarkup(createElement(RegressionRunning, {
        skill,
        baseVersion: "1.0.1",
        version,
        firstRun: false,
        criterionVersion: null,
        referenceCount: 7,
        referenceCountUnavailable: false,
        pollError,
        onOpenHistory: () => undefined
      }));

    const retrying = running({ message: "Regression run request failed: 503", retryable: true });
    const stopped = running({ message: "Skill version not found", retryable: false });

    expect(retrying).toContain("this page will keep retrying");
    expect(stopped).toContain("Skill version not found");
    expect(stopped).toContain("Open Version history to follow it");
    expect(stopped).not.toContain("keep retrying");
    // The page no longer follows the check, so it doesn't claim it's running.
    expect(retrying).toContain("Regression check running");
    expect(retrying).toContain("animate-spin");
    expect(stopped).toContain("Regression check status unavailable");
    expect(stopped).not.toContain("animate-spin");
  });

  // The root layout needs the whole app's providers to render, so the top bar
  // is checked in source.
  it("shows unknown top-bar counts as unknown, never zero", async () => {
    const layout = await readWebSource("components/layout/root-layout.tsx");

    expect(layout).toContain("dashboard?.exceptionsTotal ?? null");
    expect(layout).toContain("dashboard?.project.importedTraceCount ?? null");
    expect(layout).toContain('importedTotal === null ? "—"');
    expect(layout).toContain('exceptionsCount ?? "—"');
    expect(layout).not.toContain("traces this week");
  });
});
