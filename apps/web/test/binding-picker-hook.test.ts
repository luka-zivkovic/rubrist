// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityCheckInput, CapabilityCheckReport, CapabilityProbe, ExecutionBinding, ReasoningSettings } from "@rubrist/shared";

// The model picker's state (Batch 8F): picks follow the model, a check's
// result never undoes an edit the author made while it ran, and the check
// runs by itself only after the author picks a model. Temperature starts
// empty, as in the editor; the picker fills in 0 only where the check saw it
// accepted with the selected reasoning, and classifies temperature for
// reasoning the check didn't probe it with before save (ADR-0014 decision 12).

const pending: Array<{ input: CapabilityCheckInput; resolve: (report: CapabilityCheckReport) => void }> = [];
vi.mock("../src/components/ui/button.js", () => ({ Button: () => null }));
vi.mock("../src/components/rubrist/index.js", () => ({ Eyebrow: () => null }));
vi.mock("../src/lib/api.js", () => ({
  checkModelCapabilities: vi.fn((input: CapabilityCheckInput) => new Promise<CapabilityCheckReport>((resolve) => { pending.push({ input, resolve }); }))
}));

const { useBindingPicker } = await import("../src/screens/skill-edit/binding-settings.js");

type Model = { provider: "anthropic"; modelId: string; modelVersion: string; baseUrl: string };
const SONNET: Model = { provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "claude-sonnet-4-6", baseUrl: "" };
const OPUS: Model = { provider: "anthropic", modelId: "claude-opus-5-5", modelVersion: "claude-opus-5-5", baseUrl: "" };

const ADAPTIVE: ReasoningSettings = { family: "anthropic", thinking: { type: "adaptive" }, effort: "medium" };
const DISABLED_HIGH: ReasoningSettings = { family: "anthropic", thinking: { type: "disabled" }, effort: "high" };

function report(protocol: CapabilityCheckReport["protocol"], rejectedProtocol: CapabilityCheckReport["protocol"] = null): CapabilityCheckReport {
  const probe = (verdictProtocol: NonNullable<CapabilityCheckReport["protocol"]>, accepted: boolean) => ({
    stage: "capability_check" as const, purpose: "protocol" as const, verdictProtocol,
    sent: { temperature: null, topP: null, reasoning: null, outputTokenLimit: 1_200 },
    outcome: accepted ? "accepted" as const : "rejected" as const, rejection: accepted ? null : "mechanism" as const,
    rejectedParameter: null, failureKind: accepted ? null : "provider_rejected_request" as const, providerMessage: null, usage: null, costMicroUsd: null
  });
  return {
    credentialSource: "project", protocol,
    probes: [...(rejectedProtocol ? [probe(rejectedProtocol, false)] : []), ...(protocol ? [probe(protocol, true)] : [])],
    temperatureSupport: null, reasoningSupport: null, probedReasoning: null, documentedDefault: null,
    reasoningDefaultsVersion: "rubrist-reasoning-defaults/v1", ignoredTemperatureVersion: "rubrist-ignored-temperature/v1", temperatureIgnoredWith: [],
    interrupted: false, published: null, checkedAt: "2026-09-27T00:00:00.000Z"
  };
}

const probe = (purpose: CapabilityProbe["purpose"], sent: { temperature?: number; reasoning?: ReasoningSettings }, accepted = true): CapabilityProbe => ({
  stage: "capability_check", purpose, verdictProtocol: "anthropic.structured-output/v1",
  sent: { temperature: sent.temperature ?? null, topP: null, reasoning: sent.reasoning ?? null, outputTokenLimit: 1_200 },
  outcome: accepted ? "accepted" : "rejected", rejection: accepted ? null : "unattributed", rejectedParameter: null,
  failureKind: accepted ? null : "provider_rejected_request", providerMessage: null, usage: null, costMicroUsd: null
});

/** A check of `reasoning` whose temperature probes went as `temperatures` says (0, then 0.5). */
function checkedWith(reasoning: ReasoningSettings, ...temperatures: boolean[]): CapabilityCheckReport {
  const base = report("anthropic.structured-output/v1");
  return {
    ...base,
    probedReasoning: reasoning,
    documentedDefault: reasoning,
    probes: [...base.probes, probe("reasoning", { reasoning }), ...temperatures.map((accepted, index) => probe("temperature", { temperature: [0, 0.5][index]!, reasoning }, accepted))]
  };
}

let picker: ReturnType<typeof useBindingPicker>;
let setModel: (model: Model) => void;
let temperature: string;
let setTemperature: (value: string) => void;
let container: HTMLDivElement;
let root: Root;

// Like the editor, which owns the temperature and starts it empty.
function Harness({ initial, base }: { initial: Model; base: ExecutionBinding | null }) {
  const [model, set] = useState(initial);
  const [value, setValue] = useState("");
  setModel = set;
  temperature = value;
  setTemperature = setValue;
  picker = useBindingPicker(model, base, { canCheck: true, temperature: value, setTemperature: setValue });
  return null;
}

async function mount(initial: Model, base: ExecutionBinding | null = null) {
  await act(async () => { root.render(createElement(Harness, { initial, base })); });
}

describe("the model picker's state", () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    pending.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("keeps an edit the author made while the check ran", async () => {
    await mount(SONNET);
    let check!: Promise<void>;
    await act(async () => { check = picker.runCheck(); });
    expect(picker.checking).toBe(true);
    await act(async () => picker.setSettings({ outputTokenLimit: "4000" }));
    await act(async () => { pending[0]!.resolve(report("anthropic.structured-output/v1")); await check; });
    expect(picker.settings.outputTokenLimit).toBe("4000");
    expect(picker.checking).toBe(false);
    expect(picker.report?.protocol).toBe("anthropic.structured-output/v1");
  });

  it("keeps each model's picks, and applies a check to the model it checked", async () => {
    await mount(SONNET);
    let check!: Promise<void>;
    await act(async () => { check = picker.runCheck(); });
    await act(async () => setModel(OPUS));
    expect(picker.checking).toBe(false);
    await act(async () => picker.setSettings({ outputTokenLimit: "3000" }));
    await act(async () => { pending[0]!.resolve(report("anthropic.forced-tool/v1", "anthropic.structured-output/v1")); await check; });
    expect(picker.settings.outputTokenLimit).toBe("3000");
    expect(picker.report).toBeNull();
    await act(async () => setModel(SONNET));
    // Sonnet's default protocol was rejected, so the accepted one is pre-selected.
    expect(picker.settings.verdictProtocol).toBe("anthropic.forced-tool/v1");
    expect(picker.report?.protocol).toBe("anthropic.forced-tool/v1");
    // A model version or endpoint fix keeps the model's picks.
    await act(async () => setModel({ ...SONNET, modelVersion: "claude-sonnet-4-6-20260101" }));
    expect(picker.settings.verdictProtocol).toBe("anthropic.forced-tool/v1");
  });

  it("pre-selects the accepted protocol only where the author hasn't chosen one or theirs was rejected", async () => {
    await mount(SONNET);
    await act(async () => picker.setSettings({ verdictProtocol: "prompted-json/v1" }));
    let check!: Promise<void>;
    await act(async () => { check = picker.runCheck(); });
    await act(async () => { pending[0]!.resolve(report("anthropic.structured-output/v1")); await check; });
    expect(picker.settings.verdictProtocol).toBe("prompted-json/v1");

    // A version's saved protocol is its author's choice too.
    await act(async () => picker.load({
      executionBinding: { provider: "anthropic", endpoint: { kind: "managed" }, modelId: OPUS.modelId, modelVersion: OPUS.modelVersion, sampling: { temperature: 0, topP: null }, reasoning: null, outputTokenLimit: 1_200, verdictProtocol: "anthropic.forced-tool/v1", routing: null },
      customEndpointUrl: null
    }));
    await act(async () => setModel(OPUS));
    await act(async () => { check = picker.runCheck(); });
    await act(async () => { pending[1]!.resolve(report("anthropic.structured-output/v1")); await check; });
    expect(picker.settings.verdictProtocol).toBe("anthropic.forced-tool/v1");
  });

  it("doesn't replace reasoning the author chose not to send", async () => {
    await mount(OPUS);
    await act(async () => picker.setSettings({ reasoning: null }));
    let check!: Promise<void>;
    await act(async () => { check = picker.runCheck(); });
    await act(async () => { pending[0]!.resolve({ ...report("anthropic.structured-output/v1"), documentedDefault: { family: "anthropic", thinking: { type: "adaptive" }, effort: "medium" } }); await check; });
    expect(picker.settings.reasoning).toBeNull();
  });

  it("checks a model by itself only after the author picks it", async () => {
    vi.useFakeTimers();
    await mount(SONNET);
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(pending).toHaveLength(0);
    await act(async () => { picker.modelPicked(); setModel(OPUS); });
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(pending.map((call) => call.input.modelId)).toEqual([OPUS.modelId]);
    await act(async () => { pending[0]!.resolve({ ...report("anthropic.structured-output/v1"), probedReasoning: ADAPTIVE }); });
    // Returning to a model already checked, or loading a version, doesn't check again.
    await act(async () => { picker.modelPicked(); setModel(SONNET); });
    await act(async () => { picker.modelPicked(); setModel(OPUS); });
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(pending).toHaveLength(1);
  });

  it("saves no temperature where the model doesn't let the author choose it with the selected reasoning", async () => {
    await mount(OPUS);
    let check!: Promise<void>;
    await act(async () => { check = picker.runCheck(); });
    expect(picker.settings.reasoning).toEqual(ADAPTIVE);
    await act(async () => { pending[0]!.resolve({ ...checkedWith(ADAPTIVE, false, false), temperatureSupport: "not_adjustable" }); await check; });
    expect(picker.guidance.temperature).toMatchObject({ shown: false, hidden: "not_adjustable" });
    expect(temperature).toBe("");
    expect(picker.savedFields("0")).toMatchObject({ temperature: "", reasoning: ADAPTIVE });
  });

  it("starts temperature empty, and fills in 0 only where the check saw 0 accepted with the selected reasoning", async () => {
    await mount(SONNET);
    expect(temperature).toBe("");
    let check!: Promise<void>;
    await act(async () => { check = picker.runCheck(); });
    await act(async () => { pending[0]!.resolve(checkedWith(DISABLED_HIGH, true)); await check; });
    expect(picker.settings.reasoning).toEqual(DISABLED_HIGH);
    expect(temperature).toBe("0");
    expect(picker.guidance.temperature.guidance).toBe("accepted");

    // Where only 0.5 was accepted, the field stays empty for the author to state a value.
    await act(async () => setModel(OPUS));
    await act(async () => { setTemperature(""); check = picker.runCheck(); });
    await act(async () => { pending[1]!.resolve(checkedWith(ADAPTIVE, false, true)); await check; });
    expect(temperature).toBe("");
    expect(picker.guidance.temperature).toMatchObject({ shown: true, zeroRejected: true, acceptedValue: 0.5 });
  });

  it("classifies temperature for newly selected reasoning before save, once, and fills in 0 where it was accepted", async () => {
    vi.useFakeTimers();
    await mount(OPUS);
    let check!: Promise<void>;
    await act(async () => { check = picker.runCheck(); });
    await act(async () => { pending[0]!.resolve(checkedWith(ADAPTIVE, false, false)); await check; });
    expect(picker.temperaturePending).toBe(false);

    await act(async () => picker.setSettings({ reasoning: DISABLED_HIGH }));
    // Saving waits from the moment the author selects it.
    expect(picker.temperaturePending).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(pending).toHaveLength(2);
    expect(pending[1]!.input).toMatchObject({
      modelId: OPUS.modelId,
      classifyTemperature: { reasoning: DISABLED_HIGH, verdictProtocol: "anthropic.structured-output/v1", baselineAccepted: false }
    });
    await act(async () => {
      pending[1]!.resolve({ ...checkedWith(DISABLED_HIGH, true), probes: [probe("reasoning", { reasoning: DISABLED_HIGH }), probe("temperature", { temperature: 0, reasoning: DISABLED_HIGH })] });
    });
    expect(picker.temperaturePending).toBe(false);
    expect(picker.guidance.temperature).toMatchObject({ shown: true, support: "adjustable", acceptedValue: 0 });
    expect(temperature).toBe("0");

    // Back to the checked reasoning, and to the classified one again: nothing more is sent.
    await act(async () => picker.setSettings({ reasoning: ADAPTIVE }));
    await act(async () => picker.setSettings({ reasoning: DISABLED_HIGH }));
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(pending).toHaveLength(2);
  });

  it("skips the reasoning call the check already saw accepted, and empties a 0 it filled once 0 is rejected", async () => {
    vi.useFakeTimers();
    await mount(SONNET);
    const noThinking: ReasoningSettings = { family: "anthropic", thinking: { type: "disabled" }, effort: null };
    let check!: Promise<void>;
    await act(async () => { check = picker.runCheck(); });
    await act(async () => {
      const checked = checkedWith(DISABLED_HIGH, true);
      pending[0]!.resolve({ ...checked, probes: [...checked.probes, probe("reasoning", { reasoning: noThinking })] });
      await check;
    });
    expect(temperature).toBe("0");

    await act(async () => picker.setSettings({ reasoning: noThinking }));
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(pending[1]!.input.classifyTemperature).toEqual({ reasoning: noThinking, verdictProtocol: "anthropic.structured-output/v1", baselineAccepted: true });
    await act(async () => {
      pending[1]!.resolve({ ...checkedWith(noThinking), probes: [probe("temperature", { temperature: 0, reasoning: noThinking }, false), probe("temperature", { temperature: 0.5, reasoning: noThinking })] });
    });
    expect(picker.guidance.temperature).toMatchObject({ shown: true, zeroRejected: true });
    expect(temperature).toBe("");
  });

  it("doesn't classify again after a classification fails, leaving the field empty for resolution to decide", async () => {
    vi.useFakeTimers();
    await mount(OPUS);
    let check!: Promise<void>;
    await act(async () => { check = picker.runCheck(); });
    await act(async () => { pending[0]!.resolve(checkedWith(ADAPTIVE, false, false)); await check; });
    const { checkModelCapabilities } = await import("../src/lib/api.js");
    vi.mocked(checkModelCapabilities).mockRejectedValueOnce(new Error("Rate limit exceeded: 10 capability checks/minute."));
    await act(async () => picker.setSettings({ reasoning: DISABLED_HIGH }));
    await act(async () => { vi.advanceTimersByTime(1_000); });
    await act(async () => { await Promise.resolve(); });
    expect(picker.temperaturePending).toBe(false);
    expect(picker.checkError).toContain("Rate limit exceeded");
    expect(picker.guidance.temperature).toMatchObject({ shown: true, support: null });
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(pending).toHaveLength(1);
    expect(temperature).toBe("");
  });
});
