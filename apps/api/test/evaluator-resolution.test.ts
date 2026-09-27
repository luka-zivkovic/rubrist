import { EvaluatorCallError, type ExecutionFetch } from "@rubrist/audit/runtime";
import {
  IGNORED_TEMPERATURE_VERSION,
  ResolutionRecordSchema,
  documentedReasoningDefault,
  type ExecutionBinding,
  type IgnoredTemperatureEntry,
  type ReasoningSettings
} from "@rubrist/shared";
import { describe, expect, it } from "vitest";
import { anthropicPublishedCapabilities, openRouterPublishedCapabilities } from "../src/lib/evaluator-capability.js";
import {
  CAPABILITY_PROBE_INPUT,
  classifyTemperatureFor,
  governedGateProblems,
  middleReasoning,
  noReasoning,
  recheckExecutionBinding,
  resolveExecutionBinding,
  runCapabilityCheck,
  bindingProbeExecutor,
  type CapabilityCheckResult,
  type ProbeExecutor
} from "../src/lib/evaluator-resolution.js";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const ADAPTIVE: ReasoningSettings = { family: "anthropic", thinking: { type: "adaptive" }, effort: "medium" };
const DISABLED: ReasoningSettings = { family: "anthropic", thinking: { type: "disabled" }, effort: null };
const USAGE = { inputTokens: 90, outputTokens: 12 };

const BASE = {
  provider: "anthropic" as const,
  endpoint: { kind: "managed" as const },
  modelId: "claude-opus-5-5",
  modelVersion: "claude-opus-5-5",
  outputTokenLimit: 1200,
  routing: null
};

const OPUS_PUBLISHED = anthropicPublishedCapabilities("claude-opus-5-5", {
  effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true } },
  structured_outputs: { supported: true },
  thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } }
});

function rejection(message: string, kind: EvaluatorCallError["failureKind"] = "provider_rejected_request", physicalCall = true) {
  return new EvaluatorCallError(kind, message, {
    physicalCall,
    status: kind === "provider_rejected_request" ? 400 : kind === "provider_protocol" ? 200 : 503,
    providerError: { type: "invalid_request_error", code: null, param: null, message, raw: null, upstreamProvider: null },
    usage: kind === "provider_rejected_request" ? null : { inputTokens: 5, outputTokens: 0 }
  });
}

/**
 * How a model treats an explicit temperature (ADR-0014 decision 12, and
 * docs/temperature-behaviour-2026-09-27.md): it takes any value, only its
 * default of 1, 0.5 but not 0, only 0.7, or it answers but breaks the
 * protocol, or fails transiently.
 */
type TemperatureBehaviour = "accepted" | "only-default" | "zero-rejected" | "only-0.7" | "breaks-protocol" | "error";

// The words the study saw rejecting the same fact; none of them classifies it.
const TEMPERATURE_WORDING = {
  parameter: "`temperature` is deprecated for this model.",
  value: "`temperature` may only be set to 1 when thinking is enabled.",
  unattributed: "Invalid request."
} as const;

interface SimulatedModel {
  /** Protocols the model can't do, rejected by naming the mechanism. */
  rejectsProtocols?: string[];
  /** How the model treats an explicit temperature, per reasoning where that matters. */
  temperature?: TemperatureBehaviour | ((reasoning: ReasoningSettings | null) => TemperatureBehaviour);
  /** The words its temperature rejections use. */
  temperatureWording?: keyof typeof TEMPERATURE_WORDING;
  /** Whether a reasoning setting is accepted, rejected by value, or rejected as a parameter. */
  reasoning?: (reasoning: ReasoningSettings) => "accepted" | "parameter" | "value";
  /** Fail calls with a transient error, from the nth call (1-based) on. */
  transientFrom?: number;
  /** Refuse before sending, as a missing credential does. */
  notSent?: boolean;
}

// A scripted provider: throws the same classified errors executeVerdict would.
function simulate(model: SimulatedModel): { execute: ProbeExecutor; sent: ExecutionBinding[] } {
  const sent: ExecutionBinding[] = [];
  return {
    sent,
    execute: async (binding) => {
      if (model.notSent) throw rejection("no anthropic credential is available", "provider_unavailable", false);
      sent.push(binding);
      if (model.transientFrom !== undefined && sent.length >= model.transientFrom) throw rejection("overloaded", "provider_unavailable");
      if (model.rejectsProtocols?.includes(binding.verdictProtocol)) {
        throw rejection(binding.verdictProtocol.includes("structured")
          ? "output_config.format: structured outputs are not supported for this model"
          : "tool_choice forcing a specific tool is not supported for this model");
      }
      if (binding.reasoning !== null && model.reasoning) {
        const outcome = model.reasoning(binding.reasoning);
        const mode = binding.reasoning.family === "anthropic" ? binding.reasoning.thinking.type : "effort";
        if (outcome === "parameter") throw rejection("Unsupported parameter: 'thinking' is not supported with this model.");
        if (outcome === "value") throw rejection(`thinking.type: '${mode}' is not supported for this model`);
      }
      const temperature = binding.sampling.temperature;
      const behaviour = typeof model.temperature === "function" ? model.temperature(binding.reasoning) : model.temperature ?? "accepted";
      if (temperature !== null) {
        const refused = TEMPERATURE_WORDING[model.temperatureWording ?? "parameter"];
        if (behaviour === "error") throw rejection("overloaded", "provider_unavailable");
        if (behaviour === "breaks-protocol") throw rejection("the response carried no verdict", "provider_protocol");
        if (behaviour === "only-default" && temperature !== 1) throw rejection(refused);
        if (behaviour === "zero-rejected" && temperature === 0) throw rejection(refused);
        if (behaviour === "only-0.7" && temperature !== 0.7) throw rejection(refused);
      }
      return { usage: USAGE };
    }
  };
}

// A model that accepts only its default temperature of 1, rejects a forced tool, and thinks adaptively only.
const opusLike = (extra: Partial<SimulatedModel> = {}) => simulate({
  rejectsProtocols: ["anthropic.forced-tool/v1"],
  temperature: "only-default",
  reasoning: (reasoning) => reasoning.family === "anthropic" && reasoning.thinking.type === "adaptive" ? "accepted" : "value",
  ...extra
});

const savedOpus = (overrides: Partial<ExecutionBinding> = {}): ExecutionBinding => ({
  ...BASE,
  sampling: { temperature: null, topP: null },
  reasoning: ADAPTIVE,
  verdictProtocol: "anthropic.structured-output/v1",
  ...overrides
});

async function check(model = opusLike(), extra: { temperatureIgnored?: boolean; documentedDefault?: ReasoningSettings | null } = {}): Promise<CapabilityCheckResult> {
  return runCapabilityCheck({
    base: BASE, credentialSource: "project", published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE, temperatureIgnored: false, execute: model.execute, ...extra
  });
}

const temperaturesSent = (probes: CapabilityCheckResult["probes"]) =>
  probes.filter((probe) => probe.purpose === "temperature").map((probe) => [probe.sent.temperature, probe.outcome]);

// An entry the ignored-temperature table could hold, for combinations the tests list.
const listing = (reasoning: ReasoningSettings | null): IgnoredTemperatureEntry => ({
  endpoint: { kind: "managed", provider: "anthropic" },
  modelId: BASE.modelId,
  reasoning,
  sources: ["https://provider.example/docs/temperature"],
  reviewedOn: "2026-09-27"
});

describe("capability check", () => {
  it("finds the protocol, then both reasoning settings, then temperature 0 and 0.5 with the default reasoning", async () => {
    const result = await check();
    expect(result.protocol).toBe("anthropic.structured-output/v1");
    expect(result.probes.map((probe) => [probe.purpose, probe.outcome, probe.rejection])).toEqual([
      ["protocol", "accepted", null],
      ["reasoning", "accepted", null],
      ["reasoning", "rejected", "value"],
      ["temperature", "rejected", "parameter"],
      ["temperature", "rejected", "parameter"]
    ]);
    expect(result.probes[0]!.sent).toEqual({ temperature: null, topP: null, reasoning: null, outputTokenLimit: 1200 });
    expect(result.probes.map((probe) => probe.sent.reasoning).slice(1, 3)).toEqual([ADAPTIVE, DISABLED]);
    expect(result.probes.slice(3).map((probe) => probe.sent)).toEqual([
      { temperature: 0, topP: null, reasoning: ADAPTIVE, outputTokenLimit: 1200 },
      { temperature: 0.5, topP: null, reasoning: ADAPTIVE, outputTokenLimit: 1200 }
    ]);
    expect(result.probes[0]!.usage).toEqual(USAGE);
    expect(result).toMatchObject({ temperatureSupport: "not_adjustable", reasoningSupport: "accepted", probedReasoning: ADAPTIVE, credentialSource: "project" });
  });

  it("classifies temperature by outcome: 0 accepted, or 0 rejected and 0.5 accepted, lets the author choose", async () => {
    const zero = await check(opusLike({ temperature: "accepted" }));
    expect(temperaturesSent(zero.probes)).toEqual([[0, "accepted"]]);
    expect(zero.temperatureSupport).toBe("adjustable");

    const half = await check(opusLike({ temperature: "zero-rejected", temperatureWording: "value" }));
    expect(temperaturesSent(half.probes)).toEqual([[0, "rejected"], [0.5, "accepted"]]);
    expect(half.temperatureSupport).toBe("adjustable");

    // An answer that breaks the protocol still accepted the temperature.
    const broken = await check(opusLike({ temperature: "breaks-protocol" }));
    expect(temperaturesSent(broken.probes)).toEqual([[0, "rejected"]]);
    expect(broken.temperatureSupport).toBe("adjustable");
  });

  it("reads 0 and 0.5 both rejected as not adjustable, whatever the rejections say, and a model taking only 0.7 too", async () => {
    for (const temperatureWording of ["parameter", "value", "unattributed"] as const) {
      const result = await check(opusLike({ temperatureWording }));
      expect(temperaturesSent(result.probes), temperatureWording).toEqual([[0, "rejected"], [0.5, "rejected"]]);
      expect(result.temperatureSupport, temperatureWording).toBe("not_adjustable");
    }
    expect((await check(opusLike({ temperature: "only-0.7" }))).temperatureSupport).toBe("not_adjustable");
  });

  it("leaves temperature unknown after an error, sending no further temperature probe", async () => {
    const result = await check(opusLike({ temperature: "error" }));
    expect(temperaturesSent(result.probes)).toEqual([[0, "error"]]);
    expect(result.temperatureSupport).toBeNull();
    // A rejected 0 and an error at 0.5 classify nothing either.
    let calls = 0;
    const late: ProbeExecutor = async (binding) => {
      if (binding.sampling.temperature === 0) throw rejection(TEMPERATURE_WORDING.parameter);
      if (binding.sampling.temperature === 0.5 && ++calls === 1) throw rejection("overloaded", "provider_unavailable");
      return { usage: null };
    };
    const halfErrored = await runCapabilityCheck({ base: BASE, credentialSource: "project", published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE, temperatureIgnored: false, execute: late });
    expect(temperaturesSent(halfErrored.probes)).toEqual([[0, "rejected"], [0.5, "error"]]);
    expect(halfErrored.temperatureSupport).toBeNull();
  });

  it("sends no temperature probe without an accepted request to add it to, and none for a listed combination", async () => {
    // The documented default reasoning is rejected, so there is no baseline.
    const noBaseline = await check(opusLike({ reasoning: () => "value" }));
    expect(temperaturesSent(noBaseline.probes)).toEqual([]);
    expect(noBaseline.temperatureSupport).toBeNull();

    const listed = await check(opusLike(), { temperatureIgnored: true });
    expect(temperaturesSent(listed.probes)).toEqual([]);
    expect(listed.temperatureSupport).toBeNull();
  });

  it("sends at most 7 probes, the seventh only where the model refuses temperature 0", async () => {
    const model = simulate({ rejectsProtocols: ["anthropic.structured-output/v1", "anthropic.forced-tool/v1"], temperature: "zero-rejected" });
    const result = await runCapabilityCheck({ base: BASE, credentialSource: "project", published: null, documentedDefault: null, temperatureIgnored: false, execute: model.execute });
    expect(result.probes.filter((probe) => probe.purpose === "protocol").map((probe) => probe.verdictProtocol))
      .toEqual(["anthropic.structured-output/v1", "anthropic.forced-tool/v1", "prompted-json/v1"]);
    expect(result.protocol).toBe("prompted-json/v1");
    expect(result.probes).toHaveLength(7);

    const noStructured = anthropicPublishedCapabilities("m", { structured_outputs: { supported: false } });
    const skipping = simulate({ temperature: "accepted" });
    await runCapabilityCheck({ base: BASE, credentialSource: "project", published: noStructured, documentedDefault: null, temperatureIgnored: false, execute: skipping.execute });
    expect(skipping.sent[0]!.verdictProtocol).toBe("anthropic.forced-tool/v1");
  });

  it("probes a middle reasoning value where the table has no entry, and temperature with no reasoning fields on the protocol probe's request", async () => {
    const model = simulate({ temperature: "accepted", reasoning: () => "accepted" });
    const result = await runCapabilityCheck({ base: BASE, credentialSource: "project", published: OPUS_PUBLISHED, documentedDefault: null, temperatureIgnored: false, execute: model.execute });
    expect(result.probes.filter((probe) => probe.purpose === "reasoning").map((probe) => probe.sent.reasoning)).toEqual([ADAPTIVE, DISABLED]);
    expect(result.probes.find((probe) => probe.purpose === "temperature")!.sent.reasoning).toBeNull();
    expect(result).toMatchObject({ temperatureSupport: "adjustable", probedReasoning: null });
    const enabledOnly = anthropicPublishedCapabilities("m", { thinking: { supported: true, types: { enabled: { supported: true } } }, effort: { supported: false } });
    expect(middleReasoning("anthropic", enabledOnly)).toEqual({ family: "anthropic", thinking: { type: "enabled", budgetTokens: 1024 }, effort: null });
    expect(noReasoning("openai")).toEqual({ family: "openai", effort: "none" });
  });

  it("stops at a transient error, at any stage", async () => {
    const atProtocol = await check(simulate({ transientFrom: 1 }));
    expect(atProtocol).toMatchObject({ protocol: null, temperatureSupport: null, reasoningSupport: null });
    expect(atProtocol.probes).toHaveLength(1);
    expect(atProtocol.probes[0]).toMatchObject({ outcome: "error", failureKind: "provider_unavailable", usage: { inputTokens: 5, outputTokens: 0 } });

    const atReasoning = await check(opusLike({ transientFrom: 2 }));
    expect(atReasoning.protocol).toBe("anthropic.structured-output/v1");
    expect(atReasoning.probes.map((probe) => probe.purpose)).toEqual(["protocol", "reasoning"]);
    expect(atReasoning.temperatureSupport).toBeNull();
  });

  it("records nothing for calls that never left Rubrist", async () => {
    const result = await check(simulate({ notSent: true }));
    expect(result).toMatchObject({ protocol: null, probes: [] });
  });

  it("takes no sampling or reasoning probes for the mock", async () => {
    const model = simulate({});
    const result = await runCapabilityCheck({
      base: { ...BASE, provider: "mock", modelId: "mock-heuristic-v1", modelVersion: "mock-heuristic-v1", outputTokenLimit: null },
      credentialSource: "built_in",
      published: null,
      documentedDefault: null,
      temperatureIgnored: false,
      execute: model.execute
    });
    expect(result.protocol).toBe("mock/v1");
    expect(result.probes).toHaveLength(1);
  });

  it("attributes an OpenRouter refusal of a parameter the model publishes no support for", async () => {
    const published = openRouterPublishedCapabilities("vendor/plain-model", ["tools", "tool_choice", "structured_outputs", "temperature"]);
    const execute: ProbeExecutor = async (binding) => {
      if (binding.reasoning !== null) throw rejection("No endpoints found that can handle the requested parameters.");
      return { usage: null };
    };
    const result = await runCapabilityCheck({
      base: { provider: "openrouter", endpoint: { kind: "managed" }, modelId: "vendor/plain-model", modelVersion: "vendor/plain-model", outputTokenLimit: 800, routing: { requireParameters: true, allowFallbacks: false } },
      credentialSource: "project",
      published,
      documentedDefault: null,
      temperatureIgnored: false,
      execute
    });
    expect(result.reasoningSupport).toBe("parameter_rejected");
    expect(result.temperatureSupport).toBe("adjustable");
  });
});

describe("temperature classification for newly selected reasoning (ADR-0014 decision 12)", () => {
  // gpt-5.5-like: temperature only at its default with reasoning on, any value with reasoning effort none.
  const OPENAI_BASE = { ...BASE, provider: "openai" as const, modelId: "gpt-5.5", modelVersion: "gpt-5.5", outputTokenLimit: null };
  const gptLike = () => simulate({ temperature: (reasoning) => reasoning?.family === "openai" && reasoning.effort === "none" ? "accepted" : "only-default" });
  const NONE: ReasoningSettings = { family: "openai", effort: "none" };
  const HIGH: ReasoningSettings = { family: "openai", effort: "high" };
  const classify = (model: ReturnType<typeof simulate>, reasoning: ReasoningSettings | null, extra: { baselineAccepted?: boolean; temperatureIgnored?: boolean } = {}) =>
    classifyTemperatureFor({
      base: OPENAI_BASE, credentialSource: "project", published: null, verdictProtocol: "openai.structured-output/v1",
      reasoning, baselineAccepted: false, temperatureIgnored: false, execute: model.execute, ...extra
    });

  it("depends on the reasoning: the check's default says not adjustable, effort none says adjustable", async () => {
    const model = gptLike();
    const checked = await runCapabilityCheck({ base: OPENAI_BASE, credentialSource: "project", published: null, documentedDefault: null, temperatureIgnored: false, execute: model.execute });
    expect(checked.temperatureSupport).toBe("not_adjustable");
    const none = await classify(model, NONE);
    expect(none.probes.map((probe) => [probe.purpose, probe.sent.temperature, probe.outcome])).toEqual([
      ["reasoning", null, "accepted"],
      ["temperature", 0, "accepted"]
    ]);
    expect(none).toMatchObject({ temperatureSupport: "adjustable", probedReasoning: NONE, protocol: "openai.structured-output/v1" });
    expect((await classify(gptLike(), HIGH)).temperatureSupport).toBe("not_adjustable");
  });

  it("sends at most 3 calls, skips a baseline the check already saw accepted, and nothing for a listed combination", async () => {
    const full = gptLike();
    expect((await classify(full, HIGH)).probes).toHaveLength(3);
    expect(full.sent.map((binding) => binding.sampling.temperature)).toEqual([null, 0, 0.5]);
    expect(full.sent.every((binding) => binding.sampling.topP === null && binding.verdictProtocol === "openai.structured-output/v1")).toBe(true);

    // A baseline the caller vouches for isn't one this call saw, so its report classifies nothing.
    const known = gptLike();
    const skipped = await classify(known, HIGH, { baselineAccepted: true });
    expect(known.sent.map((binding) => binding.sampling.temperature)).toEqual([0, 0.5]);
    expect(skipped.probes.map((probe) => probe.purpose)).toEqual(["temperature", "temperature"]);
    expect(skipped.temperatureSupport).toBeNull();

    // With no reasoning fields, the baseline is a protocol probe's request.
    const unset = gptLike();
    expect((await classify(unset, null)).probes[0]).toMatchObject({ purpose: "protocol", sent: { reasoning: null, temperature: null } });

    const listed = gptLike();
    expect(await classify(listed, HIGH, { temperatureIgnored: true })).toMatchObject({ probes: [], temperatureSupport: null });
    expect(listed.sent).toEqual([]);
  });

  it("sends no temperature probe when the selected reasoning isn't accepted", async () => {
    const model = simulate({ reasoning: () => "value" });
    const result = await classify(model, HIGH);
    expect(result.probes.map((probe) => probe.purpose)).toEqual(["reasoning"]);
    expect(result.temperatureSupport).toBeNull();
  });
});

describe("resolution", () => {
  const resolve = (binding: ExecutionBinding, model: ReturnType<typeof simulate>, extra: Partial<Parameters<typeof resolveExecutionBinding>[0]> = {}) =>
    resolveExecutionBinding({
      binding, trigger: "save", check: null, published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE,
      credentialSource: "project", ignoredTemperature: null, execute: model.execute, now: NOW, ...extra
    });

  it("confirms the exact saved request and needs nothing more when the check classified temperature with the saved reasoning", async () => {
    const model = opusLike();
    const binding = savedOpus();
    const record = await resolve(binding, model, { check: await check(model) });
    expect(model.sent.at(-1)).toEqual(binding);
    expect(record).toMatchObject({
      status: "resolved",
      temperatureSupport: "not_adjustable",
      reasoningSupport: "accepted",
      credentialSource: "project",
      reasoningDefaultsVersion: "rubrist-reasoning-defaults/v1",
      ignoredTemperatureVersion: IGNORED_TEMPERATURE_VERSION,
      ignoredTemperatureEntry: null,
      capabilitySnapshotDigest: OPUS_PUBLISHED!.snapshotDigest,
      checkedAt: "2026-09-25T12:00:00.000Z"
    });
    expect(record.probes.filter((probe) => probe.stage === "resolution")).toHaveLength(1);
    expect(ResolutionRecordSchema.parse(record)).toEqual(record);
    expect(governedGateProblems(binding, record)).toEqual([]);
  });

  it("ignores a check of another model or credential source", async () => {
    const opusCheck = await check();
    const sonnet = simulate({ temperature: "accepted", reasoning: () => "accepted" });
    const binding = savedOpus({ modelId: "claude-sonnet-4-6", modelVersion: "claude-sonnet-4-6" });
    const record = await resolve(binding, sonnet, { check: opusCheck, published: null });
    expect(record.probes.every((probe) => probe.stage === "resolution")).toBe(true);
    expect(record.temperatureSupport).toBe("adjustable");
    expect(governedGateProblems(binding, record)).toEqual(["temperature must be explicit: the model hasn't been shown to reject temperatures 0 and 0.5 with the saved reasoning and topP"]);

    const otherKey = await resolve(savedOpus(), opusLike(), { check: opusCheck, credentialSource: "environment" });
    expect(otherKey.probes.some((probe) => probe.stage === "capability_check")).toBe(false);
  });

  it("classifies temperature after save with the saved reasoning, the confirming probe as the request it adds to", async () => {
    const model = opusLike();
    const binding = savedOpus({ reasoning: { family: "anthropic", thinking: { type: "adaptive" }, effort: "high" } });
    const record = await resolve(binding, model, { check: await check(model) });
    const resolution = record.probes.filter((probe) => probe.stage === "resolution");
    expect(resolution.map((probe) => [probe.purpose, probe.sent.temperature])).toEqual([["confirm", null], ["temperature", 0], ["temperature", 0.5]]);
    expect(resolution[1]!.sent).toMatchObject({ reasoning: binding.reasoning, topP: null });
    expect(record.temperatureSupport).toBe("not_adjustable");
    expect(governedGateProblems(binding, record)).toEqual([]);
  });

  it("carries the saved topP into the temperature probes, so a check without topP doesn't answer for it", async () => {
    const model = opusLike({ temperature: "zero-rejected" });
    const binding = savedOpus({ sampling: { temperature: null, topP: 0.9 } });
    const record = await resolve(binding, model, { check: await check(model) });
    const resolution = record.probes.filter((probe) => probe.stage === "resolution");
    expect(resolution.map((probe) => [probe.purpose, probe.sent.temperature, probe.sent.topP])).toEqual([
      ["confirm", null, 0.9], ["temperature", 0, 0.9], ["temperature", 0.5, 0.9]
    ]);
    expect(record.temperatureSupport).toBe("adjustable");
  });

  it("sends at most 3 calls at save and 4 at a gate", async () => {
    const binding = savedOpus({ modelId: "claude-sonnet-4-6", modelVersion: "claude-sonnet-4-6", reasoning: null });
    const documentedDefault = documentedReasoningDefault("anthropic", "claude-sonnet-4-6")!.reasoning;
    const atSave = simulate({ temperature: "zero-rejected", reasoning: () => "accepted" });
    const saved = await resolve(binding, atSave, { published: null, documentedDefault, credentialSource: "environment" });
    expect(saved.probes.map((probe) => probe.purpose)).toEqual(["confirm", "temperature", "temperature"]);

    const atGate = simulate({ temperature: "zero-rejected", reasoning: () => "accepted" });
    const gated = await resolve(binding, atGate, { trigger: "gate", published: null, documentedDefault, credentialSource: "environment" });
    expect(gated.probes.map((probe) => probe.purpose)).toEqual(["confirm", "temperature", "temperature", "reasoning"]);
    expect(gated).toMatchObject({ status: "resolved", temperatureSupport: "adjustable", reasoningSupport: "accepted" });
    // Settings the model lets the author choose must be stated: the gate refuses the unset ones.
    expect(governedGateProblems(binding, gated)).toEqual([
      "temperature must be explicit: the model hasn't been shown to reject temperatures 0 and 0.5 with the saved reasoning and topP",
      "reasoning must be explicit: the model hasn't been shown to reject the reasoning parameter"
    ]);
  });

  it("sends no temperature probe for a listed combination, and records the table version and the entry", async () => {
    const model = opusLike();
    const binding = savedOpus();
    const record = await resolve(binding, model, { trigger: "gate", ignoredTemperature: listing(ADAPTIVE) });
    expect(record.probes.map((probe) => probe.purpose)).toEqual(["confirm"]);
    expect(record).toMatchObject({ temperatureSupport: null, ignoredTemperatureVersion: IGNORED_TEMPERATURE_VERSION, ignoredTemperatureEntry: listing(ADAPTIVE) });
    expect(governedGateProblems(binding, record)).toEqual([]);
    // A stated temperature is refused there: the model accepts it but doesn't apply it.
    const stated = savedOpus({ sampling: { temperature: 0.2, topP: null } });
    const statedRecord = await resolve(stated, simulate({}), { trigger: "gate", ignoredTemperature: listing(ADAPTIVE) });
    expect(statedRecord.status).toBe("resolved");
    expect(governedGateProblems(stated, statedRecord)).toEqual([
      `temperature must be unset: ${IGNORED_TEMPERATURE_VERSION} lists claude-opus-5-5 as ignoring temperature with the saved reasoning`
    ]);
  });

  it("sends only the confirming probe when every setting is explicit", async () => {
    const model = simulate({ temperature: "accepted", reasoning: () => "accepted" });
    const binding = savedOpus({ sampling: { temperature: 0, topP: null }, reasoning: DISABLED });
    const record = await resolve(binding, model, { trigger: "gate", published: null, documentedDefault: null, credentialSource: null });
    expect(model.sent).toEqual([binding]);
    expect(record.status).toBe("resolved");
  });

  it("fails only on a rejected confirming probe, sending nothing more, and stays unresolved on a transient one", async () => {
    const rejected = await resolve(savedOpus({ sampling: { temperature: 0, topP: null }, reasoning: null }), opusLike(), { trigger: "gate", published: null, documentedDefault: null });
    expect(rejected.status).toBe("failed");
    expect(rejected.probes).toHaveLength(1);
    expect(rejected.probes[0]).toMatchObject({ purpose: "confirm", outcome: "rejected", rejection: "parameter", rejectedParameter: "temperature" });
    expect(rejected.temperatureSupport).toBeNull();

    const transient = await resolve(savedOpus(), simulate({ transientFrom: 1 }), { trigger: "gate", published: null, documentedDefault: null });
    expect(transient.status).toBe("unresolved");
    expect(transient.probes).toHaveLength(1);
    expect(governedGateProblems(savedOpus(), transient)[0]).toMatch(/unresolved, not resolved/);

    const unsent = await resolve(savedOpus(), simulate({ notSent: true }), { trigger: "gate", published: null, documentedDefault: null, credentialSource: null });
    expect(unsent).toMatchObject({ status: "unresolved", probes: [] });
  });

  it("leaves temperature unknown, and the gate refusing it, when a temperature probe errors", async () => {
    const record = await resolve(savedOpus(), opusLike({ temperature: "error" }));
    expect(record.probes.map((probe) => [probe.purpose, probe.outcome])).toEqual([["confirm", "accepted"], ["temperature", "error"]]);
    expect(record).toMatchObject({ status: "resolved", temperatureSupport: null });
    expect(governedGateProblems(savedOpus(), record)[0]).toMatch(/temperature must be explicit/);
  });

  it("summarizes a rejected reasoning value over a rejected parameter", async () => {
    const execute: ProbeExecutor = async (binding) => {
      if (binding.reasoning?.family === "anthropic" && binding.reasoning.thinking.type === "adaptive") {
        throw rejection("output_config.effort: This model does not support the effort parameter.");
      }
      if (binding.reasoning !== null) throw rejection("thinking.type: 'disabled' is not supported for this model");
      return { usage: null };
    };
    const result = await runCapabilityCheck({ base: BASE, credentialSource: "project", published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE, temperatureIgnored: false, execute });
    expect(result.probes.filter((probe) => probe.purpose === "reasoning").map((probe) => probe.rejection)).toEqual(["parameter", "value"]);
    expect(result.reasoningSupport).toBe("value_rejected");
  });
});

describe("re-check before a governed run", () => {
  const recheck = (execute: ProbeExecutor, extra: Partial<Parameters<typeof recheckExecutionBinding>[0]> = {}) =>
    recheckExecutionBinding({ binding: savedOpus(), published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE, temperatureIgnored: false, execute, ...extra });

  it("holds while the saved request is accepted and temperature 0 and 0.5 are still both rejected", async () => {
    const result = await recheck(opusLike().execute);
    expect(result.holds).toBe(true);
    expect(result.probes.map((probe) => [probe.stage, probe.purpose, probe.sent.temperature])).toEqual([
      ["recheck", "confirm", null], ["recheck", "temperature", 0], ["recheck", "temperature", 0.5]
    ]);
    for (const temperatureWording of ["value", "unattributed"] as const) {
      expect((await recheck(opusLike({ temperatureWording }).execute, { published: null })).holds, temperatureWording).toBe(true);
    }
  });

  it("doesn't hold once the provider accepts 0 or 0.5, or when it can't be shown", async () => {
    const zero = await recheck(opusLike({ temperature: "accepted" }).execute);
    expect(zero.holds).toBe(false);
    expect(zero.probes.map((probe) => probe.sent.temperature)).toEqual([null, 0]);
    expect((await recheck(opusLike({ temperature: "zero-rejected" }).execute)).holds).toBe(false);

    const errored = await recheck(opusLike({ temperature: "error" }).execute);
    expect(errored).toMatchObject({ holds: false });
    expect(errored.probes.map((probe) => probe.outcome)).toEqual(["accepted", "error"]);

    const transient = await recheck(simulate({ transientFrom: 1 }).execute);
    expect(transient).toMatchObject({ holds: false });
    expect(transient.probes).toHaveLength(1);
    expect(await recheck(simulate({ notSent: true }).execute)).toEqual({ holds: false, probes: [] });
  });

  it("sends no temperature probe where the resolution record lists the combination", async () => {
    const model = opusLike({ temperature: "accepted" });
    const result = await recheck(model.execute, { temperatureIgnored: true });
    expect(result).toMatchObject({ holds: true });
    expect(model.sent).toHaveLength(1);
  });
});

describe("governed gates", () => {
  const confirmed = (sent: Partial<ExecutionBinding["sampling"]> & { reasoning?: ReasoningSettings | null } = {}) => ({
    stage: "resolution", purpose: "confirm", verdictProtocol: "anthropic.structured-output/v1",
    sent: { temperature: sent.temperature ?? null, topP: null, reasoning: sent.reasoning === undefined ? ADAPTIVE : sent.reasoning, outputTokenLimit: 1200 },
    outcome: "accepted", rejection: null, rejectedParameter: null, failureKind: null, providerMessage: null, usage: null, costMicroUsd: null
  });
  const record = (patch: object) => ResolutionRecordSchema.parse({
    status: "resolved", capabilitySnapshotDigest: null, reasoningDefaultsVersion: null, ignoredTemperatureVersion: IGNORED_TEMPERATURE_VERSION,
    ignoredTemperatureEntry: null, credentialSource: "project", temperatureSupport: null, reasoningSupport: null,
    checkedAt: NOW.toISOString(), probes: [confirmed()], ...patch
  });

  it("exempt the families with no sampling or reasoning settings", () => {
    const mock: ExecutionBinding = {
      provider: "mock", endpoint: { kind: "managed" }, modelId: "mock-heuristic-v1", modelVersion: "mock-heuristic-v1",
      sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null, verdictProtocol: "mock/v1", routing: null
    };
    const resolved = record({
      credentialSource: "built_in",
      probes: [{ ...confirmed({ reasoning: null }), verdictProtocol: "mock/v1", sent: { temperature: null, topP: null, reasoning: null, outputTokenLimit: null } }]
    });
    expect(governedGateProblems(mock, resolved)).toEqual([]);
    expect(governedGateProblems(mock, null)).toEqual(["the execution binding is unresolved, not resolved"]);
  });

  it("let temperature stay unset only where the record shows it not adjustable, and refuse it where adjustable", async () => {
    const notAdjustable = await resolveExecutionBinding({
      binding: savedOpus(), trigger: "gate", check: null, published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE,
      credentialSource: "project", ignoredTemperature: null, execute: opusLike().execute, now: NOW
    });
    expect(notAdjustable.temperatureSupport).toBe("not_adjustable");
    expect(governedGateProblems(savedOpus(), notAdjustable)).toEqual([]);
    // Temperature 1, the only value such a model takes, stated explicitly is still valid: it is what was sent.
    expect(governedGateProblems(savedOpus({ sampling: { temperature: 1, topP: null } }), record({ probes: [confirmed({ temperature: 1 })] }))).toEqual([]);

    const adjustable = await resolveExecutionBinding({
      binding: savedOpus(), trigger: "gate", check: null, published: OPUS_PUBLISHED, documentedDefault: ADAPTIVE,
      credentialSource: "project", ignoredTemperature: null, execute: opusLike({ temperature: "accepted" }).execute, now: NOW
    });
    expect(governedGateProblems(savedOpus(), adjustable)).toEqual([
      "temperature must be explicit: the model hasn't been shown to reject temperatures 0 and 0.5 with the saved reasoning and topP"
    ]);
    expect(governedGateProblems(savedOpus(), record({}))[0]).toMatch(/temperature must be explicit/);
  });

  it("read the listing from the table version the record names, never the current table", () => {
    // An older table listed the combination; the record keeps that answer for this version's lifecycle.
    const older = record({ ignoredTemperatureVersion: "rubrist-ignored-temperature/v0", ignoredTemperatureEntry: listing(ADAPTIVE) });
    expect(governedGateProblems(savedOpus(), older)).toEqual([]);
    expect(governedGateProblems(savedOpus({ sampling: { temperature: 0, topP: null } }), record({
      ignoredTemperatureVersion: "rubrist-ignored-temperature/v0", ignoredTemperatureEntry: listing(ADAPTIVE), probes: [confirmed({ temperature: 0 })]
    }))).toEqual(["temperature must be unset: rubrist-ignored-temperature/v0 lists claude-opus-5-5 as ignoring temperature with the saved reasoning"]);
    // A record resolved when the combination wasn't listed doesn't become listed.
    expect(governedGateProblems(savedOpus(), record({}))[0]).toMatch(/temperature must be explicit/);
  });

  it("keep a listed entry consistent with the record: the saved reasoning, and no temperature probe", () => {
    const issues = (patch: object) => {
      const parsed = ResolutionRecordSchema.safeParse({ ...record({}), ...patch });
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
    };
    expect(issues({ ignoredTemperatureEntry: listing(ADAPTIVE) })).toEqual([]);
    expect(issues({ ignoredTemperatureEntry: listing(DISABLED) })).toEqual(["ignoredTemperatureEntry"]);
    const probed = { ...confirmed({ temperature: 0 }), purpose: "temperature" };
    expect(issues({ ignoredTemperatureEntry: listing(ADAPTIVE), probes: [confirmed(), probed] })).toEqual(["probes"]);
  });
});

describe("probe input", () => {
  it("judges a fixed, non-sensitive input with the evaluator's verdict kind, and returns usage", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchStub: ExecutionFetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({
        id: "m", model: "claude-opus-5-5", stop_reason: "end_turn",
        content: [{ type: "text", text: "{\"choice\":\"good\",\"rationale\":\"r\"}" }],
        usage: { input_tokens: 70, output_tokens: 9 }
      }));
    };
    const execute = bindingProbeExecutor({
      apiKey: "k", customBaseUrl: null, fetch: fetchStub,
      spec: { verdictKind: "categorical", scalarRange: null, categoricalChoiceScores: { good: 1, bad: 0 } }
    });
    expect(await execute(savedOpus())).toEqual({ usage: { inputTokens: 70, outputTokens: 9 } });
    const [body] = bodies;
    expect(JSON.stringify(body)).toContain("What is 2 + 3?");
    expect(JSON.stringify(body)).toContain(CAPABILITY_PROBE_INPUT.rubricMarkdown);
    expect(JSON.stringify((body!.output_config as { format: unknown }).format)).toContain("\"good\"");
  });

  it("runs the mock locally", async () => {
    const execute = bindingProbeExecutor({ apiKey: null, customBaseUrl: null, spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null } });
    await expect(execute({
      provider: "mock", endpoint: { kind: "managed" }, modelId: "mock-heuristic-v1", modelVersion: "mock-heuristic-v1",
      sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null, verdictProtocol: "mock/v1", routing: null
    })).resolves.toMatchObject({ usage: expect.any(Object) });
  });
});
