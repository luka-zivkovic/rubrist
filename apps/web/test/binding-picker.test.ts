import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityCheckReport, CapabilityProbe, ReasoningSettings } from "@rubrist/shared";
import {
  bindingPickerGuidance,
  pickerBlockingProblems,
  reasoningAccepted,
  reasoningOffered,
  sameReasoning
} from "../src/lib/binding-picker.js";

vi.mock("../src/components/ui/button.js", () => ({ Button: ({ children, ...props }: { children?: unknown }) => createElement("button", props, children as never) }));
vi.mock("../src/lib/api.js", () => ({ checkModelCapabilities: vi.fn() }));
vi.mock("../src/components/rubrist/index.js", () => ({ Eyebrow: ({ children }: { children?: unknown }) => createElement("span", null, children as never) }));

const { BindingSettings } = await import("../src/screens/skill-edit/binding-settings.js");

// The model picker (ADR-0014 section 4, founder decision 1): it hides a field
// the model rejects outright, doesn't offer a value it rejects, and marks an
// untested setting "confirmed at resolution". Temperature follows decision
// 12: it is hidden where the model doesn't let the author choose it with the
// selected reasoning, or is listed as ignoring it.
//
// The probes below have the shapes the server's capability check sends
// (apps/api/src/lib/evaluator-resolution.ts): the reasoning probes send the
// default (or a middle value) and the family's no-reasoning setting, which
// for Anthropic is thinking disabled with no effort; then the temperature
// probes send 0, and 0.5 only where 0 was rejected, with the default
// reasoning, once that request was accepted without temperature.

const ADAPTIVE: ReasoningSettings = { family: "anthropic", thinking: { type: "adaptive" }, effort: "medium" };
const NO_REASONING: ReasoningSettings = { family: "anthropic", thinking: { type: "disabled" }, effort: null };

function probe(overrides: Partial<CapabilityProbe>): CapabilityProbe {
  return {
    stage: "capability_check", purpose: "protocol", verdictProtocol: "anthropic.structured-output/v1",
    sent: { temperature: null, topP: null, reasoning: null, outputTokenLimit: 1_200 },
    outcome: "accepted", rejection: null, rejectedParameter: null, failureKind: null, providerMessage: null,
    usage: null, costMicroUsd: null,
    ...overrides
  };
}

const REFUSED = { outcome: "rejected", rejection: "parameter", rejectedParameter: "temperature", failureKind: "provider_rejected_request" } as const;
/** A temperature probe at `temperature` with `reasoning`, accepted or refused. */
const temperatureProbe = (temperature: number, reasoning: ReasoningSettings | null, accepted: boolean) =>
  probe({ purpose: "temperature", sent: { temperature, topP: null, reasoning, outputTokenLimit: 1_200 }, ...(accepted ? {} : REFUSED) });
const reasoningProbe = (reasoning: ReasoningSettings, accepted = true) => probe({
  purpose: "reasoning", sent: { temperature: null, topP: null, reasoning, outputTokenLimit: 1_200 },
  ...(accepted ? {} : { outcome: "rejected", rejection: "value", rejectedParameter: "reasoning", failureKind: "provider_rejected_request" })
});

function report(overrides: Partial<CapabilityCheckReport> = {}): CapabilityCheckReport {
  return {
    credentialSource: "project", protocol: "anthropic.structured-output/v1",
    probes: [
      probe({}),
      reasoningProbe(ADAPTIVE),
      reasoningProbe(NO_REASONING, false),
      temperatureProbe(0, ADAPTIVE, false),
      temperatureProbe(0.5, ADAPTIVE, false)
    ],
    temperatureSupport: "not_adjustable", reasoningSupport: "accepted", probedReasoning: ADAPTIVE,
    documentedDefault: ADAPTIVE, reasoningDefaultsVersion: "rubrist-reasoning-defaults/v1",
    ignoredTemperatureVersion: "rubrist-ignored-temperature/v1", temperatureIgnoredWith: [],
    interrupted: false, published: null, checkedAt: "2026-09-26T00:00:00.000Z",
    ...overrides
  };
}

/** A check with no reasoning fields sent (no table entry), whose temperature probes went as given. */
const withTemperatures = (...temperatures: CapabilityProbe[]) => report({
  temperatureSupport: null, probedReasoning: null, documentedDefault: null,
  probes: [probe({}), ...temperatures]
});

describe("model picker guidance", () => {
  it("offers every field, with no guidance and nothing filled in, before a check has run", () => {
    const guidance = bindingPickerGuidance("anthropic", null, { reasoning: ADAPTIVE, temperature: "" });
    expect(guidance).toMatchObject({
      temperature: { shown: true, hidden: null, support: null, guidance: null, acceptedValue: null, zeroRejected: false },
      reasoning: { shown: true, guidance: null },
      rejectedReasoning: []
    });
    expect(guidance.protocols.map((option) => option.guidance)).toEqual([null, null, null]);
  });

  it("fills in 0 only where the check saw 0 accepted with the selected reasoning", () => {
    const zero = withTemperatures(temperatureProbe(0, null, true));
    expect(bindingPickerGuidance("openai", zero, { reasoning: null, temperature: "" }).temperature)
      .toEqual({ shown: true, hidden: null, support: "adjustable", guidance: null, acceptedValue: 0, zeroRejected: false });
    expect(bindingPickerGuidance("openai", zero, { reasoning: null, temperature: "0" }).temperature.guidance).toBe("accepted");
    // Another value was never tried.
    expect(bindingPickerGuidance("openai", zero, { reasoning: null, temperature: "0.7" }).temperature.guidance).toBe("confirmed at resolution");
  });

  it("shows the field empty with 0 marked rejected where only 0.5 was accepted", () => {
    const half = withTemperatures(temperatureProbe(0, null, false), temperatureProbe(0.5, null, true));
    expect(bindingPickerGuidance("openai", half, { reasoning: null, temperature: "" }).temperature)
      .toEqual({ shown: true, hidden: null, support: "adjustable", guidance: null, acceptedValue: 0.5, zeroRejected: true });
    const zero = bindingPickerGuidance("openai", half, { reasoning: null, temperature: "0" });
    expect(zero.temperature.guidance).toBe("rejected");
    expect(pickerBlockingProblems(zero, { verdictProtocol: "openai.structured-output/v1" }))
      .toEqual(["The model rejected this temperature in the check; choose another value."]);
    expect(bindingPickerGuidance("openai", half, { reasoning: null, temperature: "0.5" }).temperature.guidance).toBe("accepted");
    expect(bindingPickerGuidance("openai", half, { reasoning: null, temperature: "0.3" }).temperature.guidance).toBe("confirmed at resolution");
  });

  it("hides temperature, saying why, where 0 and 0.5 were both rejected with the selected reasoning", () => {
    expect(bindingPickerGuidance("anthropic", report(), { reasoning: ADAPTIVE, temperature: "0" }).temperature)
      .toEqual({ shown: false, hidden: "not_adjustable", support: "not_adjustable", guidance: null, acceptedValue: null, zeroRejected: false });
    // The answer holds only for the reasoning it was probed with.
    expect(bindingPickerGuidance("anthropic", report(), { reasoning: { ...ADAPTIVE, effort: "high" }, temperature: "" }).temperature)
      .toMatchObject({ shown: true, support: null, guidance: null });
  });

  it("hides temperature where the ignored-temperature table lists the model with the selected reasoning", () => {
    const listed = withTemperatures();
    const ignoring = { ...listed, temperatureIgnoredWith: [null] };
    expect(bindingPickerGuidance("custom", ignoring, { reasoning: null, temperature: "0" }).temperature)
      .toMatchObject({ shown: false, hidden: "ignored", guidance: null });
    expect(bindingPickerGuidance("custom", ignoring, { reasoning: { family: "openai", effort: "none" }, temperature: "" }).temperature)
      .toMatchObject({ shown: true, hidden: null });
  });

  it("shows the field empty where the temperature probes ended in errors, or never ran", () => {
    const errored = withTemperatures(probe({ purpose: "temperature", sent: { temperature: 0, topP: null, reasoning: null, outputTokenLimit: 1_200 }, outcome: "error", failureKind: "provider_timeout" }));
    expect(bindingPickerGuidance("openai", errored, { reasoning: null, temperature: "" }).temperature)
      .toEqual({ shown: true, hidden: null, support: null, guidance: null, acceptedValue: null, zeroRejected: false });
    expect(bindingPickerGuidance("openai", errored, { reasoning: null, temperature: "0" }).temperature.guidance).toBe("confirmed at resolution");
    // With no accepted request to add it to, a temperature probe answers nothing.
    const noBaseline = report({ probes: [probe({}), reasoningProbe(ADAPTIVE, false), temperatureProbe(0, ADAPTIVE, true)] });
    expect(bindingPickerGuidance("anthropic", noBaseline, { reasoning: ADAPTIVE, temperature: "" }).temperature).toMatchObject({ support: null, acceptedValue: null });
  });

  it("judges temperature with the reasoning the binding sends, none where the model rejects the reasoning parameter", () => {
    const rejectsReasoning = { ...withTemperatures(temperatureProbe(0, null, true)), reasoningSupport: "parameter_rejected" as const };
    expect(bindingPickerGuidance("openai", rejectsReasoning, { reasoning: { family: "openai", effort: "high" }, temperature: "" }).temperature)
      .toMatchObject({ shown: true, support: "adjustable", acceptedValue: 0 });
    expect(bindingPickerGuidance("openai", withTemperatures(temperatureProbe(0, null, true)), { reasoning: { family: "openai", effort: "high" }, temperature: "" }).temperature)
      .toMatchObject({ support: null, acceptedValue: null });
  });

  it("reads a classification for newly selected reasoning alongside the check", () => {
    const disabled: ReasoningSettings = { family: "anthropic", thinking: { type: "disabled" }, effort: "high" };
    const classified = report({ probes: [...report().probes, reasoningProbe(disabled), temperatureProbe(0, disabled, true)] });
    expect(bindingPickerGuidance("anthropic", classified, { reasoning: disabled, temperature: "" }).temperature)
      .toMatchObject({ shown: true, support: "adjustable", acceptedValue: 0 });
    expect(bindingPickerGuidance("anthropic", classified, { reasoning: ADAPTIVE, temperature: "" }).temperature).toMatchObject({ shown: false, hidden: "not_adjustable" });
  });

  it("marks the protocols the check tried, and those the provider's published data rules out", () => {
    expect(bindingPickerGuidance("anthropic", report(), { reasoning: ADAPTIVE, temperature: "" }).protocols).toEqual([
      { protocol: "anthropic.structured-output/v1", guidance: "accepted" },
      { protocol: "anthropic.forced-tool/v1", guidance: "confirmed at resolution" },
      { protocol: "prompted-json/v1", guidance: "confirmed at resolution" }
    ]);
    const noStructured = report({
      protocol: "anthropic.forced-tool/v1",
      probes: [probe({ verdictProtocol: "anthropic.forced-tool/v1" })],
      published: { structuredOutput: false, toolUse: null, temperature: null, topP: null, reasoning: true, thinkingTypes: null, effortLevels: null }
    });
    expect(bindingPickerGuidance("anthropic", noStructured, { reasoning: ADAPTIVE, temperature: "" }).protocols.map((option) => option.guidance))
      .toEqual(["rejected", "accepted", "confirmed at resolution"]);
  });

  it("doesn't offer a reasoning mode the model rejected, whatever effort the option carries", () => {
    const guidance = bindingPickerGuidance("anthropic", report(), { reasoning: ADAPTIVE, temperature: "" });
    expect(guidance.reasoning).toEqual({ shown: true, guidance: "accepted" });
    // The no-reasoning probe sent thinking disabled with no effort; every disabled option adds to it.
    for (const effort of [null, "low", "medium", "max"] as const) {
      expect(reasoningOffered(guidance, { family: "anthropic", thinking: { type: "disabled" }, effort }), String(effort)).toBe(false);
    }
    expect(reasoningOffered(guidance, ADAPTIVE)).toBe(true);
    expect(reasoningAccepted(guidance, ADAPTIVE)).toBe(true);
    expect(reasoningAccepted(guidance, { ...ADAPTIVE, effort: "max" })).toBe(false);
    expect(bindingPickerGuidance("anthropic", report(), { reasoning: { family: "anthropic", thinking: { type: "disabled" }, effort: "medium" }, temperature: "" }).reasoning.guidance)
      .toBe("rejected");
    expect(bindingPickerGuidance("anthropic", report(), { reasoning: { ...ADAPTIVE, effort: "max" }, temperature: "" }).reasoning.guidance).toBe("confirmed at resolution");
  });

  it("hides reasoning the model rejects as a parameter, and every setting a provider doesn't take", () => {
    expect(bindingPickerGuidance("anthropic", report({ reasoningSupport: "parameter_rejected" }), { reasoning: null, temperature: "" }).reasoning).toEqual({ shown: false, guidance: null });
    expect(bindingPickerGuidance("mock", null, { reasoning: null, temperature: "" })).toMatchObject({ temperature: { shown: false, hidden: "no_sampling" }, reasoning: { shown: false } });
    expect(bindingPickerGuidance("typesafe", null, { reasoning: null, temperature: "" })).toMatchObject({
      temperature: { shown: false }, reasoning: { shown: false }, protocols: [{ protocol: "typed-question/v1", guidance: null }]
    });
  });

  it("blocks saving a protocol, reasoning, or temperature the check saw rejected", () => {
    const disabled: ReasoningSettings = { family: "anthropic", thinking: { type: "disabled" }, effort: "high" };
    expect(pickerBlockingProblems(bindingPickerGuidance("anthropic", report(), { reasoning: disabled, temperature: "" }), { verdictProtocol: "anthropic.structured-output/v1" }))
      .toEqual(["The model rejected this reasoning setting in the check; choose another."]);
    const rejectedProtocol = report({ protocol: "anthropic.forced-tool/v1", probes: [probe({ outcome: "rejected", rejection: "mechanism", failureKind: "provider_rejected_request" }), probe({ verdictProtocol: "anthropic.forced-tool/v1" })] });
    expect(pickerBlockingProblems(bindingPickerGuidance("anthropic", rejectedProtocol, { reasoning: ADAPTIVE, temperature: "" }), { verdictProtocol: "anthropic.structured-output/v1" }))
      .toEqual(["The model rejected anthropic.structured-output/v1 in the check; choose another verdict protocol."]);
    expect(pickerBlockingProblems(bindingPickerGuidance("anthropic", report(), { reasoning: ADAPTIVE, temperature: "0" }), { verdictProtocol: "anthropic.structured-output/v1" })).toEqual([]);
  });

  it("compares reasoning settings regardless of key order", () => {
    expect(sameReasoning(ADAPTIVE, { effort: "medium", thinking: { type: "adaptive" }, family: "anthropic" })).toBe(true);
    expect(sameReasoning(ADAPTIVE, null)).toBe(false);
  });
});

describe("the binding settings fields", () => {
  const picker = (checkReport: CapabilityCheckReport | null, reasoning: ReasoningSettings | null, temperature = "0") => {
    const guidance = bindingPickerGuidance("anthropic", checkReport, { reasoning, temperature });
    return {
      settings: { reasoning, verdictProtocol: "anthropic.structured-output/v1" as const, outputTokenLimit: "1200" },
      setSettings: vi.fn(), load: vi.fn(), modelPicked: vi.fn(), report: checkReport, guidance,
      checking: false, checkError: null, runCheck: vi.fn(), savedFields: vi.fn(), temperaturePending: false,
      blockingProblems: pickerBlockingProblems(guidance, { verdictProtocol: "anthropic.structured-output/v1" })
    };
  };
  const render = (checkReport: CapabilityCheckReport | null, reasoning: ReasoningSettings | null, temperature = "0") => renderToStaticMarkup(createElement(BindingSettings, {
    provider: "anthropic", temperature, setTemperature: vi.fn(), temperatureValid: true,
    picker: picker(checkReport, reasoning, temperature) as never, canCheck: true
  }));

  it("hides temperature the model doesn't let the author choose and says why, and marks rejected and accepted reasoning options", () => {
    const html = render(report(), ADAPTIVE);
    expect(html).toContain("The model doesn&#x27;t let you choose temperature with this reasoning: it rejected 0 and 0.5 in the check, so none is sent and the model sets it.");
    expect(html).not.toContain('type="number" min="0" max="2"');
    expect(html).toContain("Thinking disabled (rejected by the model)");
    expect(html).toContain("Adaptive thinking (accepted)");
    expect(html).toContain("anthropic.structured-output/v1 (accepted)");
    expect(html).toContain("Checked with 5 probes: anthropic.structured-output/v1 accepted.");
    expect(html).toContain("Check again");
  });

  const openAIField = (checkReport: CapabilityCheckReport, temperature: string, pending = false) => renderToStaticMarkup(createElement(BindingSettings, {
    provider: "openai", temperature, setTemperature: vi.fn(), temperatureValid: true, canCheck: true,
    picker: {
      ...picker(null, null),
      report: checkReport,
      guidance: bindingPickerGuidance("openai", checkReport, { reasoning: null, temperature }),
      settings: { reasoning: null, verdictProtocol: "openai.structured-output/v1", outputTokenLimit: "" },
      blockingProblems: [],
      temperaturePending: pending
    } as never
  }));

  it("says which temperature the check accepted when the author's differs, and asks for one where 0 was rejected", () => {
    expect(openAIField(withTemperatures(temperatureProbe(0, null, true)), "0.7")).toContain("The check accepted temperature 0; 0.7 is confirmed at resolution after save.");
    const half = withTemperatures(temperatureProbe(0, null, false), temperatureProbe(0.5, null, true));
    expect(openAIField(half, "")).toContain("The model rejected 0 with this reasoning and accepted 0.5; state the temperature to send.");
  });

  it("hides temperature a listed model ignores, and says a classification is under way", () => {
    const ignoring = { ...withTemperatures(), temperatureIgnoredWith: [null] };
    expect(openAIField(ignoring, "")).toContain("The model ignores temperature with this reasoning, as its provider documents (rubrist-ignored-temperature/v1), so none is sent.");
    expect(openAIField(withTemperatures(), "", true)).toContain("Checking which temperatures the model takes with this reasoning…");
  });

  it("keeps a selected value the provider doesn't publish, marked, rather than showing another", () => {
    const published = report({ published: { structuredOutput: true, toolUse: null, temperature: null, topP: null, reasoning: true, thinkingTypes: ["adaptive"], effortLevels: ["low", "medium"] } });
    const enabledMax: ReasoningSettings = { family: "anthropic", thinking: { type: "enabled", budgetTokens: 2_048 }, effort: "max" };
    const html = render(published, enabledMax);
    expect(html).toContain('<option value="enabled" selected="">Thinking with a budget (not offered by the model)</option>');
    expect(html).toContain('<option value="max" selected="">Effort max (not offered by the model)</option>');
    expect(html).not.toContain("Effort high");
  });

  it("says the check ended early", () => {
    const html = render(report({ protocol: null, interrupted: true, probes: [probe({ outcome: "error", failureKind: "provider_timeout" })] }), ADAPTIVE);
    expect(html).toContain("Checked with 1 probe: no protocol confirmed. The check ended early; what it didn&#x27;t reach is confirmed at resolution after save.");
  });

  it("shows every field before a check, and states the limit's problem", () => {
    const html = render(null, ADAPTIVE);
    expect(html).toContain("Check model");
    expect(html).toContain("Picking a model checks it (up to 7 calls)");
    expect(html).toContain('placeholder="not sent"');
    expect(html).toContain("Anthropic requires a limit.");
    const blank = renderToStaticMarkup(createElement(BindingSettings, {
      provider: "anthropic", temperature: "0", setTemperature: vi.fn(), temperatureValid: true, canCheck: false,
      picker: { ...picker(null, ADAPTIVE), settings: { reasoning: { family: "anthropic", thinking: { type: "enabled", budgetTokens: 2_048 }, effort: null }, verdictProtocol: "anthropic.structured-output/v1", outputTokenLimit: "2000" } } as never
    }));
    expect(blank).toContain("The limit must exceed the thinking budget of 2048 tokens.");
    expect(blank).toContain("Choose a model whose provider has a key to check which settings it takes.");
  });

  it("lists what blocks saving", () => {
    const html = render(report(), { family: "anthropic", thinking: { type: "disabled" }, effort: "high" });
    expect(html).toContain("The model rejected this reasoning setting in the check; choose another.");
  });
});
