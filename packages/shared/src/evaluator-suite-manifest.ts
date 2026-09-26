import { z } from "zod";
import { EvaluatorSuiteApplicabilitySchema, EvaluatorSuiteTrialPlanSchema } from "./criterion-governance.js";
import { containsLoneUtf16Surrogate, containsOwnProtoKey, exceedsJsonDepth } from "./judge.js";

// Evaluator suite manifest (Rubrist ADR-0014 section 7). Each member names its
// evaluator by `skillDigest`, over the evaluator identity, and by the
// `outputContractDigest` of its definition.

export const EVALUATOR_SUITE_MANIFEST_CONTRACT = "rubrist/evaluator-suite-manifest/v1" as const;

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const IdentifierSchema = z.string().min(1);

export const EvaluatorSuiteManifestMemberSchema = z.object({
  position: z.number().int().nonnegative(),
  criterionId: IdentifierSchema,
  criterionVersionId: IdentifierSchema,
  criterionName: IdentifierSchema,
  criterionDefinition: IdentifierSchema,
  criterionDigest: Sha256DigestSchema,
  skillId: IdentifierSchema,
  skillVersionId: IdentifierSchema,
  skillDigest: Sha256DigestSchema,
  outputContractDigest: Sha256DigestSchema,
  applicability: EvaluatorSuiteApplicabilitySchema
}).strict();
export type EvaluatorSuiteManifestMember = z.infer<typeof EvaluatorSuiteManifestMemberSchema>;

const EvaluatorSuiteManifestObjectSchema = z.object({
  contract: z.literal(EVALUATOR_SUITE_MANIFEST_CONTRACT),
  schemaVersion: z.literal(1),
  manifestId: IdentifierSchema,
  suiteId: IdentifierSchema,
  projectId: IdentifierSchema,
  revision: z.number().int().positive(),
  members: z.array(EvaluatorSuiteManifestMemberSchema).min(1),
  trialPlan: EvaluatorSuiteTrialPlanSchema.nullable(),
  manifestDigest: Sha256DigestSchema
}).strict();

/** The raw document is checked first: no `__proto__` key and no lone surrogate anywhere. */
export const EvaluatorSuiteManifestSchema = z.unknown().superRefine((raw, ctx) => {
  if (exceedsJsonDepth(raw)) {
    ctx.addIssue({ code: "custom", message: "suite manifests must not nest deeper than 64 levels" });
    return;
  }
  if (containsOwnProtoKey(raw)) {
    ctx.addIssue({ code: "custom", message: "suite manifests must not contain a __proto__ key" });
  }
  if (containsLoneUtf16Surrogate(raw)) {
    ctx.addIssue({ code: "custom", message: "suite manifests must not contain lone UTF-16 surrogates" });
  }
}).pipe(EvaluatorSuiteManifestObjectSchema);
export type EvaluatorSuiteManifest = z.infer<typeof EvaluatorSuiteManifestSchema>;
