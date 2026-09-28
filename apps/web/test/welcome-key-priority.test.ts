import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DashboardSummary } from "@rubrist/shared";

const box = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
vi.mock("@/components/ui/card", () => ({ Card: box, CardContent: box }));
vi.mock("@/components/rubrist", () => ({
  Eyebrow: box,
  SectionHead: () => createElement("h1", null, "Get your first Check result"),
  ProvChip: () => null,
  VerdictChip: () => null
}));
vi.mock("@/components/first-project-key", () => ({
  FirstProjectKeyCard: () => createElement("section", { "aria-label": "Save your project key" }, "Unsaved key")
}));
vi.mock("@/components/first-run-setup-ledger", () => ({
  FirstRunSetupLedger: () => createElement("section", { "aria-label": "Setup steps" }, "Setup")
}));
vi.mock("@/components/agent-setup-pairing", () => ({ AgentSetupPairingCard: () => null }));
const { DashboardWelcome } = await import("../src/screens/dashboard-welcome.js");
const { DashboardBenchWelcome } = await import("../src/screens/dashboard-bench-welcome.js");

describe("day-zero one-time key priority", () => {
  it.each([DashboardWelcome, DashboardBenchWelcome])("puts the key before the heading and setup actions for %s", (Screen) => {
    const html = renderToStaticMarkup(createElement(Screen, {
      dashboard: { project: {} } as DashboardSummary,
      canPairAgent: false
    }));
    expect(html.match(/aria-label="Save your project key"/g)).toHaveLength(1);
    const keyIndex = html.indexOf('aria-label="Save your project key"');
    expect(keyIndex).toBeLessThan(html.indexOf("<h1>"));
    expect(keyIndex).toBeLessThan(html.indexOf('aria-label="Setup steps"'));
  });
});
