import { createHash } from "node:crypto";
import {
  EvaluatorFailureKindSchema,
  type BinaryCalibrationCompletionEligibilityReason,
  type BinaryCalibrationErrorCode,
  type BinaryCalibrationPrivateLedger,
  type ExecutionBinding
} from "@rubrist/shared";
import { canonicalJson, sha256Digest } from "../lib/canonical-json.js";

import type {
  BinaryCalibrationActor,
  BinaryCalibrationArtifactCopy,
  BinaryCalibrationExecutionClaim,
  BinaryCalibrationProviderDataHandlingPolicy,
  BinaryCalibrationRunProjection,
  CompleteBinaryCalibrationAttemptInput,
  CreateBinaryCalibrationRunInput
} from "./repository.js";
import { BinaryCalibrationRepositoryError } from "./repository.js";

export const COVERED_CAPABILITIES = [
  "criterion_authoring",
  "instruction_authoring",
  "evaluator_authoring",
  "rubric_authoring",
  "prompt_authoring",
  "example_selection",
  "development_exposure"
] as const;

export interface RunRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  dataset_revision_id: string;
  revision_digest: string;
  truth_content_digest: string;
  item_count: number;
  criterion_id: string;
  criterion_version_id: string;
  criterion_digest: string;
  skill_id: string;
  skill_version_id: string;
  requested_provider: string;
  definition_digest: string;
  execution_binding: unknown;
  requested_binding_digest: string;
  suite_manifest_id: string | null;
  suite_manifest_digest: string | null;
  suite_member_position: number | null;
  positive_class: "pass" | "fail";
  state: BinaryCalibrationRunProjection["state"];
  planned_observations: number;
  accounted_observations: number;
  artifact_id: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

export interface FrozenOriginRow extends Record<string, unknown> {
  batch_id: string;
  batch_content_digest: string;
  instruction_version_id: string;
  instruction_digest: string;
  population_id: string;
  population_digest: string;
  source_population_id: string;
  population_definition: unknown;
  population_collection_provenance: unknown;
  population_size: number;
  selection_method: string;
  selection_seed: string | null;
  rng_version: string | null;
  draw_executed_by: string;
  fixed_budget: number;
  draw_digest: string;
  strata: unknown;
  custodian_subject_id: string;
}

export interface EligibilityResult {
  exposureState: "protected" | "exposed";
  eligible: boolean;
  reasons: BinaryCalibrationCompletionEligibilityReason[];
  snapshot: Record<string, unknown>;
}

export function aggregateTrial(records: BinaryCalibrationPrivateLedger["records"]) {
  const outcomes = {
    planned: records.length,
    classified: 0,
    abstained: 0,
    errored: 0,
    notAttempted: 0,
    providerCalls: 0,
    byTruth: {
      pass: { classified: 0, abstained: 0, errored: 0, notAttempted: 0 },
      fail: { classified: 0, abstained: 0, errored: 0, notAttempted: 0 }
    },
    errors: [] as Array<{ code: BinaryCalibrationErrorCode; count: number }>
  };
  const truthSupport = { total: records.length, pass: 0, fail: 0 };
  const confusionMatrix = {
    truthPassEvaluatorPass: 0,
    truthPassEvaluatorFail: 0,
    truthFailEvaluatorPass: 0,
    truthFailEvaluatorFail: 0
  };
  const errors = new Map<BinaryCalibrationErrorCode, number>();
  const groups = new Map<string, {
    provider: string;
    observedModel: string | null;
    observedVersion: string | null;
    systemFingerprint: string | null;
    upstreamProvider: string | null;
    identityStrength: "observed_version" | "observed_fingerprint" | "observed_model" | "requested_only";
    observationCount: number;
  }>();
  for (const record of records) {
    truthSupport[record.truthLabel] += 1;
    outcomes.providerCalls += record.physicalProviderCalls;
    const result = record.result;
    const bucket = result.state === "not_attempted"
      ? "notAttempted"
      : result.state === "failure"
        ? "errored"
        : result.outcome === "abstain" ? "abstained" : "classified";
    outcomes[bucket] += 1;
    outcomes.byTruth[record.truthLabel][bucket] += 1;
    if (result.state === "outcome" && result.outcome !== "abstain") {
      const evaluatorPass = result.outcome === "pass";
      confusionMatrix[record.truthLabel === "pass"
        ? evaluatorPass ? "truthPassEvaluatorPass" : "truthPassEvaluatorFail"
        : evaluatorPass ? "truthFailEvaluatorPass" : "truthFailEvaluatorFail"] += 1;
    }
    if (result.state === "failure") errors.set(result.failureKind, (errors.get(result.failureKind) ?? 0) + 1);
    const identityStrength = record.providerObservation.observedVersion !== null
      ? "observed_version" as const
      : record.providerObservation.systemFingerprint !== null
        ? "observed_fingerprint" as const
        : record.providerObservation.observedModel !== null
          ? "observed_model" as const
          : "requested_only" as const;
    const group = { ...record.providerObservation, identityStrength, observationCount: 1 };
    const key = canonicalJson({
      provider: group.provider,
      observedModel: group.observedModel,
      observedVersion: group.observedVersion,
      systemFingerprint: group.systemFingerprint,
      upstreamProvider: group.upstreamProvider,
      identityStrength: group.identityStrength
    });
    const prior = groups.get(key);
    groups.set(key, prior ? { ...prior, observationCount: prior.observationCount + 1 } : group);
  }
  outcomes.errors = [...errors.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([code, count]) => ({ code, count }));
  const providerIdentityGroups = [...groups.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, group]) => group);
  return { outcomes, truthSupport, confusionMatrix, providerIdentityGroups };
}

export function providerPolicyFor(binding: ExecutionBinding): {
  policy: BinaryCalibrationProviderDataHandlingPolicy;
  canonicalBytes: Buffer;
} {
  const executionEnvironment = "external_provider" as const;
  const policyContent = {
    contract: "rubrist/provider-data-handling-policy/v1",
    schemaVersion: 1,
    provider: binding.provider,
    endpoint: binding.endpoint,
    executionEnvironment,
    payloadTransmission: "sealed_payload_to_pinned_provider" as const,
    rawProviderResponsePersistence: "none"
  };
  const policyDigest = sha256Digest(policyContent);
  return {
    policy: {
      executionEnvironment,
      policyId: stableId("bcp", policyDigest),
      policyDigest,
      payloadTransmission: "sealed_payload_to_pinned_provider"
    },
    canonicalBytes: Buffer.from(canonicalJson(policyContent), "utf8")
  };
}

export function rowToRun(row: RunRow): BinaryCalibrationRunProjection {
  return {
    runId: String(row.id),
    projectId: String(row.project_id),
    datasetRevisionId: String(row.dataset_revision_id),
    revisionDigest: String(row.revision_digest),
    criterionId: String(row.criterion_id),
    criterionVersionId: String(row.criterion_version_id),
    skillId: String(row.skill_id),
    skillVersionId: String(row.skill_version_id),
    positiveClass: row.positive_class === "pass" ? "pass" : "fail",
    trialPlan: { kind: "single", trialsPerItem: 1 },
    suiteBinding: row.suite_manifest_id === null ? null : {
      manifestId: String(row.suite_manifest_id),
      manifestDigest: String(row.suite_manifest_digest),
      memberPosition: Number(row.suite_member_position)
    },
    state: row.state,
    plannedObservations: Number(row.planned_observations),
    accountedObservations: Number(row.accounted_observations),
    artifactId: nullableString(row.artifact_id),
    artifactDigest: nullableString(row.artifact_digest),
    evidenceDigest: nullableString(row.evidence_digest),
    createdAt: toIso(row.created_at),
    startedAt: row.started_at ? toIso(row.started_at) : null,
    completedAt: row.completed_at ? toIso(row.completed_at) : null
  };
}

export function artifactCopyFromRow(row: Record<string, unknown>): BinaryCalibrationArtifactCopy {
  return {
    artifactId: String(row.id),
    calibrationRunId: String(row.run_id),
    canonicalBytes: Uint8Array.from(Buffer.from(row.canonical_bytes as Uint8Array)),
    artifactDigest: String(row.artifact_digest),
    evidenceDigest: String(row.evidence_digest),
    createdAt: toIso(row.created_at)
  };
}

export function claimFromRow(row: Record<string, unknown>): BinaryCalibrationExecutionClaim {
  return {
    runId: String(row.id),
    workerId: String(row.claim_worker_id),
    claimToken: String(row.claim_token),
    claimExpiresAt: toIso(row.claim_expires_at)
  };
}

export function validateCreateInput(input: CreateBinaryCalibrationRunInput): void {
  if (!input.datasetRevisionId || !input.skillVersionId) {
    throw repoError("unsupported", "binary calibration requires revision and evaluator identities");
  }
  if (input.positiveClass !== "pass" && input.positiveClass !== "fail") {
    throw repoError("unsupported", "binary calibration positive class must be pass or fail");
  }
  if (input.trialPlan.kind !== "single" || input.trialPlan.trialsPerItem !== 1) {
    throw repoError("unsupported", "Batch 5B executes only one trial per item");
  }
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200 ||
      input.idempotencyKey.trim() !== input.idempotencyKey) {
    throw repoError("unsupported", "binary calibration idempotency key must be 1-200 unpadded characters");
  }
  if (input.suiteBinding && (!Number.isSafeInteger(input.suiteBinding.memberPosition) ||
      input.suiteBinding.memberPosition < 0 || input.suiteBinding.memberPosition > 99)) {
    throw repoError("unsupported", "binary calibration suite member position must be 0-99");
  }
}

export function validateClaimInput(workerId: string, claimTtlMs: number): void {
  if (!workerId || workerId.length > 256 || !Number.isSafeInteger(claimTtlMs) ||
      claimTtlMs < 1_000 || claimTtlMs > 15 * 60_000) {
    throw repoError("unsupported", "binary calibration claim requires a worker id and a 1s-15m TTL");
  }
}

export function validateAttemptCompletion(input: CompleteBinaryCalibrationAttemptInput): void {
  const result = input.result;
  if (result.state === "failure" && !EvaluatorFailureKindSchema.safeParse(result.failureKind).success) {
    throw repoError("unsupported", "unknown binary calibration failure kind");
  }
  if (result.state === "outcome" && !["pass", "fail", "abstain"].includes(result.outcome)) {
    throw repoError("unsupported", "unknown terminal evaluator outcome");
  }
  if (result.state === "failure" && result.failureKind === "outcome_unknown") {
    throw repoError("conflict", "outcome_unknown is reserved for repository crash recovery");
  }
  const expectedState = result.state === "not_attempted" ? "not_started" : "terminal";
  if (input.attemptState !== expectedState) {
    throw repoError("conflict", `${result.state} requires ${expectedState} attempt state`);
  }
  const observation = input.providerObservation;
  if ((observation.observedVersion !== null || observation.systemFingerprint !== null) &&
      observation.observedModel === null) {
    throw repoError("conflict", "observed provider version/fingerprint requires an observed model");
  }
  for (const value of [
    observation.provider,
    observation.observedModel,
    observation.observedVersion,
    observation.systemFingerprint,
    observation.upstreamProvider
  ]) {
    if (value !== null && (Array.from(value).length > 4_096 || containsLoneSurrogate(value))) {
      throw repoError("unsupported", "provider observation strings exceed the contract boundary");
    }
  }
}

export function attemptColumnsFor(result: CompleteBinaryCalibrationAttemptInput["result"]): {
  terminalEvaluatorOutcome: "evaluator_pass" | "evaluator_fail" | "abstained" | "errored" | "not_attempted";
  errorCode: BinaryCalibrationErrorCode | null;
} {
  if (result.state === "not_attempted") return { terminalEvaluatorOutcome: "not_attempted", errorCode: null };
  if (result.state === "failure") return { terminalEvaluatorOutcome: "errored", errorCode: result.failureKind };
  return {
    terminalEvaluatorOutcome: result.outcome === "pass" ? "evaluator_pass" : result.outcome === "fail" ? "evaluator_fail" : "abstained",
    errorCode: null
  };
}

export function attemptResultFromRow(row: Record<string, unknown>): CompleteBinaryCalibrationAttemptInput["result"] {
  switch (String(row.terminal_evaluator_outcome)) {
    case "evaluator_pass": return { state: "outcome", outcome: "pass" };
    case "evaluator_fail": return { state: "outcome", outcome: "fail" };
    case "abstained": return { state: "outcome", outcome: "abstain" };
    case "not_attempted": return { state: "not_attempted" };
    case "errored": return { state: "failure", failureKind: EvaluatorFailureKindSchema.parse(row.error_code) };
    default: throw repoError("state_conflict", "binary calibration attempt has no terminal accounting");
  }
}

export function requireOwner(actor: BinaryCalibrationActor): void {
  if (actor.projectRole !== "owner") {
    throw repoError("forbidden", "only a project owner may start sealed calibration");
  }
}

export function repoError(
  code: ConstructorParameters<typeof BinaryCalibrationRepositoryError>[0],
  message: string
): BinaryCalibrationRepositoryError {
  return new BinaryCalibrationRepositoryError(code, message);
}

export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 48)}`;
}

export function toIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("invalid persisted timestamp");
  return date.toISOString();
}

export function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

export function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function isString(value: string | null): value is string {
  return value !== null;
}

export function isEmptyObject(value: unknown): boolean {
  return !(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0);
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) return true;
  }
  return false;
}
