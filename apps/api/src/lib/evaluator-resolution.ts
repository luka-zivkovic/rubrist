import {
  EvaluatorCallError,
  executeTypedQuestion,
  executeVerdict,
  type ExecutionFetch,
  type TokenUsage,
  type TypedQuestionEvaluator,
  type VerdictSpec
} from "@rubrist/audit/runtime";
import {
  CapabilityProbeSchema,
  IGNORED_TEMPERATURE_VERSION,
  REASONING_DEFAULTS_VERSION,
  ResolutionRecordSchema,
  TEMPERATURE_PROBE_VALUES,
  probeRequestAccepted,
  reasoningFamilyFor,
  takesSamplingSettings,
  temperatureOutcome,
  temperatureSupportWith,
  type CapabilityProbe,
  type ExecutionBinding,
  type IgnoredTemperatureEntry,
  type JudgeProviderCredentialSource,
  type ReasoningSettings,
  type ResolutionRecord,
  type SettingSupport,
  type TemperatureSupport,
  type VerdictProtocolId
} from "@rubrist/shared";
import { canonicalJson } from "./canonical-json.js";
import { attributeProbeOutcome, capabilityProtocolOrder, type PublishedCapabilities } from "./evaluator-capability.js";

// The capability check, resolution, and re-check of an execution binding
// (Rubrist ADR-0014 section 4). Probes send a fixed, non-sensitive input and
// never change the binding: the check informs the author before save,
// resolution confirms or fails the saved binding, and the re-check guards one
// governed run or sealed authorization.

/**
 * One probe call: resolves with the usage the provider reported when it
 * accepted the call, and throws the call's failure otherwise.
 */
export type ProbeExecutor = (binding: ExecutionBinding) => Promise<{ usage: TokenUsage | null }>;

/** The fixed probe input: no project data, no rubric of the author's. */
export const CAPABILITY_PROBE_INPUT = {
  rubricMarkdown: "Pass when the answer states the correct sum. Fail when it doesn't.",
  prompt: "Judge the trace against the review guide below.\n\n<review_guide>\n{{rubric_markdown}}\n</review_guide>",
  trace: { id: "rubrist-capability-probe", input: { question: "What is 2 + 3?" }, output: { answer: "5" } }
} as const;

/** Probes run in sequence while an author waits, so each is short. */
export const PROBE_TIMEOUT_MS = 30_000;

/**
 * The fixed question a typed-question probe asks about the fixed trace: no
 * project data, and no question of the author's. Resolution confirms the
 * binding, so the question and threshold are the probe's own.
 */
export const TYPED_QUESTION_PROBE: Readonly<TypedQuestionEvaluator> = Object.freeze({
  question: Object.freeze({
    type: "noul" as const,
    instructions: "Does the answer state the correct sum?",
    criteria: Object.freeze({ true: "The answer states the correct sum.", false: "The answer states a wrong sum or none." })
  }),
  threshold: 0.5
});

/**
 * A probe executor over the executor each probed binding's protocol runs:
 * a prompted protocol judges the fixed input with the evaluator's verdict
 * kind, and typed-question/v1 asks the fixed question about the same trace.
 */
export function bindingProbeExecutor(input: {
  apiKey: string | null;
  customBaseUrl: string | null;
  spec: VerdictSpec;
  fetch?: ExecutionFetch;
  timeoutMs?: number;
}): ProbeExecutor {
  return async (binding) => {
    if (binding.verdictProtocol === "typed-question/v1") {
      const result = await executeTypedQuestion({
        binding,
        apiKey: input.apiKey,
        evaluator: TYPED_QUESTION_PROBE,
        trace: CAPABILITY_PROBE_INPUT.trace,
        timeoutMs: input.timeoutMs ?? PROBE_TIMEOUT_MS,
        ...(input.fetch ? { fetch: input.fetch } : {})
      });
      return { usage: result.usage };
    }
    const result = await executeVerdict({
      binding,
      apiKey: input.apiKey,
      customBaseUrl: input.customBaseUrl,
      rubricMarkdown: CAPABILITY_PROBE_INPUT.rubricMarkdown,
      prompt: CAPABILITY_PROBE_INPUT.prompt,
      trace: CAPABILITY_PROBE_INPUT.trace,
      spec: input.spec,
      timeoutMs: input.timeoutMs ?? PROBE_TIMEOUT_MS,
      ...(input.fetch ? { fetch: input.fetch } : {})
    });
    return { usage: result.usage };
  };
}

/**
 * What a reasoning probe sends where the table has no entry: a middle value
 * of the family's shape. For Anthropic it is adaptive thinking where the model
 * may support it, else enabled thinking at the minimum budget, with effort
 * `medium` only where effort is supported.
 */
export function middleReasoning(family: ReasoningSettings["family"], published: PublishedCapabilities | null): ReasoningSettings {
  switch (family) {
    case "anthropic": {
      const adaptive = published?.thinkingTypes == null || published.thinkingTypes.includes("adaptive");
      const effort = published?.effortLevels == null || published.effortLevels.includes("medium") ? "medium" : null;
      return adaptive
        ? { family, thinking: { type: "adaptive" }, effort }
        : { family, thinking: { type: "enabled", budgetTokens: 1024 }, effort };
    }
    case "openai":
      return { family, effort: "medium" };
    case "openrouter":
      return { family, enabled: true, effort: "medium", maxTokens: null };
  }
}

/** The family's no-reasoning setting. */
export function noReasoning(family: ReasoningSettings["family"]): ReasoningSettings {
  switch (family) {
    case "anthropic":
      return { family, thinking: { type: "disabled" }, effort: null };
    case "openai":
      return { family, effort: "none" };
    case "openrouter":
      return { family, enabled: false, effort: null, maxTokens: null };
  }
}

const sameSettings = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

/**
 * Sends one probe and records it. A call that never left Rubrist (no
 * credential, no endpoint, a binding the adapters refuse) is no probe, so it
 * returns `null` and nothing is recorded.
 */
async function sendProbe(
  execute: ProbeExecutor,
  published: PublishedCapabilities | null,
  stage: CapabilityProbe["stage"],
  purpose: CapabilityProbe["purpose"],
  binding: ExecutionBinding
): Promise<CapabilityProbe | null> {
  const sent = {
    temperature: binding.sampling.temperature,
    topP: binding.sampling.topP,
    reasoning: binding.reasoning,
    outputTokenLimit: binding.outputTokenLimit
  };
  let error: unknown;
  let usage: TokenUsage | null = null;
  try {
    usage = (await execute(binding)).usage;
  } catch (caught) {
    if (caught instanceof EvaluatorCallError && !caught.physicalCall) return null;
    error = caught ?? new Error("probe failed");
    usage = caught instanceof EvaluatorCallError ? caught.usage : null;
  }
  const attribution = attributeProbeOutcome({ purpose, sent }, error === undefined ? {} : { error }, published);
  return CapabilityProbeSchema.parse({ stage, purpose, verdictProtocol: binding.verdictProtocol, sent, ...attribution, usage, costMicroUsd: null });
}

/** Reasoning's support as a probe recorded it; `null` when the probe errored or says nothing about it. */
function reasoningSupportFrom(probe: CapabilityProbe): SettingSupport | null {
  if (probe.outcome === "accepted") return "accepted";
  if (probe.outcome === "error") return null;
  if (probe.rejection === "parameter" && probe.rejectedParameter === "reasoning") return "parameter_rejected";
  if (probe.rejection === "unattributed" || (probe.rejection === "value" && probe.rejectedParameter === "reasoning")) return "value_rejected";
  return null;
}

/**
 * The reasoning summary the governed gates read, from any reasoning probe.
 * The conservative answer wins: an acceptance, then a rejected value (the
 * parameter exists), and only then a rejected parameter.
 */
function summarizeReasoning(probes: readonly CapabilityProbe[]): SettingSupport | null {
  const outcomes = probes.filter((probe) => probe.purpose === "reasoning")
    .map(reasoningSupportFrom).filter((support): support is SettingSupport => support !== null);
  if (outcomes.includes("accepted")) return "accepted";
  if (outcomes.includes("value_rejected")) return "value_rejected";
  return outcomes.includes("parameter_rejected") ? "parameter_rejected" : null;
}

/**
 * The temperature probes on a request otherwise identical to `baseline`,
 * which was accepted without temperature (ADR-0014 decision 12): temperature
 * 0, and 0.5 only where 0 was rejected. A probe that ends in an error, or
 * can't be sent, stops them, and temperature stays unknown. `send` records
 * each probe; the ones sent are returned.
 */
async function sendTemperatureProbes(
  send: (binding: ExecutionBinding) => Promise<CapabilityProbe | null>,
  baseline: ExecutionBinding
): Promise<CapabilityProbe[]> {
  const sent: CapabilityProbe[] = [];
  for (const temperature of TEMPERATURE_PROBE_VALUES) {
    const probe = await send({ ...baseline, sampling: { ...baseline.sampling, temperature } });
    if (probe === null) break;
    sent.push(probe);
    // Only a rejected request moves on; an answer that breaks the protocol still accepted the temperature.
    if (probe.outcome !== "rejected" || probe.failureKind !== "provider_rejected_request") break;
  }
  return sent;
}

/** The parts of a binding a capability check probes; its probes describe only these. */
export type CapabilityCheckBase = Pick<ExecutionBinding, "provider" | "endpoint" | "modelId" | "modelVersion" | "outputTokenLimit" | "routing">;

export interface CapabilityCheckResult {
  base: CapabilityCheckBase;
  credentialSource: JudgeProviderCredentialSource | null;
  /** The first protocol a probe accepted, which the picker pre-selects; `null` when none did. */
  protocol: VerdictProtocolId | null;
  probes: CapabilityProbe[];
  temperatureSupport: TemperatureSupport | null;
  reasoningSupport: SettingSupport | null;
  /** The reasoning the temperature probes were sent with. */
  probedReasoning: ReasoningSettings | null;
}

/**
 * The capability check before save, at most 7 probes: protocols in section 3
 * order until one is accepted, sent with no optional settings; then up to two
 * reasoning probes, the documented default (or a middle value) and the
 * family's no-reasoning setting; then, once the request with the documented
 * default reasoning (no reasoning fields where the table has no entry) was
 * accepted without temperature, the temperature probes with that reasoning
 * and no topP, unless the ignored-temperature table lists the model with it
 * (ADR-0014 decision 12). A transient error, or a call that can't be sent,
 * ends the check with what it learned.
 */
export async function runCapabilityCheck(input: {
  base: CapabilityCheckBase;
  credentialSource: JudgeProviderCredentialSource | null;
  published: PublishedCapabilities | null;
  documentedDefault: ReasoningSettings | null;
  /** Whether the ignored-temperature table lists the model with the documented default reasoning. */
  temperatureIgnored: boolean;
  execute: ProbeExecutor;
}): Promise<CapabilityCheckResult> {
  const { base, published, execute } = input;
  const bare = (verdictProtocol: VerdictProtocolId): ExecutionBinding => ({
    ...base,
    sampling: { temperature: null, topP: null },
    reasoning: null,
    verdictProtocol
  });
  const probes: CapabilityProbe[] = [];
  const family = reasoningFamilyFor(base.provider);
  const probedReasoning = family === null ? null : input.documentedDefault;
  const result = (protocol: VerdictProtocolId | null): CapabilityCheckResult => ({
    base,
    credentialSource: input.credentialSource,
    protocol,
    probes,
    temperatureSupport: temperatureSupportWith(probes, { reasoning: probedReasoning, topP: null }),
    reasoningSupport: summarizeReasoning(probes),
    probedReasoning
  });
  const send = async (purpose: CapabilityProbe["purpose"], binding: ExecutionBinding): Promise<CapabilityProbe | null> => {
    const probe = await sendProbe(execute, published, "capability_check", purpose, binding);
    if (probe !== null) probes.push(probe);
    return probe;
  };
  const ended = (probe: CapabilityProbe | null) => probe === null || probe.outcome === "error";

  let protocol: VerdictProtocolId | null = null;
  for (const candidate of capabilityProtocolOrder(base.provider, published).slice(0, 3)) {
    const probe = await send("protocol", bare(candidate));
    if (ended(probe)) return result(null);
    if (probe!.outcome === "accepted") {
      protocol = candidate;
      break;
    }
    // Only a rejection of the mechanism, or one Rubrist can't attribute, moves to the next protocol.
    if (probe!.rejection !== "mechanism" && probe!.rejection !== "unattributed") return result(null);
  }
  if (protocol === null) return result(null);
  if (family !== null) {
    for (const reasoning of [input.documentedDefault ?? middleReasoning(family, published), noReasoning(family)]) {
      if (ended(await send("reasoning", { ...bare(protocol), reasoning }))) return result(protocol);
    }
  }
  const baseline: ExecutionBinding = { ...bare(protocol), reasoning: probedReasoning };
  // The protocol probe, or the reasoning probe with the documented default, is the request the temperature probes add to.
  const baselineAccepted = probes.some((probe) => probe.sent.temperature === null && probe.verdictProtocol === protocol &&
    sameSettings(probe.sent.reasoning, probedReasoning) && probeRequestAccepted(probe));
  if (takesSamplingSettings(base.provider) && !input.temperatureIgnored && baselineAccepted) {
    await sendTemperatureProbes((binding) => send("temperature", binding), baseline);
  }
  return result(protocol);
}

/**
 * Classifies temperature for reasoning the author selected after the check
 * (ADR-0014 decision 12), on the author's protocol with no topP, at most 3
 * calls: that reasoning without temperature, unless the check already saw
 * that request accepted (`baselineAccepted`), then the temperature probes
 * once it is accepted. A combination the ignored-temperature table lists is
 * sent nothing. It is reported as a check of that reasoning, classified only
 * from what this call saw: where the caller vouched for the baseline, the
 * report says nothing about temperature, and the picker reads these probes
 * together with the check's.
 */
export async function classifyTemperatureFor(input: {
  base: CapabilityCheckBase;
  credentialSource: JudgeProviderCredentialSource | null;
  published: PublishedCapabilities | null;
  verdictProtocol: VerdictProtocolId;
  reasoning: ReasoningSettings | null;
  baselineAccepted: boolean;
  /** Whether the ignored-temperature table lists the model with this reasoning. */
  temperatureIgnored: boolean;
  execute: ProbeExecutor;
}): Promise<CapabilityCheckResult> {
  const baseline: ExecutionBinding = {
    ...input.base,
    sampling: { temperature: null, topP: null },
    reasoning: input.reasoning,
    verdictProtocol: input.verdictProtocol
  };
  const probes: CapabilityProbe[] = [];
  const send = async (purpose: CapabilityProbe["purpose"], binding: ExecutionBinding): Promise<CapabilityProbe | null> => {
    const probe = await sendProbe(input.execute, input.published, "capability_check", purpose, binding);
    if (probe !== null) probes.push(probe);
    return probe;
  };
  const result = (): CapabilityCheckResult => ({
    base: input.base,
    credentialSource: input.credentialSource,
    protocol: input.verdictProtocol,
    probes,
    temperatureSupport: temperatureSupportWith(probes, { reasoning: input.reasoning, topP: null }),
    reasoningSupport: summarizeReasoning(probes),
    probedReasoning: input.reasoning
  });
  if (!takesSamplingSettings(input.base.provider) || input.temperatureIgnored) return result();
  if (!input.baselineAccepted) {
    // With no reasoning fields, the baseline is the protocol probe's request.
    const probe = await send(input.reasoning === null ? "protocol" : "reasoning", baseline);
    if (probe === null || !probeRequestAccepted(probe)) return result();
  }
  await sendTemperatureProbes((binding) => send("temperature", binding), baseline);
  return result();
}

function checkDescribes(check: CapabilityCheckResult, binding: ExecutionBinding, credentialSource: JudgeProviderCredentialSource | null): boolean {
  const base: CapabilityCheckBase = {
    provider: binding.provider,
    endpoint: binding.endpoint,
    modelId: binding.modelId,
    modelVersion: binding.modelVersion,
    outputTokenLimit: binding.outputTokenLimit,
    routing: binding.routing
  };
  // Capabilities can differ per key, so the check must have used the same credential source.
  return sameSettings(check.base, base) && check.credentialSource === credentialSource;
}

/**
 * Resolution of a saved binding (ADR-0014 section 4). One confirming probe
 * sends the exact saved request, and only it decides: accepted is
 * `resolved`, a rejection is `failed`, and an error leaves the binding
 * `unresolved`. The binding is never changed.
 *
 * Once the saved request is accepted, a setting the family has and the
 * binding leaves unset is probed, unless the recorded probes already answer
 * for it: temperature, at save and at a gate, with the saved reasoning and
 * topP and the confirming probe as the request it adds to (0, then 0.5 where
 * 0 is rejected), and never where the ignored-temperature table lists the
 * combination (decision 12); reasoning only at a gate. So at most 3 calls at
 * save and 4 at a gate. Check probes count only when the check describes
 * this binding and used the same credential source. The record keeps the
 * table version and the entry that matched.
 */
export async function resolveExecutionBinding(input: {
  binding: ExecutionBinding;
  trigger: "save" | "gate";
  check: CapabilityCheckResult | null;
  published: PublishedCapabilities | null;
  documentedDefault: ReasoningSettings | null;
  credentialSource: JudgeProviderCredentialSource | null;
  /** The ignored-temperature entry listing the saved combination, matched on the server; `null` when unlisted. */
  ignoredTemperature: IgnoredTemperatureEntry | null;
  execute: ProbeExecutor;
  now: Date;
}): Promise<ResolutionRecord> {
  const { binding, execute, published } = input;
  const checkProbes = input.check !== null && checkDescribes(input.check, binding, input.credentialSource)
    ? input.check.probes.filter((probe) => probe.stage === "capability_check" && probe.verdictProtocol === binding.verdictProtocol)
    : [];
  const probes: CapabilityProbe[] = [...checkProbes];
  const send = async (purpose: CapabilityProbe["purpose"], probed: ExecutionBinding): Promise<CapabilityProbe | null> => {
    const probe = await sendProbe(execute, published, "resolution", purpose, probed);
    if (probe !== null) probes.push(probe);
    return probe;
  };
  const confirm = await send("confirm", binding);
  const family = reasoningFamilyFor(binding.provider);
  const saved = { reasoning: binding.reasoning, topP: binding.sampling.topP };

  if (confirm?.outcome === "accepted") {
    if (takesSamplingSettings(binding.provider) && binding.sampling.temperature === null && input.ignoredTemperature === null &&
        temperatureSupportWith(probes, saved) === null) {
      await sendTemperatureProbes((probed) => send("temperature", probed), binding);
    }
    if (input.trigger === "gate" && family !== null && binding.reasoning === null &&
        !probes.some((probe) => probe.purpose === "reasoning" && probe.outcome !== "error")) {
      await send("reasoning", { ...binding, reasoning: input.documentedDefault ?? middleReasoning(family, published) });
    }
  }

  return ResolutionRecordSchema.parse({
    status: confirm?.outcome === "accepted" ? "resolved" : confirm?.outcome === "rejected" ? "failed" : "unresolved",
    capabilitySnapshotDigest: published?.snapshotDigest ?? null,
    reasoningDefaultsVersion: REASONING_DEFAULTS_VERSION,
    ignoredTemperatureVersion: IGNORED_TEMPERATURE_VERSION,
    ignoredTemperatureEntry: input.ignoredTemperature,
    credentialSource: input.credentialSource,
    temperatureSupport: temperatureSupportWith(probes, saved),
    reasoningSupport: summarizeReasoning(probes),
    probes,
    checkedAt: input.now.toISOString()
  });
}

/**
 * The re-check before a sealed calibration is authorized or a governed run
 * starts: the confirming probe again; where temperature is unset and the
 * resolution record doesn't list the combination as ignoring it, the
 * temperature probes with the saved reasoning and topP; and where reasoning
 * is unset, a reasoning probe; so one to four calls (only the first when the
 * saved request isn't accepted). The resolution holds only if the saved
 * request is still accepted, temperature 0 and 0.5 are still both rejected,
 * and reasoning is still rejected as a parameter: a provider that starts
 * letting the author choose an unset setting would otherwise apply its own
 * default unseen. A transient error means it can't be shown to hold, so the
 * run waits. The probes belong to the run they guard; the resolution record
 * never changes.
 */
export async function recheckExecutionBinding(input: {
  binding: ExecutionBinding;
  published: PublishedCapabilities | null;
  documentedDefault: ReasoningSettings | null;
  /** Whether the resolution record lists the combination as ignoring temperature, in the table version it names. */
  temperatureIgnored: boolean;
  execute: ProbeExecutor;
}): Promise<{ holds: boolean; probes: CapabilityProbe[] }> {
  const { binding, execute, published } = input;
  const probes: CapabilityProbe[] = [];
  let unsent = false;
  const send = async (purpose: CapabilityProbe["purpose"], probed: ExecutionBinding): Promise<CapabilityProbe | null> => {
    const probe = await sendProbe(execute, published, "recheck", purpose, probed);
    if (probe === null) unsent = true;
    else probes.push(probe);
    return probe;
  };
  const confirm = await send("confirm", binding);
  if (confirm?.outcome !== "accepted") return { holds: false, probes };
  const family = reasoningFamilyFor(binding.provider);
  let holds = true;
  if (takesSamplingSettings(binding.provider) && binding.sampling.temperature === null && !input.temperatureIgnored) {
    const temperature = await sendTemperatureProbes((probed) => send("temperature", probed), binding);
    if (unsent) return { holds: false, probes };
    if (temperatureOutcome(temperature) !== "not_adjustable") holds = false;
  }
  if (family !== null && binding.reasoning === null) {
    const probe = await send("reasoning", { ...binding, reasoning: input.documentedDefault ?? middleReasoning(family, published) });
    if (probe === null) return { holds: false, probes };
    if (reasoningSupportFrom(probe) !== "parameter_rejected") holds = false;
  }
  return { holds, probes };
}

/**
 * What stops a binding at a governed gate (ADR-0014 section 2 and decision
 * 12). Candidate creation, activation, and sealed calibration need a
 * resolved binding. Temperature must be stated wherever the model lets the
 * author choose it; it may stay unset where the family takes no sampling,
 * the record shows 0 and 0.5 both rejected with the saved reasoning and
 * topP, or the record lists the combination as ignoring temperature, where a
 * stated one is refused. Reasoning must be explicit unless the family has no
 * shape or the record shows the model rejecting the reasoning parameter
 * itself. The record must be the one resolved for this binding, and its
 * table version decides the listing, never a newer table.
 */
export function governedGateProblems(binding: ExecutionBinding, record: ResolutionRecord | null): string[] {
  const problems: string[] = [];
  if (record?.status !== "resolved") problems.push(`the execution binding is ${record?.status ?? "unresolved"}, not resolved`);
  if (takesSamplingSettings(binding.provider)) {
    const listed = record?.ignoredTemperatureEntry ?? null;
    if (binding.sampling.temperature === null) {
      if (listed === null && record?.temperatureSupport !== "not_adjustable") {
        problems.push("temperature must be explicit: the model hasn't been shown to reject temperatures 0 and 0.5 with the saved reasoning and topP");
      }
    } else if (record !== null && listed !== null) {
      problems.push(`temperature must be unset: ${record.ignoredTemperatureVersion} lists ${binding.modelId} as ignoring temperature with the saved reasoning`);
    }
  }
  if (reasoningFamilyFor(binding.provider) !== null && binding.reasoning === null && record?.reasoningSupport !== "parameter_rejected") {
    problems.push("reasoning must be explicit: the model hasn't been shown to reject the reasoning parameter");
  }
  return problems;
}
