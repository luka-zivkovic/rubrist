import {
  SKILL_FORMAT,
  SkillFormatSchema,
  type EvaluatorIdentity,
  type SkillFormat,
  type SkillFormatExample,
  type SkillStatus,
  type TypedQuestion
} from "@rubrist/shared";
import {
  endpointBaseUrlDigest,
  evaluatorDefinitionDigest,
  evaluatorOutputContractDigest,
  skillDigestOf,
  typedQuestionDigest
} from "./evaluator-identity.js";

// skill-format/v1 (contracts/skill-format-v1.md): the portable export of one
// evaluator version, built and verified here.

export interface BuildSkillFormatInput {
  name: string;
  description: string;
  owner: string;
  version: string;
  status: SkillStatus;
  identity: EvaluatorIdentity;
  question: TypedQuestion | null;
  examples: SkillFormatExample[];
  notes: string[];
}

export function buildSkillFormat(input: BuildSkillFormatInput): SkillFormat {
  return verifySkillFormat({
    formatVersion: SKILL_FORMAT,
    name: input.name,
    description: input.description,
    owner: input.owner,
    version: input.version,
    status: input.status,
    evaluator: { identity: input.identity, question: input.question },
    digests: {
      definitionDigest: evaluatorDefinitionDigest(input.identity.definition),
      skillDigest: skillDigestOf(input.identity),
      outputContractDigest: evaluatorOutputContractDigest(input.identity.definition)
    },
    examples: input.examples,
    notes: input.notes
  });
}

/**
 * Parse a skill-format/v1 document and recompute every digest it states, so an
 * importer accepts exactly the evaluator identity the exporter had.
 */
export interface SkillFormatExpectations {
  /** The evaluator identity the importer expected, such as a suite manifest member's. */
  skillDigest?: string | undefined;
  /** For a custom endpoint, the base URL the importer supplies; the export withholds it. */
  endpointBaseUrl?: string | undefined;
}

export function verifySkillFormat(raw: unknown, expected: SkillFormatExpectations = {}): SkillFormat {
  const doc = SkillFormatSchema.parse(raw);
  const { identity, question } = doc.evaluator;
  if (question !== null && identity.definition.kind === "typed-question" &&
      typedQuestionDigest(question) !== identity.definition.question.digest) {
    throw new Error("skill-format question text does not match the definition's question digest");
  }
  if (doc.digests.definitionDigest !== evaluatorDefinitionDigest(identity.definition)) {
    throw new Error("skill-format definitionDigest does not match its definition");
  }
  if (doc.digests.skillDigest !== skillDigestOf(identity)) {
    throw new Error("skill-format skillDigest does not match its evaluator identity");
  }
  if (doc.digests.outputContractDigest !== evaluatorOutputContractDigest(identity.definition)) {
    throw new Error("skill-format outputContractDigest does not match its definition");
  }
  if (expected.skillDigest !== undefined && doc.digests.skillDigest !== expected.skillDigest) {
    throw new Error(`skill-format evaluator does not match the expected skillDigest ${expected.skillDigest}`);
  }
  if (expected.endpointBaseUrl !== undefined) {
    const endpoint = identity.executionBinding.endpoint;
    if (endpoint.kind !== "custom" || endpointBaseUrlDigest(expected.endpointBaseUrl) !== endpoint.baseUrlDigest) {
      throw new Error("skill-format endpoint base URL does not match the binding's baseUrlDigest");
    }
  }
  return doc;
}
