import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { EvaluatorSuiteManifestSchema, type EvaluatorSuiteManifest, type SkillVersion } from "@rubrist/shared";
import { canonicalJson } from "../src/lib/canonical-json.js";
import { evaluatorOutputContractDigest, skillDigestOf } from "../src/lib/evaluator-identity.js";
import {
  buildEvaluatorSuiteManifest,
  canonicalEvaluatorSuiteManifestBytes,
  evaluatorSuiteCriterionDigest,
  evaluatorSuiteManifestDigest,
  parseCanonicalEvaluatorSuiteManifestBytes,
  suiteMemberEvaluator,
  verifyEvaluatorSuiteManifest,
  type ExpectedEvaluatorSuiteManifest
} from "../src/lib/evaluator-suite-manifest.js";
import { BINDINGS, DEFINITIONS } from "./fixtures/evaluator-vectors.js";
import { SEEDED_BINDING } from "./fixtures/execution-binding.js";

type Mutation =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "reverse"; path: string }
  | { op: "reindex-members" }
  | { op: "recompute-criterion-digests" }
  | { op: "recompute-manifest-digest" };

interface ConformanceCase {
  name: string;
  structural: "accept" | "reject";
  semantic: "accept" | "reject" | "not-run";
  errorIncludes?: string;
  mutations: Mutation[];
}

interface ConformanceCorpus {
  contract: "rubrist/evaluator-suite-manifest/v1";
  baseFixture: string;
  cases: ConformanceCase[];
}

const contractRoot = new URL("../../../contracts/", import.meta.url);
const pinnedFileDigests = {
  schema: "1c2dbb52ba90acdb6dba1292a5ac7e44ee6f516e9c699178ab4ed1aa74727c19",
  specification: "c665c3ff1cdd453b55250ee889baa093d82743bc2e2ca30b6e4663ca85272ace",
  fixture: "148d3f745ec0b7abddf82056fda65701e354de931d961012dd64288215bb5dc7",
  conformance: "073c99f0157080b201be35cb378a350c6d935e71e5fa4e750a7de67ecb06ccba"
} as const;

const fileBytes = (relativePath: string) => readFileSync(new URL(relativePath, contractRoot));
const loadJson = (relativePath: string): unknown => JSON.parse(fileBytes(relativePath).toString("utf8"));
const fileDigest = (relativePath: string) => createHash("sha256").update(fileBytes(relativePath)).digest("hex");
const fixture = () => loadJson("fixtures/evaluator-suite-manifest-v1.complete.json") as EvaluatorSuiteManifest;
const corpus = () => loadJson("fixtures/evaluator-suite-manifest-v1.conformance.json") as ConformanceCorpus;
const BASIS = "rubrist/evaluator-identity/v1" as const;
const PROMPTED = { basis: BASIS, definition: DEFINITIONS.prompted, executionBinding: BINDINGS.sonnet };
const TYPED = { basis: BASIS, definition: DEFINITIONS.typedQuestion, executionBinding: BINDINGS.jev };

function expectedFrom(manifest: EvaluatorSuiteManifest): ExpectedEvaluatorSuiteManifest {
  return { manifestId: manifest.manifestId, manifestDigest: manifest.manifestDigest, members: structuredClone(manifest.members) };
}

function pointerTarget(root: unknown, pointer: string): { parent: unknown; key: string } {
  const segments = pointer.split("/").slice(1).map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.length === 0) throw new Error("fixture mutations cannot target the document root");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = Array.isArray(parent) ? parent[Number(segment)] : (parent as Record<string, unknown>)[segment];
  }
  return { parent, key: segments.at(-1)! };
}

function applyMutation(manifest: Record<string, unknown>, mutation: Mutation): void {
  if (mutation.op === "reindex-members") {
    (manifest.members as Array<Record<string, unknown>>).forEach((member, index) => { member.position = index; });
    return;
  }
  if (mutation.op === "recompute-criterion-digests") {
    (manifest.members as Array<Record<string, unknown>>).forEach((member) => {
      member.criterionDigest = evaluatorSuiteCriterionDigest(member as unknown as EvaluatorSuiteManifest["members"][number]);
    });
    return;
  }
  if (mutation.op === "recompute-manifest-digest") {
    manifest.manifestDigest = evaluatorSuiteManifestDigest(manifest as unknown as EvaluatorSuiteManifest);
    return;
  }
  const { parent, key } = pointerTarget(manifest, mutation.path);
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

function materialize(base: EvaluatorSuiteManifest, testCase: ConformanceCase): unknown {
  const manifest = structuredClone(base) as unknown as Record<string, unknown>;
  for (const mutation of testCase.mutations) applyMutation(manifest, mutation);
  return manifest;
}

describe("evaluator suite manifest contract (ADR-0014 section 7)", () => {
  it("pins the canonical schema, specification, and portable corpus bytes", () => {
    expect(fileDigest("evaluator-suite-manifest-v1.schema.json")).toBe(pinnedFileDigests.schema);
    expect(fileDigest("evaluator-suite-manifest-v1.md")).toBe(pinnedFileDigests.specification);
    expect(fileDigest("fixtures/evaluator-suite-manifest-v1.complete.json")).toBe(pinnedFileDigests.fixture);
    expect(fileDigest("fixtures/evaluator-suite-manifest-v1.conformance.json")).toBe(pinnedFileDigests.conformance);
  });

  it("binds each member to the skillDigest and output-contract digest of its evaluator", () => {
    const manifest = verifyEvaluatorSuiteManifest(fixture());
    const identities = [PROMPTED, TYPED];
    manifest.members.forEach((member, index) => {
      expect(member.skillDigest).toBe(skillDigestOf(identities[index]!));
      expect(member.outputContractDigest).toBe(evaluatorOutputContractDigest(identities[index]!.definition));
    });
  });

  it("keeps the JSON Schema closed and aligned with the strict Zod schema", () => {
    const schema = loadJson("evaluator-suite-manifest-v1.schema.json") as {
      $id?: string; additionalProperties?: boolean; properties?: { contract?: { const?: string }; schemaVersion?: { const?: number } };
    };
    expect(schema.$id).toBe("https://rubrist.dev/contracts/evaluator-suite-manifest-v1.schema.json");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.contract?.const).toBe("rubrist/evaluator-suite-manifest/v1");
    expect(schema.properties?.schemaVersion?.const).toBe(1);
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);
    const conformance = corpus();
    const base = loadJson(`fixtures/${conformance.baseFixture}`) as EvaluatorSuiteManifest;
    for (const testCase of conformance.cases) {
      const raw = materialize(base, testCase);
      const expected = testCase.structural === "accept";
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(expected);
      expect(EvaluatorSuiteManifestSchema.safeParse(raw).success, `Zod: ${testCase.name}`).toBe(expected);
    }
  });

  it("accepts or rejects every semantic conformance case for the stated reason", () => {
    const conformance = corpus();
    const base = loadJson(`fixtures/${conformance.baseFixture}`) as EvaluatorSuiteManifest;
    const expected = expectedFrom(base);
    for (const testCase of conformance.cases.filter((entry) => entry.semantic !== "not-run")) {
      const raw = materialize(base, testCase);
      const verify = () => verifyEvaluatorSuiteManifest(raw, expected);
      if (testCase.semantic === "accept") {
        expect(verify, testCase.name).not.toThrow();
      } else {
        expect(testCase.errorIncludes, `${testCase.name} states its reason`).toBeTruthy();
        expect(verify, testCase.name).toThrow(testCase.errorIncludes);
      }
    }
  });

  it("rejects release-policy vocabulary instead of silently dropping it", () => {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(loadJson("evaluator-suite-manifest-v1.schema.json") as object);
    for (const field of ["weight", "threshold", "mandatory", "advisory", "blocking", "compensatory", "compositeScore", "releaseDecision", "rollout", "override"]) {
      const rootCandidate = { ...structuredClone(fixture()), [field]: true };
      expect(validate(rootCandidate), `JSON Schema root: ${field}`).toBe(false);
      expect(EvaluatorSuiteManifestSchema.safeParse(rootCandidate).success, `Zod root: ${field}`).toBe(false);
      const memberCandidate = structuredClone(fixture()) as EvaluatorSuiteManifest & { members: Array<Record<string, unknown>> };
      memberCandidate.members[0]![field] = true;
      expect(validate(memberCandidate), `JSON Schema member: ${field}`).toBe(false);
      expect(EvaluatorSuiteManifestSchema.safeParse(memberCandidate).success, `Zod member: ${field}`).toBe(false);
    }
  });

  it("builds deterministic manifests and treats a closed trial plan as identity", () => {
    const members = [
      { criterionId: "criterion_a", criterionVersionId: "criterionv_a_1", criterionName: "Criterion A",
        criterionDefinition: "Judge criterion A independently.", skillId: "skill_a", skillVersionId: "skillv_a_1", identity: PROMPTED },
      { criterionId: "criterion_b", criterionVersionId: "criterionv_b_1", criterionName: "Criterion B",
        criterionDefinition: "Judge criterion B independently.", skillId: "skill_b", skillVersionId: "skillv_b_1", identity: TYPED }
    ];
    const baseInput = { manifestId: "manifest_1", suiteId: "suite_1", projectId: "project_1", revision: 1, members };
    const single = buildEvaluatorSuiteManifest({ ...baseInput, trialPlan: null });
    const repeated = buildEvaluatorSuiteManifest({ ...baseInput, manifestId: "manifest_2", revision: 2,
      trialPlan: { kind: "independent_repetitions", trialsPerItem: 3 } });
    expect(buildEvaluatorSuiteManifest({ ...baseInput, trialPlan: null })).toEqual(single);
    expect(single.members.map((member) => member.position)).toEqual([0, 1]);
    expect(repeated.manifestDigest).not.toBe(single.manifestDigest);
  });

  it("serves and parses only exact canonical UTF-8 bytes", () => {
    const manifest = verifyEvaluatorSuiteManifest(fixture());
    const bytes = canonicalEvaluatorSuiteManifestBytes(manifest);
    expect(bytes.toString("utf8")).toBe(canonicalJson(manifest));
    expect(parseCanonicalEvaluatorSuiteManifestBytes(bytes)).toEqual(manifest);
    expect(() => parseCanonicalEvaluatorSuiteManifestBytes(fileBytes("fixtures/evaluator-suite-manifest-v1.complete.json")))
      .toThrow("not exact canonical JSON");
    expect(() => parseCanonicalEvaluatorSuiteManifestBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])))
      .toThrow("not valid JSON");
    expect(() => parseCanonicalEvaluatorSuiteManifestBytes(Uint8Array.from([0xff]))).toThrow("not valid UTF-8");
  });

  it("fails validation, rather than throwing, on hostile nesting", () => {
    let payload: unknown = "leaf";
    for (let depth = 0; depth < 5_000; depth += 1) payload = [payload];
    const deep = { ...structuredClone(fixture()), unexpected: payload };
    expect(() => EvaluatorSuiteManifestSchema.safeParse(deep)).not.toThrow();
    expect(EvaluatorSuiteManifestSchema.safeParse(deep).success).toBe(false);
  });

  it("refuses lone surrogates anywhere, which JSON Schema can't express", () => {
    const candidate = structuredClone(fixture());
    candidate.members[0]!.criterionName = "Factual\ud800";
    expect(EvaluatorSuiteManifestSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("suite member evaluators", () => {
  const version = {
    id: "skv_member", skillId: "skill_member", rubricMarkdown: "Pass grounded answers.", prompt: "Judge {{rubric_markdown}}.",
    typedQuestion: null, decisionThreshold: null,
    verdictKind: "binary", outputSchema: { type: "object" }, scalarRange: null, categoricalChoiceScores: null,
    executionBinding: SEEDED_BINDING
  } as unknown as SkillVersion;

  it("names a member by its version's identity, and refuses a version without one", () => {
    const member = suiteMemberEvaluator(version);
    expect(member).toMatchObject({ skillId: "skill_member", skillVersionId: "skv_member", identity: { executionBinding: SEEDED_BINDING } });
    expect(suiteMemberEvaluator({ ...version, rubricMarkdown: "x".repeat(100_001) } as SkillVersion)).toBeNull();
    expect(suiteMemberEvaluator({
      ...version,
      executionBinding: { ...SEEDED_BINDING, provider: "typesafe", verdictProtocol: "typed-question/v1", sampling: { temperature: null, topP: null }, reasoning: null, outputTokenLimit: null }
    } as SkillVersion)).toBeNull();
  });
});
