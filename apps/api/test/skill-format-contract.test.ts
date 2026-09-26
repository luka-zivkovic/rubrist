import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { SkillFormatSchema, type SkillFormat } from "@rubrist/shared";
import {
  endpointBaseUrlDigest,
  evaluatorDefinitionDigest,
  evaluatorOutputContractDigest,
  skillDigestOf,
  typedQuestionDigest
} from "../src/lib/evaluator-identity.js";
import { buildSkillFormat, verifySkillFormat } from "../src/lib/skill-format.js";
import { BINDINGS, DEFINITIONS, QUESTION } from "./fixtures/evaluator-vectors.js";

type Mutation =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "recompute-question-digest" }
  | { op: "recompute-digests" };

interface ConformanceCase {
  name: string;
  baseFixture?: string;
  structural: "accept" | "reject";
  semantic: "accept" | "reject" | "not-run";
  errorIncludes?: string;
  expectedSkillDigest?: string;
  mutations: Mutation[];
}

interface ConformanceCorpus {
  contract: "skill-format/v1";
  baseFixture: string;
  cases: ConformanceCase[];
}

const contractRoot = new URL("../../../contracts/", import.meta.url);
const pinnedFileDigests = {
  schema: "34b853ae374873e051904544a17c1d5b739bd8eb0a08b0b9f869f57508d6cbbe",
  specification: "1560cd6a73cbbd522cca4056427f557bc370aa4a5221754386cc14e9d90c110b",
  prompted: "46b5faeb6a8a9ac4247342ae1e9a05e154dbb0e608f6db73d63801d1169d5089",
  typedQuestion: "7ba9e6c2b55b1f2148054ea91abf7fa933a398393dc6ba1ea1737776c93be4ca",
  conformance: "3ddefb9db4989e7dbd067ba4421334b93eedff852e4ec84a5ccdfa912bd49c07"
} as const;

const fileBytes = (relativePath: string) => readFileSync(new URL(relativePath, contractRoot));
const loadJson = (relativePath: string): unknown => JSON.parse(fileBytes(relativePath).toString("utf8"));
const fileDigest = (relativePath: string) => createHash("sha256").update(fileBytes(relativePath)).digest("hex");
const fixture = (name: string) => loadJson(`fixtures/${name}`) as SkillFormat;
const corpus = () => loadJson("fixtures/skill-format-v1.conformance.json") as ConformanceCorpus;

function pointerTarget(root: unknown, pointer: string): { parent: unknown; key: string } {
  const segments = pointer.split("/").slice(1).map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.length === 0) throw new Error("fixture mutations cannot target the document root");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = Array.isArray(parent) ? parent[Number(segment)] : (parent as Record<string, unknown>)[segment];
  }
  return { parent, key: segments.at(-1)! };
}

function applyMutation(doc: Record<string, any>, mutation: Mutation): void {
  if (mutation.op === "recompute-question-digest") {
    doc.evaluator.identity.definition.question.digest = typedQuestionDigest(doc.evaluator.question);
    return;
  }
  if (mutation.op === "recompute-digests") {
    const identity = doc.evaluator.identity;
    doc.digests = {
      definitionDigest: evaluatorDefinitionDigest(identity.definition),
      skillDigest: skillDigestOf(identity),
      outputContractDigest: evaluatorOutputContractDigest(identity.definition)
    };
    return;
  }
  const { parent, key } = pointerTarget(doc, mutation.path);
  if (mutation.op === "remove") {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete (parent as Record<string, unknown>)[key];
    return;
  }
  if (Array.isArray(parent)) parent[Number(key)] = mutation.value;
  // defineProperty makes even a `__proto__` key an own key, as JSON.parse does.
  else Object.defineProperty(parent, key, { value: structuredClone(mutation.value), enumerable: true, writable: true, configurable: true });
}

function materialize(testCase: ConformanceCase, conformance: ConformanceCorpus): unknown {
  const doc = structuredClone(fixture(testCase.baseFixture ?? conformance.baseFixture)) as Record<string, any>;
  for (const mutation of testCase.mutations) applyMutation(doc, mutation);
  return doc;
}

describe("skill-format contract (ADR-0014 section 7)", () => {
  it("pins the schema, specification, and portable vectors", () => {
    expect(fileDigest("skill-format-v1.schema.json")).toBe(pinnedFileDigests.schema);
    expect(fileDigest("skill-format-v1.md")).toBe(pinnedFileDigests.specification);
    expect(fileDigest("fixtures/skill-format-v1.prompted.json")).toBe(pinnedFileDigests.prompted);
    expect(fileDigest("fixtures/skill-format-v1.typed-question.json")).toBe(pinnedFileDigests.typedQuestion);
    expect(fileDigest("fixtures/skill-format-v1.conformance.json")).toBe(pinnedFileDigests.conformance);
  });

  it("carries the full definition, binding, and question text, with digests an importer recomputes", () => {
    const prompted = verifySkillFormat(fixture("skill-format-v1.prompted.json"));
    expect(prompted.evaluator.identity.definition).toEqual(DEFINITIONS.prompted);
    expect(prompted.evaluator.identity.executionBinding).toEqual(BINDINGS.sonnet);
    expect(prompted.evaluator.question).toBeNull();
    const typed = verifySkillFormat(fixture("skill-format-v1.typed-question.json"));
    expect(typed.evaluator.question).toEqual(QUESTION);
    expect(typedQuestionDigest(typed.evaluator.question!)).toBe(DEFINITIONS.typedQuestion.question.digest);
    // The same evaluator has the same identity in every contract.
    const manifest = loadJson("fixtures/evaluator-suite-manifest-v1.complete.json") as { members: Array<{ skillDigest: string }> };
    expect(manifest.members.map((member) => member.skillDigest)).toEqual([prompted.digests.skillDigest, typed.digests.skillDigest]);
  });

  it("keeps JSON Schema and Zod acceptance aligned over the portable corpus", () => {
    const schema = loadJson("skill-format-v1.schema.json") as { $id?: string; additionalProperties?: boolean };
    expect(schema.$id).toBe("https://rubrist.dev/contracts/skill-format-v1.schema.json");
    expect(schema.additionalProperties).toBe(false);
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);
    const conformance = corpus();
    for (const testCase of conformance.cases) {
      const raw = materialize(testCase, conformance);
      const expected = testCase.structural === "accept";
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(expected);
      expect(SkillFormatSchema.safeParse(raw).success, `Zod: ${testCase.name}`).toBe(expected);
    }
  });

  it("accepts or rejects every semantic case for the stated reason", () => {
    const conformance = corpus();
    for (const testCase of conformance.cases.filter((entry) => entry.semantic !== "not-run")) {
      const raw = materialize(testCase, conformance);
      const verify = () => verifySkillFormat(raw, { skillDigest: testCase.expectedSkillDigest });
      if (testCase.semantic === "accept") {
        expect(verify, testCase.name).not.toThrow();
      } else {
        expect(testCase.errorIncludes, `${testCase.name} states its reason`).toBeTruthy();
        expect(verify, testCase.name).toThrow(testCase.errorIncludes);
      }
    }
  });

  it("rebuilds both vectors exactly from their evaluator and metadata", () => {
    for (const name of ["skill-format-v1.prompted.json", "skill-format-v1.typed-question.json"]) {
      const doc = fixture(name);
      expect(buildSkillFormat({
        name: doc.name, description: doc.description, owner: doc.owner, version: doc.version, status: doc.status,
        identity: doc.evaluator.identity, question: doc.evaluator.question, examples: doc.examples, notes: doc.notes
      }), name).toEqual(doc);
    }
  });

  it("uses the receipt's execution-binding rules, byte for byte", () => {
    const skillFormat = loadJson("skill-format-v1.schema.json") as { $defs: Record<string, unknown> };
    const receipt = loadJson("assessment-receipt-v1.schema.json") as { $defs: Record<string, unknown> };
    expect(skillFormat.$defs.executionBinding).toEqual(receipt.$defs.executionBinding);
    expect(skillFormat.$defs.reasoning).toEqual(receipt.$defs.reasoning);
  });

  it("withholds a custom endpoint's URL and lets the importer check the one it supplies", () => {
    const baseUrl = "https://llm.internal.example/v1";
    const custom = buildSkillFormat({
      ...fixture("skill-format-v1.prompted.json"),
      identity: {
        ...fixture("skill-format-v1.prompted.json").evaluator.identity,
        executionBinding: { ...BINDINGS.openaiOverride, endpoint: { kind: "custom", baseUrlDigest: endpointBaseUrlDigest(baseUrl) } }
      },
      question: null
    });
    expect(JSON.stringify(custom)).not.toContain(baseUrl);
    expect(verifySkillFormat(custom, { endpointBaseUrl: baseUrl })).toEqual(custom);
    expect(() => verifySkillFormat(custom, { endpointBaseUrl: `${baseUrl}/` })).toThrow("does not match the binding's baseUrlDigest");
    expect(() => verifySkillFormat(fixture("skill-format-v1.prompted.json"), { endpointBaseUrl: baseUrl })).toThrow("baseUrlDigest");
    expect(endpointBaseUrlDigest(baseUrl)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("accepts nesting to depth 64 and refuses depth 65, counting the root as 0", () => {
    // The example payload sits at depth 3 (root → examples → example → input).
    const nestedTo = (depth: number) => {
      const doc = structuredClone(fixture("skill-format-v1.prompted.json")) as Record<string, any>;
      let payload: unknown = [];
      for (let level = 3; level < depth; level += 1) payload = [payload];
      doc.examples[0].input = payload;
      return doc;
    };
    expect(SkillFormatSchema.safeParse(nestedTo(64)).success).toBe(true);
    expect(SkillFormatSchema.safeParse(nestedTo(65)).success).toBe(false);
  });

  it("fails validation, rather than throwing, on a payload nested past the depth limit", () => {
    const deep = structuredClone(fixture("skill-format-v1.prompted.json")) as Record<string, any>;
    let payload: unknown = "leaf";
    for (let depth = 0; depth < 5_000; depth += 1) payload = [payload];
    deep.examples[0].input = payload;
    expect(() => SkillFormatSchema.safeParse(deep)).not.toThrow();
    expect(SkillFormatSchema.safeParse(deep).success).toBe(false);
    const infinite = structuredClone(fixture("skill-format-v1.prompted.json")) as Record<string, any>;
    infinite.examples[0].input = JSON.parse('{"n": 1e400}');
    expect(SkillFormatSchema.safeParse(infinite).success).toBe(false);
  });

  it("checks what JSON Schema can't express: ascending ranges, lone surrogates, and nested __proto__ keys", () => {
    const base = structuredClone(fixture("skill-format-v1.prompted.json")) as Record<string, any>;
    const descending = structuredClone(base);
    descending.evaluator.identity.definition.verdictKind = "scalar";
    descending.evaluator.identity.definition.scalarRange = [5, 1];
    expect(SkillFormatSchema.safeParse(descending).success).toBe(false);
    const surrogate = structuredClone(base);
    surrogate.examples[0].reason = "safe\ud800";
    expect(SkillFormatSchema.safeParse(surrogate).success).toBe(false);
    const nestedProto = structuredClone(base);
    nestedProto.examples[0].input = JSON.parse('{"question":"hi","__proto__":{"x":1}}');
    expect(SkillFormatSchema.safeParse(nestedProto).success).toBe(false);
    const protoScore = structuredClone(base);
    protoScore.evaluator.identity.definition.verdictKind = "categorical";
    protoScore.evaluator.identity.definition.categoricalChoiceScores = JSON.parse('{"good":1,"__proto__":0.5}');
    expect(SkillFormatSchema.safeParse(protoScore).success).toBe(false);
  });
});
