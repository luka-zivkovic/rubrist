import { createHash } from "node:crypto";
import {
  EVALUATOR_SUITE_MANIFEST_CONTRACT,
  EvaluatorSuiteManifestSchema,
  type CreateEvaluatorSuiteManifestInput,
  type EvaluatorIdentity,
  type EvaluatorSuiteManifest,
  type EvaluatorSuiteManifestMember,
  type EvaluatorSuiteTrialPlan,
  type SkillVersion
} from "@rubrist/shared";
import { canonicalJson, sha256Digest } from "./canonical-json.js";
import { criterionVersionDigest } from "./criterion-digest.js";
import { evaluatorIdentityFor, evaluatorOutputContractDigest, skillDigestOf } from "./evaluator-identity.js";

// Evaluator suite manifest (Rubrist ADR-0014 section 7;
// contracts/evaluator-suite-manifest-v1.md). Members carry the skillDigest
// and output-contract digest of each evaluator's identity.

export interface EvaluatorSuiteCriterionInput {
  criterionId: string;
  criterionVersionId: string;
  criterionName: string;
  criterionDefinition: string;
}

export interface EvaluatorSuiteManifestMemberInput extends EvaluatorSuiteCriterionInput {
  skillId: string;
  skillVersionId: string;
  identity: EvaluatorIdentity;
}

export interface BuildEvaluatorSuiteManifestInput {
  manifestId: string;
  suiteId: string;
  projectId: string;
  revision: number;
  members: EvaluatorSuiteManifestMemberInput[];
  trialPlan: EvaluatorSuiteTrialPlan | null;
}

export interface ExpectedEvaluatorSuiteManifest {
  manifestId: string;
  manifestDigest: string;
  members: EvaluatorSuiteManifestMember[];
}

export function evaluatorSuiteCriterionDigest(input: EvaluatorSuiteCriterionInput): string {
  return criterionVersionDigest(input);
}

export function evaluatorSuiteManifestDigest(
  manifest: Omit<EvaluatorSuiteManifest, "manifestDigest"> | EvaluatorSuiteManifest
): string {
  const { manifestDigest: _excluded, ...unsigned } = manifest as EvaluatorSuiteManifest;
  return sha256Digest(unsigned);
}

/** A member's evaluator: its ids and identity, or `null` for a version without a valid identity. */
export function suiteMemberEvaluator(
  version: SkillVersion
): Pick<EvaluatorSuiteManifestMemberInput, "skillId" | "skillVersionId" | "identity"> | null {
  try {
    return { skillId: version.skillId, skillVersionId: version.id, identity: evaluatorIdentityFor(version) };
  } catch {
    return null;
  }
}

/** SHA-256 over the exact canonical manifest bytes, including manifestDigest. */
export function evaluatorSuiteArtifactDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function evaluatorSuiteCreateRequestDigest(input: CreateEvaluatorSuiteManifestInput): string {
  return sha256Digest({
    suiteId: input.suiteId ?? null,
    members: input.members.map((member) => ({
      criterionVersionId: member.criterionVersionId,
      skillVersionId: member.skillVersionId
    })),
    trialPlan: input.trialPlan
  });
}

export function buildEvaluatorSuiteManifest(input: BuildEvaluatorSuiteManifestInput): EvaluatorSuiteManifest {
  const members: EvaluatorSuiteManifestMember[] = input.members.map((member, position) => ({
    position,
    criterionId: member.criterionId,
    criterionVersionId: member.criterionVersionId,
    criterionName: member.criterionName,
    criterionDefinition: member.criterionDefinition,
    criterionDigest: evaluatorSuiteCriterionDigest(member),
    skillId: member.skillId,
    skillVersionId: member.skillVersionId,
    skillDigest: skillDigestOf(member.identity),
    outputContractDigest: evaluatorOutputContractDigest(member.identity.definition),
    applicability: { kind: "all_items" }
  }));
  const unsigned = {
    contract: EVALUATOR_SUITE_MANIFEST_CONTRACT,
    schemaVersion: 1 as const,
    manifestId: input.manifestId,
    suiteId: input.suiteId,
    projectId: input.projectId,
    revision: input.revision,
    members,
    trialPlan: input.trialPlan
  };
  return verifyEvaluatorSuiteManifest({ ...unsigned, manifestDigest: sha256Digest(unsigned) });
}

export function verifyEvaluatorSuiteManifest(
  raw: unknown,
  expected?: ExpectedEvaluatorSuiteManifest
): EvaluatorSuiteManifest {
  const manifest = EvaluatorSuiteManifestSchema.parse(raw);
  for (const [index, member] of manifest.members.entries()) {
    if (member.position !== index) {
      throw new Error(`suite manifest members are not ordered by contiguous position at index ${index}`);
    }
    if (!member.criterionName.trim() || !member.criterionDefinition.trim()) {
      throw new Error(`suite manifest criterion text must not be blank at position ${index}`);
    }
  }
  assertUnique(manifest.members.map((member) => member.criterionId), "criterionId");
  assertUnique(manifest.members.map((member) => member.criterionVersionId), "criterionVersionId");
  assertUnique(manifest.members.map((member) => member.skillVersionId), "skillVersionId");
  for (const member of manifest.members) {
    if (member.criterionDigest !== evaluatorSuiteCriterionDigest(member)) {
      throw new Error(`suite manifest criterionDigest mismatch for ${member.criterionVersionId}`);
    }
  }
  if (manifest.manifestDigest !== evaluatorSuiteManifestDigest(manifest)) {
    throw new Error("suite manifest manifestDigest mismatch");
  }
  if (expected) {
    verifyExpectedMembers(manifest, expected.members);
    if (manifest.manifestId !== expected.manifestId) {
      throw new Error(`suite manifest manifestId mismatch: expected ${expected.manifestId}`);
    }
    if (manifest.manifestDigest !== expected.manifestDigest) {
      throw new Error(`suite manifest identity digest mismatch: expected ${expected.manifestDigest}`);
    }
  }
  return manifest;
}

export function canonicalEvaluatorSuiteManifestBytes(manifest: EvaluatorSuiteManifest): Buffer {
  return Buffer.from(canonicalJson(verifyEvaluatorSuiteManifest(manifest)), "utf8");
}

export function parseCanonicalEvaluatorSuiteManifestBytes(
  bytes: Uint8Array,
  expected?: ExpectedEvaluatorSuiteManifest
): EvaluatorSuiteManifest {
  let text: string;
  try {
    // ignoreBOM keeps a leading byte-order mark, so such a copy fails the parse.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Evaluator suite manifest bytes are not valid UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Evaluator suite manifest bytes are not valid JSON");
  }
  const manifest = EvaluatorSuiteManifestSchema.parse(raw);
  if (canonicalJson(manifest) !== text) {
    throw new Error("Evaluator suite manifest copy is not exact canonical JSON");
  }
  return verifyEvaluatorSuiteManifest(manifest, expected);
}

function assertUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`suite manifest ${field} values must be unique`);
  }
}

function verifyExpectedMembers(manifest: EvaluatorSuiteManifest, expectedMembers: EvaluatorSuiteManifestMember[]): void {
  const expectedByCriterionId = new Map(expectedMembers.map((member) => [member.criterionId, member]));
  for (const member of manifest.members) {
    if (!expectedByCriterionId.has(member.criterionId)) {
      throw new Error(`suite manifest contains unknown criterion ${member.criterionId}`);
    }
  }
  if (manifest.members.length !== expectedMembers.length) {
    throw new Error("suite manifest does not have exact criterion coverage");
  }
  const candidateCriterionIds = manifest.members.map((member) => member.criterionId);
  const expectedCriterionIds = expectedMembers.map((member) => member.criterionId);
  if (candidateCriterionIds.some((id, index) => id !== expectedCriterionIds[index])) {
    throw new Error("suite manifest criterion order mismatch");
  }
  for (const [index, member] of manifest.members.entries()) {
    const expected = expectedMembers[index]!;
    if (member.criterionVersionId !== expected.criterionVersionId) {
      throw new Error(`suite manifest substituted criterion version at position ${index}`);
    }
    if (
      member.criterionName !== expected.criterionName ||
      member.criterionDefinition !== expected.criterionDefinition ||
      member.criterionDigest !== expected.criterionDigest
    ) {
      throw new Error(`suite manifest substituted criterion definition at position ${index}`);
    }
    if (
      member.skillId !== expected.skillId ||
      member.skillVersionId !== expected.skillVersionId ||
      member.skillDigest !== expected.skillDigest ||
      member.outputContractDigest !== expected.outputContractDigest
    ) {
      throw new Error(`suite manifest substituted evaluator at position ${index}`);
    }
    if (member.applicability.kind !== expected.applicability.kind) {
      throw new Error(`suite manifest substituted applicability at position ${index}`);
    }
  }
}
