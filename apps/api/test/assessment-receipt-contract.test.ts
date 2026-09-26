import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  AssessmentReceiptSchema,
  type AssessmentReceipt,
  type EvaluatorDefinition,
  type TypedQuestion
} from "@rubrist/shared";
import { canonicalJson, contentDigest, sha256Digest } from "../src/lib/canonical-json.js";
import {
  canonicalReceiptBytes,
  datasetDigestForReceiptItems,
  evidenceDigestForReceipt,
  parseCanonicalReceiptBytes,
  verifyAssessmentReceipt
} from "../src/lib/assessment-receipt.js";
import { evaluatorDefinitionDigest, skillDigestFromInput, typedQuestionDigest } from "../src/lib/evaluator-identity.js";

interface ContractFixture {
  contract: "rubrist/assessment-receipt/v1";
  definition: EvaluatorDefinition;
  question?: TypedQuestion;
  candidates: Array<{ id: string; input: unknown; output: unknown }>;
  receipt: unknown;
}

type Mutation =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "reverse"; path: string }
  | { op: "recompute-dataset-digest" }
  | { op: "recompute-skill-digest" }
  | { op: "recompute-evidence-digest" };

interface ConformanceCase {
  name: string;
  baseFixture?: string;
  structural: "accept" | "reject";
  semantic: "accept" | "reject" | "not-run";
  expectedEvalRunId?: string;
  expectedSkillVersionId?: string;
  expectedSkillDigest?: string;
  errorIncludes?: string;
  mutations: Mutation[];
}

interface ConformanceCorpus {
  contract: "rubrist/assessment-receipt/v1";
  baseFixture: string;
  cases: ConformanceCase[];
}

const contractRoot = new URL("../../../contracts/", import.meta.url);
const pinnedFileDigests = {
  schema: "3b572012a4cf6172ecee46e9de6e821a5bae431f2489ac39e85393f2fb2b5129",
  specification: "443cc16d6e0c77309182890b8476826d0049be7acc68adb2e4c1f9e9b32e7fad",
  complete: "2f5d3f00eb633da22472242c0c0a9abb2e5e7ab4e7c15bbe28dd2eae77ab20eb",
  incomplete: "23e3022bf6d31dec1954bcd890d8c6be7bc5a5c9bba807e25aa053aecbf8cc3a",
  conformance: "98924a3591381322f19c9aed9c981b78b6b233a684bb8f27dc6504f1ce363f73"
} as const;

const fileBytes = (relativePath: string) => readFileSync(new URL(relativePath, contractRoot));
const loadJson = (relativePath: string): unknown => JSON.parse(fileBytes(relativePath).toString("utf8"));
const fileDigest = (relativePath: string) => createHash("sha256").update(fileBytes(relativePath)).digest("hex");
const fixture = (name: string) => loadJson(`fixtures/${name}`) as ContractFixture;
const corpus = () => loadJson("fixtures/assessment-receipt-v1.conformance.json") as ConformanceCorpus;
const byCodeUnit = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function pointerTarget(root: unknown, pointer: string): { parent: unknown; key: string } {
  const segments = pointer.split("/").slice(1).map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.length === 0) throw new Error("fixture mutations cannot target the document root");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = Array.isArray(parent) ? parent[Number(segment)] : (parent as Record<string, unknown>)[segment];
  }
  return { parent, key: segments.at(-1)! };
}

function applyMutation(receipt: Record<string, unknown>, mutation: Mutation): void {
  if (mutation.op === "recompute-dataset-digest") {
    receipt.datasetDigest = datasetDigestForReceiptItems(receipt.items as Array<{ clientItemId: string; contentDigest: string }>);
    return;
  }
  if (mutation.op === "recompute-skill-digest") {
    receipt.skillDigest = sha256Digest(receipt.evaluator);
    return;
  }
  if (mutation.op === "recompute-evidence-digest") {
    const { evidenceDigest: _excluded, ...unsigned } = receipt;
    receipt.evidenceDigest = sha256Digest(unsigned);
    return;
  }
  const { parent, key } = pointerTarget(receipt, mutation.path);
  if (mutation.op === "reverse") {
    const value = Array.isArray(parent) ? parent[Number(key)] : (parent as Record<string, unknown>)[key];
    if (!Array.isArray(value)) throw new Error(`${mutation.path} is not an array`);
    value.reverse();
    return;
  }
  if (mutation.op === "remove") {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete (parent as Record<string, unknown>)[key];
    return;
  }
  if (Array.isArray(parent)) parent[Number(key)] = mutation.value;
  // defineProperty makes even a `__proto__` key an own key, as JSON.parse does.
  else Object.defineProperty(parent, key, { value: mutation.value, enumerable: true, writable: true, configurable: true });
}

function materialize(testCase: ConformanceCase, conformance: ConformanceCorpus): { vector: ContractFixture; raw: unknown } {
  const vector = fixture(testCase.baseFixture ?? conformance.baseFixture);
  const receipt = structuredClone(vector.receipt) as Record<string, unknown>;
  for (const mutation of testCase.mutations) applyMutation(receipt, mutation);
  return { vector, raw: receipt };
}

/** What a consumer holding the submitted candidates checks on top of the receipt's own rules. */
function verifyCandidateLinkage(receipt: AssessmentReceipt, vector: ContractFixture): void {
  const ids = receipt.items.map((item) => item.clientItemId);
  const candidates = new Map(vector.candidates.map((candidate) => [candidate.id, candidate]));
  const expectedIds = [...candidates.keys()].sort(byCodeUnit);
  if (ids.length !== expectedIds.length || ids.some((id, index) => id !== expectedIds[index])) {
    throw new Error("receipt does not have exact clientItemId coverage");
  }
  for (const item of receipt.items) {
    const candidate = candidates.get(item.clientItemId)!;
    if (item.contentDigest !== contentDigest(candidate.input, candidate.output)) {
      throw new Error(`contentDigest mismatch for ${item.clientItemId}`);
    }
  }
}

describe("assessment receipt contract (ADR-0014 section 7)", () => {
  it("pins the canonical schema, specification, and portable vectors", () => {
    expect(fileDigest("assessment-receipt-v1.schema.json")).toBe(pinnedFileDigests.schema);
    expect(fileDigest("assessment-receipt-v1.md")).toBe(pinnedFileDigests.specification);
    expect(fileDigest("fixtures/assessment-receipt-v1.complete.json")).toBe(pinnedFileDigests.complete);
    expect(fileDigest("fixtures/assessment-receipt-v1.incomplete.json")).toBe(pinnedFileDigests.incomplete);
    expect(fileDigest("fixtures/assessment-receipt-v1.conformance.json")).toBe(pinnedFileDigests.conformance);
  });

  it("keeps the canonical schema closed and versioned", () => {
    const schema = loadJson("assessment-receipt-v1.schema.json") as {
      $id?: string;
      additionalProperties?: boolean;
      properties?: { contract?: { const?: string }; schemaVersion?: { const?: number } };
    };
    expect(schema.$id).toBe("https://rubrist.dev/contracts/assessment-receipt-v1.schema.json");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.contract?.const).toBe("rubrist/assessment-receipt/v1");
    expect(schema.properties?.schemaVersion?.const).toBe(1);
  });

  it("accepts both positive vectors and recomputes every digest from the definition down", () => {
    for (const name of ["assessment-receipt-v1.complete.json", "assessment-receipt-v1.incomplete.json"]) {
      const vector = fixture(name);
      const receipt = AssessmentReceiptSchema.parse(vector.receipt);
      verifyAssessmentReceipt(receipt);
      verifyCandidateLinkage(receipt, vector);
      expect(evaluatorDefinitionDigest(vector.definition)).toBe(receipt.evaluator.definitionDigest);
      expect(skillDigestFromInput(receipt.evaluator)).toBe(receipt.skillDigest);
      expect(receipt.evidenceDigest).toBe(evidenceDigestForReceipt(receipt));
      if (vector.definition.kind === "typed-question") {
        expect(typedQuestionDigest(vector.question!)).toBe(vector.definition.question.digest);
      }
    }
  });

  it("carries no rubric, prompt, or question text", () => {
    const complete = fixture("assessment-receipt-v1.complete.json");
    const incomplete = fixture("assessment-receipt-v1.incomplete.json");
    const completeText = JSON.stringify(complete.receipt);
    const incompleteText = JSON.stringify(incomplete.receipt);
    if (complete.definition.kind !== "prompted") throw new Error("the complete vector is a prompted evaluator");
    expect(completeText).not.toContain(complete.definition.rubricMarkdown);
    expect(completeText).not.toContain(complete.definition.prompt);
    expect(incompleteText).not.toContain(incomplete.question!.instructions);
    expect(incompleteText).not.toContain(incomplete.question!.criteria.true);
  });

  it("maps each typed-question probability through the vector's threshold", () => {
    const vector = fixture("assessment-receipt-v1.incomplete.json");
    if (vector.definition.kind !== "typed-question") throw new Error("the incomplete vector is a typed-question evaluator");
    const { threshold } = vector.definition;
    const receipt = AssessmentReceiptSchema.parse(vector.receipt);
    for (const item of receipt.items) {
      if (item.result.state !== "outcome") continue;
      expect(item.evaluatorScore!.value >= threshold, item.clientItemId).toBe(item.result.outcome === "pass");
    }
  });

  it("refuses lone surrogates anywhere, which JSON Schema can't express", () => {
    const receipt = structuredClone(fixture("assessment-receipt-v1.complete.json").receipt) as Record<string, unknown>;
    for (const [path, value] of [["/receiptId", "\ud800"], ["/items/0/verdictId", "\udc00"], ["/items/0/observed/model", "claude\ud800"]] as const) {
      const copy = structuredClone(receipt);
      applyMutation(copy, { op: "replace", path, value });
      applyMutation(copy, { op: "recompute-evidence-digest" });
      expect(AssessmentReceiptSchema.safeParse(copy).success, path).toBe(false);
    }
  });

  it("fails validation, rather than throwing, on hostile nesting", () => {
    let payload: unknown = "leaf";
    for (let depth = 0; depth < 5_000; depth += 1) payload = [payload];
    const deep = { ...structuredClone(fixture("assessment-receipt-v1.complete.json").receipt as object), unexpected: payload };
    expect(() => AssessmentReceiptSchema.safeParse(deep)).not.toThrow();
    expect(AssessmentReceiptSchema.safeParse(deep).success).toBe(false);
  });

  it("treats an abstention as an outcome: complete, with lower coverage", () => {
    const receipt = AssessmentReceiptSchema.parse(fixture("assessment-receipt-v1.complete.json").receipt);
    expect(receipt.status).toBe("complete");
    expect(receipt.run.abstainedItems).toBe(1);
    expect((receipt.run.passItems + receipt.run.failItems) / receipt.run.totalItems).toBeLessThan(1);
  });

  it("round-trips exact canonical bytes and refuses any other copy", () => {
    const receipt = AssessmentReceiptSchema.parse(fixture("assessment-receipt-v1.incomplete.json").receipt);
    const bytes = canonicalReceiptBytes(receipt);
    expect(bytes.toString("utf8")).toBe(canonicalJson(receipt));
    expect(parseCanonicalReceiptBytes(bytes)).toEqual(receipt);
    expect(() => parseCanonicalReceiptBytes(Buffer.from(JSON.stringify(receipt, null, 2)))).toThrow("not exact canonical JSON");
    expect(() => parseCanonicalReceiptBytes(bytes, { skillDigest: `sha256:${"0".repeat(64)}` })).toThrow("expected evaluator");
    expect(() => parseCanonicalReceiptBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]))).toThrow("not valid JSON");
    expect(() => parseCanonicalReceiptBytes(Buffer.concat([bytes.subarray(0, 10), Buffer.from([0xff]), bytes.subarray(10)]))).toThrow("not valid UTF-8");
  });

  it("keeps JSON Schema and producer Zod acceptance aligned over the portable corpus", () => {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(loadJson("assessment-receipt-v1.schema.json") as object);
    const conformance = corpus();
    for (const testCase of conformance.cases) {
      const { raw } = materialize(testCase, conformance);
      const expected = testCase.structural === "accept";
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(expected);
      expect(AssessmentReceiptSchema.safeParse(raw).success, `Zod: ${testCase.name}`).toBe(expected);
    }
  });

  it("accepts or rejects every portable semantic case for the stated reason", () => {
    const conformance = corpus();
    for (const testCase of conformance.cases.filter((entry) => entry.semantic !== "not-run")) {
      const { vector, raw } = materialize(testCase, conformance);
      const receipt = AssessmentReceiptSchema.parse(raw);
      const verify = () => {
        verifyAssessmentReceipt(receipt, {
          evalRunId: testCase.expectedEvalRunId,
          skillVersionId: testCase.expectedSkillVersionId,
          skillDigest: testCase.expectedSkillDigest
        });
        verifyCandidateLinkage(receipt, vector);
      };
      if (testCase.semantic === "accept") {
        expect(verify, testCase.name).not.toThrow();
      } else {
        expect(testCase.errorIncludes, `${testCase.name} states its reason`).toBeTruthy();
        expect(verify, testCase.name).toThrow(testCase.errorIncludes);
      }
    }
  });
});
