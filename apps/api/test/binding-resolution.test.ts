import { EvaluatorCallError, type ExecutionFetch } from "@rubrist/audit/runtime";
import type { ExecutionBinding } from "@rubrist/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPABILITY_CHECK_BUDGET_MS,
  bindingResolutionServices,
  checkBindingCapabilities,
  governedGateRefusal,
  recheckGovernedBinding,
  resolutionNeeded,
  resolveGovernedBinding,
  resolveSavedBinding,
  type GovernedBinding,
  type RecheckedBinding
} from "../src/lib/binding-resolution.js";
import { savedVersionResolver } from "../src/evaluator-lifecycle/routes.js";
import type { EvaluatorLifecycleRepository } from "../src/evaluator-lifecycle/repository.js";
import { loadResolutionRecord } from "../src/evaluator-lifecycle/resolution.pg.js";
import { sha256Digest } from "../src/lib/canonical-json.js";
import { endpointBaseUrlDigest } from "../src/lib/evaluator-identity.js";
import { ExecutionBindingInputError } from "../src/lib/execution-binding.js";
import { ignoredTemperatureEntries, ignoredTemperatureEntryFor } from "../src/lib/ignored-temperature.js";
import {
  CapabilityCheckInputSchema,
  IGNORED_TEMPERATURE_VERSION,
  REASONING_DEFAULTS_VERSION,
  documentedReasoningDefault,
  ignoredTemperatureTable,
  type IgnoredTemperatureEntry,
  type ResolutionRecord
} from "@rubrist/shared";
import {
  CAPABILITY_PROBE_INPUT,
  TYPED_QUESTION_PROBE,
  governedGateProblems,
  resolveExecutionBinding,
  runCapabilityCheck,
  type ProbeExecutor
} from "../src/lib/evaluator-resolution.js";
import { SEEDED_BINDING, resolvedRecordFor, temperatureRejectingRecordFor } from "./fixtures/execution-binding.js";
import { MemoryCapabilityCheckStore, CAPABILITY_CHECK_CARRY_MS } from "../src/lib/capability-check-store.js";

// Resolution and re-check as the governed gates use them (ADR-0014 section 4).

const OPUS: ExecutionBinding = { ...SEEDED_BINDING, modelId: "claude-opus-5-5", modelVersion: "claude-opus-5-5", sampling: { temperature: null, topP: null } };
const governed = (executionBinding: ExecutionBinding): GovernedBinding => ({
  projectId: "project",
  executionBinding,
  customEndpointUrl: null,
  spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }
});
/** A binding as the re-check reads it, with the resolution record it guards. */
const rechecked = (executionBinding: ExecutionBinding, record: ResolutionRecord | null = null): RecheckedBinding =>
  ({ ...governed(executionBinding), record });
const VERDICT = { label: "pass", score: 0.9, rationale: "The answer states 5." };
const accepted = () => new Response(JSON.stringify({
  id: "msg", model: "claude-observed", stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify(VERDICT) }], usage: { input_tokens: 10, output_tokens: 5 }
}));
const rejected = (message: string) => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), { status: 400 });

function services(respond: (body: Record<string, unknown>) => Response) {
  const sent: Array<Record<string, unknown>> = [];
  const fetch: ExecutionFetch = async (_url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    sent.push(body);
    return respond(body);
  };
  return {
    sent,
    services: bindingResolutionServices(async () => "sk-project", {
      fetch,
      capabilityFetch: async () => new Response("{}", { status: 404 }),
      now: () => new Date("2026-09-26T00:00:00.000Z")
    })
  };
}

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
});

describe("carrying authoring checks into resolution", () => {
  const input = { provider: "anthropic" as const, endpoint: { kind: "managed" as const }, routing: OPUS.routing, modelId: OPUS.modelId, modelVersion: OPUS.modelVersion, outputTokenLimit: OPUS.outputTokenLimit };
  it("retains check probes and still confirms the exact saved binding", async () => {
    const { services: s, sent } = services((body) => "temperature" in body ? rejected("unsupported temperature") : accepted());
    s.checks = new MemoryCapabilityCheckStore();
    const report = await checkBindingCapabilities(s, "project", input);
    sent.length = 0;
    const record = await resolveSavedBinding(s, governed({ ...OPUS, reasoning: report.probedReasoning }));
    expect(record.probes.filter((p) => p.stage === "capability_check")).toEqual(report.probes);
    expect(record.probes.filter((p) => p.stage === "resolution").map((p) => p.purpose)).toEqual(["confirm"]);
    expect(record.temperatureSupport).toBe("not_adjustable");
    expect(sent).toHaveLength(1);
  });

  it.each(["project", "credential", "expiry", "model", "token limit", "future"])("does not reuse mismatched %s checks", async (mismatch) => {
    const { services: s } = services(() => accepted());
    s.checks = new MemoryCapabilityCheckStore();
    await checkBindingCapabilities(s, "project", input);
    const target = governed(OPUS);
    if (mismatch === "project") target.projectId = "different-project";
    if (mismatch === "credential") s.credential = async () => ({ apiKey: "rotated-key", source: "project" });
    if (mismatch === "expiry") s.now = () => new Date(Date.parse("2026-09-26T00:00:00Z") + CAPABILITY_CHECK_CARRY_MS);
    if (mismatch === "future") s.now = () => new Date("2026-09-25T23:59:59Z");
    if (mismatch === "model") target.executionBinding = { ...OPUS, modelVersion: "other-version" };
    if (mismatch === "token limit") target.executionBinding = { ...OPUS, outputTokenLimit: 9999 };
    const record = await resolveSavedBinding(s, target);
    expect(record.probes.some((p) => p.stage === "capability_check")).toBe(false);
  });

  it("extends a full check with temperature classification for changed reasoning", async () => {
    const { services: s, sent } = services((body) => "temperature" in body ? rejected("unsupported temperature") : accepted());
    s.checks = new MemoryCapabilityCheckStore();
    const full = await checkBindingCapabilities(s, "project", input);
    const classified = await checkBindingCapabilities(s, "project", { ...input,
      classifyTemperature: { reasoning: null, verdictProtocol: OPUS.verdictProtocol, baselineAccepted: false } });
    sent.length = 0;
    const record = await resolveSavedBinding(s, governed({ ...OPUS, reasoning: null }));
    expect(record.probes.filter((p) => p.stage === "capability_check" && p.purpose === "temperature")).toEqual(classified.probes.filter((p) => p.purpose === "temperature"));
    expect(record.probes.filter((p) => p.stage === "capability_check").length).toBeLessThanOrEqual(7);
    expect(sent).toHaveLength(1);
    // A new full check resets its older classifications.
    const replacement = await checkBindingCapabilities(s, "project", input);
    const next = await resolveSavedBinding(s, governed({ ...OPUS, reasoning: replacement.probedReasoning }));
    expect(next.probes.filter((p) => p.stage === "capability_check")).toEqual(replacement.probes);
  });

  it("does not let a successful check override a rejected saved request or cache a governed recheck", async () => {
    let reject = false;
    const { services: s, sent } = services(() => reject ? rejected("invalid saved request") : accepted());
    s.checks = new MemoryCapabilityCheckStore();
    await checkBindingCapabilities(s, "project", input);
    reject = true;
    expect((await resolveSavedBinding(s, governed(OPUS))).status).toBe("failed");
    sent.length = 0;
    await recheckGovernedBinding(s, rechecked(OPUS));
    expect(sent).toHaveLength(1);
  });

  it("keeps repeated classifications within the immutable resolution probe limits", async () => {
    const { services: s, sent } = services((body) => "temperature" in body ? rejected("unsupported temperature") : accepted());
    s.checks = new MemoryCapabilityCheckStore();
    await checkBindingCapabilities(s, "project", input);
    for (let i = 0; i < 5; i++) await checkBindingCapabilities(s, "project", { ...input,
      classifyTemperature: { reasoning: null, verdictProtocol: OPUS.verdictProtocol, baselineAccepted: false } });
    sent.length = 0;
    const record = await resolveSavedBinding(s, governed({ ...OPUS, reasoning: null }));
    expect(record.status).toBe("resolved");
    expect(record.probes.filter((p) => p.stage === "capability_check" && p.purpose === "temperature")).toHaveLength(2);
    expect(sent).toHaveLength(1);
  });

  it("does not borrow temperature or reasoning support from another verdict protocol", async () => {
    const check = await runCapabilityCheck({ base: {
      provider: OPUS.provider, endpoint: OPUS.endpoint, modelId: OPUS.modelId,
      modelVersion: OPUS.modelVersion, outputTokenLimit: OPUS.outputTokenLimit, routing: OPUS.routing
    }, credentialSource: "project", published: null, documentedDefault: null, temperatureIgnored: false,
    execute: async (binding) => {
      if (binding.sampling.temperature !== null) throw new EvaluatorCallError("provider_rejected_request", "temperature rejected", { physicalCall: true });
      return { usage: null };
    } });
    let calls = 0;
    const record = await resolveExecutionBinding({ binding: { ...OPUS, reasoning: null, verdictProtocol: "anthropic.forced-tool/v1" },
      trigger: "save", check, published: null, documentedDefault: null, credentialSource: "project",
      ignoredTemperature: null, now: new Date(), execute: async () => { calls++; return { usage: null }; } });
    expect(record.probes.some((p) => p.stage === "capability_check")).toBe(false);
    expect(record.temperatureSupport).toBe("adjustable");
    expect(calls).toBe(2);
  });
});

describe("the credential a gate probes with", () => {
  it("never falls back to a platform key for a custom endpoint", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-platform";
    try {
      await expect(bindingResolutionServices(async () => null).credential("project", "custom")).resolves.toEqual({ apiKey: null, source: null });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("is the project's key, then the platform's, and the mock needs none", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-platform";
    expect(await bindingResolutionServices(async () => "sk-project").credential("p", "anthropic")).toEqual({ apiKey: "sk-project", source: "project" });
    expect(await bindingResolutionServices(async () => null).credential("p", "anthropic")).toEqual({ apiKey: "sk-platform", source: "environment" });
    expect(await bindingResolutionServices(async () => null).credential("p", "openai")).toEqual({ apiKey: null, source: null });
    expect(await bindingResolutionServices(async () => null).credential("p", "mock")).toEqual({ apiKey: null, source: "built_in" });
  });
});

describe("resolution at a gate", () => {
  it("resolves the saved request and classifies an unset temperature at 0 and 0.5, recording the credential source", async () => {
    const { services: s, sent } = services((body) => "temperature" in body ? rejected("`temperature` is deprecated for this model.") : accepted());
    const record = await resolveGovernedBinding(s, governed(OPUS));
    expect(record).toMatchObject({
      status: "resolved", credentialSource: "project", temperatureSupport: "not_adjustable",
      ignoredTemperatureVersion: IGNORED_TEMPERATURE_VERSION, ignoredTemperatureEntry: null
    });
    expect(sent.map((body) => body.temperature)).toEqual([undefined, 0, 0.5]);
    expect(governedGateRefusal(OPUS, record)).toBeNull();
  });

  it("keeps the seeded default binding, which states temperature 0 for a model that accepts it, passing", async () => {
    const { services: s, sent } = services(() => accepted());
    const record = await resolveGovernedBinding(s, governed(SEEDED_BINDING));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ temperature: 0, thinking: { type: "disabled" } });
    expect(governedGateRefusal(SEEDED_BINDING, record)).toBeNull();
  });

  it("fails a binding the provider rejects, and leaves it unresolved on a transient error", async () => {
    expect((await resolveGovernedBinding(services(() => rejected("model: not found")).services, governed(SEEDED_BINDING))).status).toBe("failed");
    expect((await resolveGovernedBinding(services(() => new Response("{}", { status: 503 })).services, governed(SEEDED_BINDING))).status).toBe("unresolved");
  });
});

describe("the re-check before a governed run", () => {
  const onlyDefault = (body: Record<string, unknown>) => "temperature" in body ? rejected("`temperature` may only be set to 1 when thinking is enabled.") : accepted();

  it("holds while the saved request is accepted and temperature 0 and 0.5 are still both rejected", async () => {
    expect((await recheckGovernedBinding(services(() => accepted()).services, rechecked(SEEDED_BINDING))).outcome).toBe("holds");
    const opus = services(onlyDefault);
    const result = await recheckGovernedBinding(opus.services, rechecked(OPUS));
    expect(result.outcome).toBe("holds");
    expect(opus.sent.map((body) => body.temperature)).toEqual([undefined, 0, 0.5]);
  });

  it("no longer holds when the provider rejects the request or starts accepting temperature 0 or 0.5", async () => {
    expect((await recheckGovernedBinding(services(() => rejected("model: not found")).services, rechecked(SEEDED_BINDING))).outcome).toBe("no_longer_holds");
    const zero = services(() => accepted());
    expect((await recheckGovernedBinding(zero.services, rechecked(OPUS))).outcome).toBe("no_longer_holds");
    expect(zero.sent.map((body) => body.temperature)).toEqual([undefined, 0]);
    const half = services((body) => body.temperature === 0 ? rejected("temperature: unsupported value") : accepted());
    expect((await recheckGovernedBinding(half.services, rechecked(OPUS))).outcome).toBe("no_longer_holds");
  });

  it("is unknown on a transient error or when no call can be sent", async () => {
    expect((await recheckGovernedBinding(services(() => new Response("{}", { status: 503 })).services, rechecked(SEEDED_BINDING))).outcome).toBe("unknown");
    const errored = services((body) => body.temperature === 0.5 ? new Response("{}", { status: 529 }) : onlyDefault(body));
    expect((await recheckGovernedBinding(errored.services, rechecked(OPUS))).outcome).toBe("unknown");
    const noKey = bindingResolutionServices(async () => null, { capabilityFetch: async () => new Response("{}", { status: 404 }) });
    expect(await recheckGovernedBinding(noKey, rechecked(SEEDED_BINDING))).toEqual({ outcome: "unknown", probes: [] });
  });

  it("sends no temperature probe where the record lists the combination, in the table version it names", async () => {
    const listed = await temperatureRejectingRecordFor(OPUS);
    const entry: IgnoredTemperatureEntry = {
      endpoint: { kind: "managed", provider: "anthropic" }, modelId: OPUS.modelId, reasoning: OPUS.reasoning,
      sources: ["https://provider.example/docs"], reviewedOn: "2026-09-27"
    };
    const record = { ...listed, ignoredTemperatureVersion: "rubrist-ignored-temperature/v0", ignoredTemperatureEntry: entry,
      temperatureSupport: null, probes: listed.probes.filter((probe) => probe.purpose !== "temperature") };
    const { sent, services: s } = services(() => accepted());
    expect((await recheckGovernedBinding(s, rechecked(OPUS, record))).outcome).toBe("holds");
    expect(sent).toHaveLength(1);
  });
});

describe("a gate refusal", () => {
  it("says what to change: state an adjustable temperature, or retry when unreachable", async () => {
    const resolved = await resolvedRecordFor(SEEDED_BINDING);
    expect(governedGateRefusal(SEEDED_BINDING, resolved)).toBeNull();
    expect(governedGateRefusal(SEEDED_BINDING, null)).toMatchObject({ suggestion: expect.stringContaining("reachable") });
    // The model lets the author choose temperature, so it must be stated.
    const accepting = await resolveGovernedBinding(services(() => accepted()).services, governed(OPUS));
    expect(accepting.temperatureSupport).toBe("adjustable");
    expect(governedGateRefusal(OPUS, accepting)).toMatchObject({
      problems: [expect.stringContaining("temperature must be explicit")],
      suggestion: "Save a new evaluator version that states its temperature explicitly."
    });
    const halfOnly = await resolveGovernedBinding(services((body) => body.temperature === 0 ? rejected("temperature: unsupported value") : accepted()).services, governed(OPUS));
    expect(governedGateRefusal(OPUS, halfOnly)?.suggestion)
      .toBe("Save a new evaluator version that states its temperature explicitly. The model rejected temperature 0 with the saved reasoning, so choose another value.");
    expect(governedGateRefusal(OPUS, await temperatureRejectingRecordFor(OPUS))).toBeNull();
  });

  // Where the saved request fails, the suggestion comes from the record's
  // temperature outcomes with the saved reasoning, never from the wording.
  describe("for a failed binding that states a temperature", () => {
    const failedWith = async (execute: ProbeExecutor, withCheck: boolean) => resolveExecutionBinding({
      binding: SEEDED_BINDING, trigger: "gate", published: null, documentedDefault: SEEDED_BINDING.reasoning,
      credentialSource: "project", ignoredTemperature: null, execute, now: new Date("2026-09-26T00:00:00.000Z"),
      check: withCheck ? await runCapabilityCheck({
        base: { provider: "anthropic", endpoint: { kind: "managed" }, modelId: SEEDED_BINDING.modelId, modelVersion: SEEDED_BINDING.modelVersion, outputTokenLimit: 1_200, routing: null },
        credentialSource: "project", published: null, documentedDefault: SEEDED_BINDING.reasoning, temperatureIgnored: false, execute
      }) : null
    });
    const refusing = (accepts: (temperature: number) => boolean, message: string): ProbeExecutor => async (binding) => {
      const temperature = binding.sampling.temperature;
      if (temperature !== null && !accepts(temperature)) {
        throw new EvaluatorCallError("provider_rejected_request", message, {
          physicalCall: true, status: 400,
          providerError: { type: "invalid_request_error", code: null, param: null, message, raw: null, upstreamProvider: null }
        });
      }
      return { usage: null };
    };

    it("suggests leaving temperature unset where 0 and 0.5 were both rejected, whatever the rejection says", async () => {
      for (const message of ["`temperature` may only be set to 1 when thinking is enabled.", "`temperature` is deprecated for this model.", "Invalid request."]) {
        const record = await failedWith(refusing((temperature) => temperature === 1, message), true);
        expect(record).toMatchObject({ status: "failed", temperatureSupport: "not_adjustable" });
        expect(governedGateRefusal(SEEDED_BINDING, record)).toMatchObject({
          providerMessage: message,
          suggestion: "Save a new evaluator version that leaves temperature unset: the model rejected temperatures 0 and 0.5 with the saved reasoning."
        });
      }
    });

    it("suggests another value where one was accepted, and nothing about temperature where it is unknown", async () => {
      const halfOnly = await failedWith(refusing((temperature) => temperature === 0.5, "temperature: unsupported value"), true);
      expect(halfOnly).toMatchObject({ status: "failed", temperatureSupport: "adjustable" });
      expect(governedGateRefusal(SEEDED_BINDING, halfOnly)?.suggestion).toBe("Save a new evaluator version with another temperature value.");

      // Without the check's probes, the record says nothing about temperature, so neither does the suggestion.
      const unknown = await failedWith(refusing(() => false, "`temperature` is deprecated for this model."), false);
      expect(unknown).toMatchObject({ status: "failed", temperatureSupport: null });
      expect(governedGateRefusal(SEEDED_BINDING, unknown)?.suggestion).toBe("Save a new evaluator version with settings the model accepts.");
    });
  });
});

describe("a transient error on a setting probe never fails a binding", () => {
  it("leaves a setting unanswered, so the gate resolves again and suggests retrying", async () => {
    const { services: s } = services((body) => "temperature" in body ? new Response("{}", { status: 529 }) : accepted());
    const record = await resolveGovernedBinding(s, governed(OPUS));
    expect(record).toMatchObject({ status: "resolved", temperatureSupport: null });
    expect(resolutionNeeded(OPUS, record)).toBe(true);
    expect(governedGateRefusal(OPUS, record)?.suggestion).toContain("Try again");
    // A setting resolution after save never asked about isn't a failed probe.
    const stated = { ...OPUS, sampling: { temperature: 0, topP: null }, reasoning: null };
    const saved = await resolveSavedBinding(services(() => accepted()).services, governed(stated));
    expect(saved.reasoningSupport).toBeNull();
    expect(governedGateRefusal(stated, saved)?.suggestion)
      .toBe("Resolve the binding: the model hasn't been asked about reasoning yet. A governed gate resolves it before use.");
    // An answered setting that needs stating leads: resolving can't make this binding pass.
    const unstated = { ...OPUS, reasoning: null };
    const both = await resolveSavedBinding(services(() => accepted()).services, governed(unstated));
    expect(both).toMatchObject({ temperatureSupport: "adjustable", reasoningSupport: null });
    expect(governedGateRefusal(unstated, both)?.suggestion)
      .toBe("Save a new evaluator version that states its temperature explicitly; resolve first to learn whether its reasoning must be stated too.");

    expect(resolutionNeeded(OPUS, await temperatureRejectingRecordFor(OPUS))).toBe(false);
    expect(resolutionNeeded(SEEDED_BINDING, await resolvedRecordFor(SEEDED_BINDING))).toBe(false);
    expect(resolutionNeeded(SEEDED_BINDING, { ...(await resolvedRecordFor(SEEDED_BINDING)), status: "failed" })).toBe(false);
    expect(resolutionNeeded(SEEDED_BINDING, null)).toBe(true);
  });

  it("keeps a re-check unknown when a rejection is unattributed only because capabilities couldn't be read", async () => {
    const OPENROUTER: ExecutionBinding = {
      ...SEEDED_BINDING, provider: "openrouter", modelId: "anthropic/claude-sonnet-4.6", modelVersion: "anthropic/claude-sonnet-4.6",
      sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null,
      verdictProtocol: "openai.forced-function/v1", routing: { requireParameters: true, allowFallbacks: false }
    };
    const chat = () => new Response(JSON.stringify({
      id: "c", model: "anthropic/claude-sonnet-4.6",
      choices: [{ message: { tool_calls: [{ type: "function", function: { name: "submit_verdict", arguments: JSON.stringify(VERDICT) } }] }, finish_reason: "tool_calls" }]
    }));
    const opaque = () => new Response(JSON.stringify({ error: { code: 400, message: "Provider returned error" } }), { status: 400 });
    const { services: s } = services((body) => "temperature" in body || "reasoning" in body ? opaque() : chat());
    expect((await recheckGovernedBinding(s, rechecked(OPENROUTER))).outcome).toBe("unknown");
  });

  it("no longer holds once a setting has a definite answer, even when another probe errored", async () => {
    const { services: s } = services((body) => "thinking" in body && (body.thinking as { type: string }).type !== "disabled"
      ? new Response("{}", { status: 503 })
      : accepted());
    const unsetBoth: ExecutionBinding = { ...OPUS, reasoning: null };
    expect((await recheckGovernedBinding(s, rechecked(unsetBoth))).outcome).toBe("no_longer_holds");
  });
});

describe("a typed-question binding (ADR-0014 section 5)", () => {
  const JEV: ExecutionBinding = {
    provider: "typesafe", endpoint: { kind: "managed" }, modelId: "jev-1.13.0", modelVersion: "jev-1.13.0",
    sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null,
    verdictProtocol: "typed-question/v1", routing: null
  };
  const answer = (noul: number) => new Response(JSON.stringify({
    model: "jev-1.13.0", answers: { verdict: { type: "noul", noul } }, usage: { input_tokens: 40, output_tokens: 2 }
  }), { status: 200 });

  it("is probed with the project's TypeSafe key, else TYPESAFE_API_KEY", async () => {
    process.env.TYPESAFE_API_KEY = "typesafe-platform";
    expect(await bindingResolutionServices(async () => "typesafe-project").credential("p", "typesafe")).toEqual({ apiKey: "typesafe-project", source: "project" });
    expect(await bindingResolutionServices(async () => null).credential("p", "typesafe")).toEqual({ apiKey: "typesafe-platform", source: "environment" });
  });

  it("resolves on one confirming probe that asks the fixed question about the fixed trace, and takes no setting probes", async () => {
    const { sent, services: gate } = services(() => answer(0.97));
    const record = await resolveGovernedBinding(gate, governed(JEV));
    expect(record).toMatchObject({ status: "resolved", credentialSource: "project", temperatureSupport: null, reasoningSupport: null });
    expect(record.probes.map((probe) => [probe.stage, probe.purpose, probe.outcome])).toEqual([["resolution", "confirm", "accepted"]]);
    expect(sent).toEqual([{
      state: { input: CAPABILITY_PROBE_INPUT.trace.input, output: CAPABILITY_PROBE_INPUT.trace.output },
      questions: { verdict: TYPED_QUESTION_PROBE.question },
      model: "jev-1.13.0"
    }]);
    // With no sampling or reasoning to state, a resolved binding passes the governed gates.
    expect(governedGateProblems(JEV, record)).toEqual([]);
  });

  it("is re-checked with the confirming probe alone, and never probed without a credential", async () => {
    const { sent, services: gate } = services(() => answer(0.97));
    expect(await recheckGovernedBinding(gate, rechecked(JEV))).toMatchObject({ outcome: "holds", probes: [{ purpose: "confirm", outcome: "accepted" }] });
    expect(sent).toHaveLength(1);
    const keyless = bindingResolutionServices(async () => null, { fetch: async () => { throw new Error("must not send"); } });
    const record = await resolveGovernedBinding(keyless, governed(JEV));
    expect(record).toMatchObject({ status: "unresolved", credentialSource: null, probes: [] });
  });

  it("suggests another model, not another protocol, when TypeSafe's response breaks its only protocol", async () => {
    const broken = () => new Response(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    const record = await resolveGovernedBinding(services(broken).services, governed(JEV));
    expect(record.status).toBe("failed");
    // A failed binding is fixed only by a new version, so "try again" means saving one.
    expect(governedGateRefusal(JEV, record)?.suggestion)
      .toBe("typesafe's response broke its only verdict protocol; save a new evaluator version to try again later, or choose another model.");
  });

  it("fails when TypeSafe rejects the request, and stays unresolved on a transient error", async () => {
    const rejectedBody = () => new Response(JSON.stringify({ detail: "Unknown model: jev-0" }), { status: 400 });
    expect((await resolveGovernedBinding(services(rejectedBody).services, governed(JEV))).status).toBe("failed");
    const unavailable = () => new Response(JSON.stringify({ detail: "upstream failure" }), { status: 503 });
    expect((await resolveGovernedBinding(services(unavailable).services, governed(JEV))).status).toBe("unresolved");
  });
});

describe("the capability check before save (ADR-0014 section 4)", () => {
  const base = { provider: "anthropic" as const, endpoint: { kind: "managed" as const }, modelId: "claude-opus-5-5", modelVersion: "claude-opus-5-5", outputTokenLimit: 1_200, routing: null };

  it("finds the protocol, then both reasoning settings, then temperature 0 and 0.5 with the documented default reasoning", async () => {
    const { sent, services: check } = services((body) => "temperature" in body ? rejected("`temperature` is deprecated for this model.") : accepted());
    const report = await checkBindingCapabilities(check, "project", base);
    expect(report).toMatchObject({
      credentialSource: "project",
      protocol: "anthropic.structured-output/v1",
      temperatureSupport: "not_adjustable",
      reasoningSupport: "accepted",
      probedReasoning: documentedReasoningDefault("anthropic", "claude-opus-5-5")!.reasoning,
      documentedDefault: documentedReasoningDefault("anthropic", "claude-opus-5-5")!.reasoning,
      published: null,
      reasoningDefaultsVersion: REASONING_DEFAULTS_VERSION,
      ignoredTemperatureVersion: IGNORED_TEMPERATURE_VERSION,
      temperatureIgnoredWith: [],
      interrupted: false,
      checkedAt: "2026-09-26T00:00:00.000Z"
    });
    expect(report.probes.map((probe) => [probe.stage, probe.purpose, probe.outcome, probe.sent.temperature])).toEqual([
      ["capability_check", "protocol", "accepted", null],
      ["capability_check", "reasoning", "accepted", null],
      ["capability_check", "reasoning", "accepted", null],
      ["capability_check", "temperature", "rejected", 0],
      ["capability_check", "temperature", "rejected", 0.5]
    ]);
    expect(sent).toHaveLength(5);
  });

  it("checks OpenAI at the platform's base-URL override, as saving records it", async () => {
    const urls: string[] = [];
    const check = bindingResolutionServices(async () => "sk-openai", {
      fetch: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify({ model: "gpt-x", choices: [{ message: { content: JSON.stringify(VERDICT) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      },
      now: () => new Date("2026-09-26T00:00:00.000Z")
    });
    const previous = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
    try {
      const report = await checkBindingCapabilities(check, "project", { ...base, provider: "openai", modelId: "gpt-x", modelVersion: "gpt-x", outputTokenLimit: null });
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every((url) => url.startsWith("https://gateway.example/v1/"))).toBe(true);
      expect(report.protocol).toBe("openai.structured-output/v1");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previous;
    }
  });

  it("never sends a key to a URL only the custom provider may name", async () => {
    const urls: string[] = [];
    const check = bindingResolutionServices(async () => "sk-openai", {
      fetch: async (url) => {
        urls.push(url);
        return new Response("{}");
      }
    });
    const elsewhere = { ...base, provider: "openai" as const, endpoint: { kind: "custom" as const, baseUrl: "https://attacker.example/v1" }, modelId: "gpt-x", modelVersion: "gpt-x", outputTokenLimit: null };
    expect(CapabilityCheckInputSchema.safeParse(elsewhere).success).toBe(false);
    await expect(checkBindingCapabilities(check, "project", elsewhere)).rejects.toBeInstanceOf(ExecutionBindingInputError);
    expect(urls).toEqual([]);
  });

  it("refuses every input no saved binding could have", () => {
    const refused = [
      { ...base, provider: "custom" as const },
      { ...base, routing: { requireParameters: true, allowFallbacks: false } as const },
      { ...base, outputTokenLimit: null },
      { ...base, provider: "typesafe" as const, modelId: "jev-1.13.0", modelVersion: "jev-1.13.0" }
    ];
    for (const input of refused) expect(CapabilityCheckInputSchema.safeParse(input).success).toBe(false);
    expect(CapabilityCheckInputSchema.safeParse(base).success).toBe(true);
  });

  it("checks a custom provider at the URL its author names", async () => {
    const urls: string[] = [];
    const check = bindingResolutionServices(async () => "sk-custom", {
      fetch: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify({ model: "local", choices: [{ message: { content: JSON.stringify(VERDICT) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      }
    });
    const report = await checkBindingCapabilities(check, "project", {
      ...base, provider: "custom", endpoint: { kind: "custom", baseUrl: "https://judge.example/v1" }, modelId: "local", modelVersion: "local", outputTokenLimit: null
    });
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith("https://judge.example/v1/"))).toBe(true);
    expect(report.credentialSource).toBe("project");
  });

  it("reports what the provider publishes about the model", async () => {
    const check = bindingResolutionServices(async () => "sk-project", {
      fetch: async () => accepted(),
      capabilityFetch: async () => new Response(JSON.stringify({
        id: "claude-opus-5-5",
        capabilities: {
          effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: false } },
          structured_outputs: { supported: true },
          thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } }
        }
      }))
    });
    const report = await checkBindingCapabilities(check, "project", base);
    expect(report.published).toEqual({
      structuredOutput: true, toolUse: null, temperature: null, topP: null, reasoning: true, thinkingTypes: ["adaptive"], effortLevels: ["low", "medium"]
    });
  });

  it("never reports the key, even when the provider echoes it", async () => {
    const { services: check } = services(() => rejected("Invalid key sk-project for this model."));
    const report = await checkBindingCapabilities(check, "project", base);
    expect(JSON.stringify(report)).not.toContain("sk-project");
    expect(JSON.stringify(report)).toContain("[redacted]");
  });

  it("ends a check out of time with what it learned, and says it was interrupted", async () => {
    let tick = 0;
    const sent: unknown[] = [];
    const check = bindingResolutionServices(async () => "sk-project", {
      fetch: async (_url, init) => {
        sent.push(init.body);
        return accepted();
      },
      capabilityFetch: async () => new Response("{}", { status: 404 }),
      // Each reading of the clock is 25 seconds later, so the third probe can't start.
      now: () => new Date(Date.UTC(2026, 8, 26) + (tick++) * (CAPABILITY_CHECK_BUDGET_MS * 5 / 12))
    });
    const report = await checkBindingCapabilities(check, "project", base);
    expect(sent).toHaveLength(2);
    expect(report.interrupted).toBe(true);
    expect(report.probes.slice(0, 2).map((probe) => probe.outcome)).toEqual(["accepted", "accepted"]);
  });

  it("checks a TypeSafe model with its one protocol and no setting probes", async () => {
    const { sent, services: check } = services(() => new Response(JSON.stringify({
      model: "jev-1.13.0", answers: { verdict: { type: "noul", noul: 0.97 } }, usage: { input_tokens: 4, output_tokens: 1 }
    })));
    const report = await checkBindingCapabilities(check, "project", { ...base, provider: "typesafe", modelId: "jev-1.13.0", modelVersion: "jev-1.13.0", outputTokenLimit: null });
    expect(report).toMatchObject({ protocol: "typed-question/v1", temperatureSupport: null, reasoningSupport: null, probedReasoning: null, documentedDefault: null });
    expect(sent).toHaveLength(1);
  });
});

describe("resolution after save (ADR-0014 section 4)", () => {
  it("confirms the saved request and probes an unset temperature, never reasoning", async () => {
    const { sent, services: save } = services(() => accepted());
    const record = await resolveSavedBinding(save, governed({ ...OPUS, reasoning: null }));
    expect(record.status).toBe("resolved");
    expect(record.probes.map((probe) => probe.purpose)).toEqual(["confirm", "temperature"]);
    expect(sent).toHaveLength(2);
  });

  it("is recorded against the save, only where a binding needs it and a call could be made", async () => {
    const recorded: unknown[] = [];
    const repository = (binding: ExecutionBinding, record: Awaited<ReturnType<typeof resolveSavedBinding>> | null = null) => ({
      getGovernedBinding: async () => ({ binding: governed(binding), record }),
      recordResolution: async (attempt: unknown, stored: unknown) => {
        recorded.push(attempt);
        return stored;
      }
    }) as unknown as EvaluatorLifecycleRepository;
    const { services: save } = services(() => accepted());
    await savedVersionResolver(repository(SEEDED_BINDING), save)({ projectId: "project", skillVersionId: "version" });
    expect(recorded).toEqual([expect.objectContaining({
      skillVersionId: "version", kind: "resolution", triggerKind: "version_save", triggerRef: "version-save:version", outcome: "resolved"
    })]);
    recorded.length = 0;
    await savedVersionResolver(repository({ ...SEEDED_BINDING, provider: "mock", verdictProtocol: "mock/v1", reasoning: null, outputTokenLimit: null, sampling: { temperature: null, topP: null } }), save)({ projectId: "project", skillVersionId: "version" });
    await savedVersionResolver(repository({ ...SEEDED_BINDING, modelId: "claude-latest" }), save)({ projectId: "project", skillVersionId: "version" });
    await savedVersionResolver(repository(SEEDED_BINDING, await resolvedRecordFor(SEEDED_BINDING)), save)({ projectId: "project", skillVersionId: "version" });
    expect(recorded).toEqual([]);
  });

  it("resolves once: a stored record, even one lacking an answer only a gate needs, isn't probed again", async () => {
    let stored: ResolutionRecord | null = null;
    const repository = {
      getGovernedBinding: async () => ({ binding: governed({ ...OPUS, reasoning: null }), record: stored }),
      recordResolution: async (_attempt: unknown, record: ResolutionRecord | null) => {
        stored = record;
        return record;
      }
    } as unknown as EvaluatorLifecycleRepository;
    const { sent, services: save } = services(() => accepted());
    const resolve = savedVersionResolver(repository, save);
    await resolve({ projectId: "project", skillVersionId: "version" });
    expect(stored).toMatchObject({ status: "resolved", reasoningSupport: null });
    expect(resolutionNeeded({ ...OPUS, reasoning: null }, stored)).toBe(true);
    const calls = sent.length;
    await resolve({ projectId: "project", skillVersionId: "version" });
    expect(sent).toHaveLength(calls);
  });

  it("retries an unresolved record, and leaves a failed one for a new version", async () => {
    const recorded: unknown[] = [];
    const repository = (record: ResolutionRecord) => ({
      getGovernedBinding: async () => ({ binding: governed(SEEDED_BINDING), record }),
      recordResolution: async (attempt: unknown, stored: unknown) => {
        recorded.push(attempt);
        return stored;
      }
    }) as unknown as EvaluatorLifecycleRepository;
    const resolved = await resolvedRecordFor(SEEDED_BINDING);
    const { services: save } = services(() => accepted());
    await savedVersionResolver(repository({ ...resolved, status: "failed" }), save)({ projectId: "project", skillVersionId: "version" });
    expect(recorded).toEqual([]);
    await savedVersionResolver(repository({ ...resolved, status: "unresolved" }), save)({ projectId: "project", skillVersionId: "version" });
    expect(recorded).toEqual([expect.objectContaining({ triggerKind: "version_save", outcome: "resolved" })]);
  });
});

describe("the ignored-temperature table (ADR-0014 decision 12)", () => {
  const DEEPSEEK_URL = "https://api.deepseek.com";
  const deepSeek = (baseUrl: string, modelId = "deepseek-flash") => ({
    provider: "custom" as const, endpoint: { kind: "custom" as const, baseUrlDigest: endpointBaseUrlDigest(baseUrl) }, modelId
  });
  const HIGH = { family: "openai", effort: "high" } as const;

  it("cites dated provider documentation for every entry", () => {
    expect(IGNORED_TEMPERATURE_VERSION).toBe("rubrist-ignored-temperature/v1");
    for (const entry of ignoredTemperatureTable()) {
      expect(entry.sources.length).toBeGreaterThan(0);
      expect(entry.sources.every((source) => source.startsWith("https://"))).toBe(true);
      expect(entry.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("matches a custom endpoint through its digest, with the exact model id and the saved reasoning, unset included", () => {
    expect(ignoredTemperatureEntryFor(deepSeek(DEEPSEEK_URL), HIGH)).toMatchObject({ endpoint: { kind: "custom", baseUrl: DEEPSEEK_URL }, modelId: "deepseek-flash", reasoning: HIGH });
    expect(ignoredTemperatureEntryFor(deepSeek(DEEPSEEK_URL, "deepseek-v4-pro"), null)).toMatchObject({ reasoning: null });
    // The platform's OpenAI base-URL override names the same endpoint.
    expect(ignoredTemperatureEntryFor({ ...deepSeek(DEEPSEEK_URL), provider: "openai" }, null)).not.toBeNull();
    expect(ignoredTemperatureEntries(deepSeek(DEEPSEEK_URL)).map((entry) => entry.reasoning)).toEqual([
      null, { family: "openai", effort: "minimal" }, { family: "openai", effort: "low" }, { family: "openai", effort: "medium" }, HIGH
    ]);
  });

  it("doesn't match a base URL spelled differently, other reasoning, or another model", () => {
    for (const spelling of ["https://api.deepseek.com/", "https://api.deepseek.com/v1", "https://API.deepseek.com", "http://api.deepseek.com"]) {
      expect(ignoredTemperatureEntryFor(deepSeek(spelling), HIGH), spelling).toBeNull();
    }
    expect(ignoredTemperatureEntryFor(deepSeek(DEEPSEEK_URL), { family: "openai", effort: "none" })).toBeNull();
    expect(ignoredTemperatureEntryFor(deepSeek(DEEPSEEK_URL, "deepseek-v4-flash"), HIGH)).toBeNull();
  });

  it("matches a managed endpoint by its provider only", () => {
    const table: IgnoredTemperatureEntry[] = [{
      endpoint: { kind: "managed", provider: "openrouter" }, modelId: "vendor/model", reasoning: null,
      sources: ["https://provider.example/docs"], reviewedOn: "2026-09-27"
    }];
    const managed = { provider: "openrouter" as const, endpoint: { kind: "managed" as const }, modelId: "vendor/model" };
    expect(ignoredTemperatureEntryFor(managed, null, table)).toEqual(table[0]);
    expect(ignoredTemperatureEntryFor({ ...managed, provider: "openai" }, null, table)).toBeNull();
    expect(ignoredTemperatureEntryFor({ ...managed, endpoint: { kind: "custom", baseUrlDigest: endpointBaseUrlDigest("https://openrouter.ai/api/v1") } }, null, table)).toBeNull();
  });

  describe("for a listed binding", () => {
    const chat = () => new Response(JSON.stringify({
      id: "c", model: "deepseek-flash", choices: [{ message: { content: JSON.stringify(VERDICT) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 }
    }));
    const binding = (baseUrl: string, temperature: number | null): GovernedBinding => ({
      projectId: "project",
      executionBinding: {
        provider: "custom", endpoint: { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(baseUrl) }, modelId: "deepseek-flash", modelVersion: "deepseek-flash",
        sampling: { temperature, topP: null }, reasoning: HIGH, outputTokenLimit: null, verdictProtocol: "openai.structured-output/v1", routing: null
      },
      customEndpointUrl: baseUrl,
      spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }
    });

    it("hides nothing from the check but its temperature probes, and says with which reasoning it is listed", async () => {
      const { sent, services: s } = services(() => chat());
      const report = await checkBindingCapabilities(s, "project", {
        provider: "custom", endpoint: { kind: "custom", baseUrl: DEEPSEEK_URL }, modelId: "deepseek-flash", modelVersion: "deepseek-flash", outputTokenLimit: null, routing: null
      });
      expect(report.probes.map((probe) => probe.purpose)).toEqual(["protocol", "reasoning", "reasoning"]);
      expect(sent.every((body) => !("temperature" in body))).toBe(true);
      expect(report).toMatchObject({ temperatureSupport: null, probedReasoning: null, ignoredTemperatureVersion: IGNORED_TEMPERATURE_VERSION });
      expect(report.temperatureIgnoredWith).toHaveLength(5);
      expect(report.temperatureIgnoredWith).toContainEqual(null);
    });

    it("resolves with no temperature probe, records the entry, lets temperature stay unset, and refuses a stated one", async () => {
      const unset = await resolveGovernedBinding(services(() => chat()).services, binding(DEEPSEEK_URL, null));
      expect(unset.probes.map((probe) => probe.purpose)).toEqual(["confirm"]);
      expect(unset).toMatchObject({ status: "resolved", ignoredTemperatureVersion: IGNORED_TEMPERATURE_VERSION, ignoredTemperatureEntry: { modelId: "deepseek-flash", reasoning: HIGH } });
      expect(governedGateRefusal(binding(DEEPSEEK_URL, null).executionBinding, unset)).toBeNull();
      expect(resolutionNeeded(binding(DEEPSEEK_URL, null).executionBinding, unset)).toBe(false);

      const stated = binding(DEEPSEEK_URL, 0).executionBinding;
      const record = await resolveGovernedBinding(services(() => chat()).services, binding(DEEPSEEK_URL, 0));
      expect(governedGateRefusal(stated, record)).toMatchObject({
        problems: [`temperature must be unset: ${IGNORED_TEMPERATURE_VERSION} lists deepseek-flash as ignoring temperature with the saved reasoning`],
        suggestion: `Save a new evaluator version that leaves temperature unset: ${IGNORED_TEMPERATURE_VERSION} lists deepseek-flash as ignoring it with the saved reasoning.`
      });
    });

    it("isn't listed at a base URL spelled differently, where evidence attests what was sent", async () => {
      const { sent, services: s } = services(() => chat());
      const record = await resolveGovernedBinding(s, binding(`${DEEPSEEK_URL}/`, null));
      expect(record).toMatchObject({ ignoredTemperatureEntry: null, temperatureSupport: "adjustable" });
      expect(sent.map((body) => body.temperature)).toEqual([undefined, 0]);
    });
  });
});

describe("temperature classification for newly selected reasoning, through the capability check", () => {
  const gpt = { provider: "openai" as const, endpoint: { kind: "managed" as const }, modelId: "gpt-5.5", modelVersion: "gpt-5.5", outputTokenLimit: null, routing: null };
  const NONE = { family: "openai", effort: "none" } as const;
  // Temperature is accepted only with reasoning effort none (CURRENT for gpt-5.5, measured 2026-09-27).
  const gptLike = () => {
    const sent: Array<Record<string, unknown>> = [];
    const check = bindingResolutionServices(async () => "sk-openai", {
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        sent.push(body);
        if ("temperature" in body && body.reasoning_effort !== "none") {
          return new Response(JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.", type: "invalid_request_error", param: "temperature", code: "unsupported_value" } }), { status: 400 });
        }
        return new Response(JSON.stringify({ model: "gpt-5.5", choices: [{ message: { content: JSON.stringify(VERDICT) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      },
      now: () => new Date("2026-09-26T00:00:00.000Z")
    });
    return { sent, check };
  };

  it("sends the reasoning without temperature, then the temperature probes, at most 3 calls", async () => {
    const { sent, check } = gptLike();
    const report = await checkBindingCapabilities(check, "project", { ...gpt, classifyTemperature: { reasoning: NONE, verdictProtocol: "openai.structured-output/v1", baselineAccepted: false } });
    expect(sent.map((body) => [body.reasoning_effort, body.temperature])).toEqual([["none", undefined], ["none", 0]]);
    expect(report).toMatchObject({ protocol: "openai.structured-output/v1", probedReasoning: NONE, temperatureSupport: "adjustable" });

    const high = gptLike();
    const notAdjustable = await checkBindingCapabilities(high.check, "project", {
      ...gpt, classifyTemperature: { reasoning: { family: "openai", effort: "high" }, verdictProtocol: "openai.structured-output/v1", baselineAccepted: false }
    });
    expect(high.sent).toHaveLength(3);
    expect(notAdjustable.temperatureSupport).toBe("not_adjustable");
  });

  it("skips the reasoning call the check already saw accepted, and then classifies nothing it didn't see", async () => {
    const { sent, check } = gptLike();
    const report = await checkBindingCapabilities(check, "project", { ...gpt, classifyTemperature: { reasoning: NONE, verdictProtocol: "openai.structured-output/v1", baselineAccepted: true } });
    expect(sent.map((body) => body.temperature)).toEqual([0]);
    expect(report).toMatchObject({ temperatureSupport: null, probes: [{ purpose: "temperature", outcome: "accepted" }] });
  });

  it("refuses a classification no binding could need", () => {
    const refused = [
      { ...gpt, provider: "typesafe" as const, modelId: "jev-1.13.0", modelVersion: "jev-1.13.0", classifyTemperature: { reasoning: null, verdictProtocol: "typed-question/v1" as const, baselineAccepted: false } },
      { ...gpt, classifyTemperature: { reasoning: NONE, verdictProtocol: "anthropic.structured-output/v1" as const, baselineAccepted: false } },
      { ...gpt, classifyTemperature: { reasoning: { family: "anthropic" as const, thinking: { type: "adaptive" as const }, effort: null }, verdictProtocol: "openai.structured-output/v1" as const, baselineAccepted: false } },
      { ...gpt, classifyTemperature: { reasoning: NONE, verdictProtocol: "openai.structured-output/v1" as const } }
    ];
    for (const input of refused) expect(CapabilityCheckInputSchema.safeParse(input).success).toBe(false);
    expect(CapabilityCheckInputSchema.safeParse({ ...gpt, classifyTemperature: { reasoning: NONE, verdictProtocol: "openai.structured-output/v1", baselineAccepted: false } }).success).toBe(true);
  });
});

describe("a record resolved before ADR-0014 decision 12", () => {
  it("doesn't parse, so it reads as no record and the binding resolves again", async () => {
    const current = await temperatureRejectingRecordFor(OPUS);
    // Such a record probed temperature at 1 and summarized it by wording.
    const { ignoredTemperatureVersion: _version, ignoredTemperatureEntry: _entry, ...rest } = current;
    const old = {
      ...rest,
      temperatureSupport: "parameter_rejected",
      probes: rest.probes.filter((probe) => probe.sent.temperature !== 0.5)
        .map((probe) => probe.purpose === "temperature" ? { ...probe, sent: { ...probe.sent, temperature: 1 } } : probe)
    };
    const db = (record: unknown) => ({
      query: async () => ({ rows: [{ record: JSON.stringify(record), binding_digest: sha256Digest(OPUS) }] })
    }) as unknown as Parameters<typeof loadResolutionRecord>[0];
    expect(await loadResolutionRecord(db(old), "project", "version", OPUS)).toBeNull();
    // Each old part alone is enough.
    expect(await loadResolutionRecord(db({ ...current, temperatureSupport: "parameter_rejected" }), "project", "version", OPUS)).toBeNull();
    expect(await loadResolutionRecord(db(rest), "project", "version", OPUS)).toBeNull();
    expect(await loadResolutionRecord(db(current), "project", "version", OPUS)).toEqual(current);
    expect(resolutionNeeded(OPUS, null)).toBe(true);
  });
});
