import { describe, expect, it } from "vitest";
import type { ExceptionDetail } from "@rubrist/shared";
import { recordedTypedEvaluation, recordedVersionName, evidenceClaim } from "../src/lib/recorded-evaluation.js";

const recorded = {
  judgeRun: { skillVersionId: "version_old", score: 0.3, verdict: "pass" },
  rawRequest: { provider: "typesafe", prompt: { id: "version_old", name: "1.2.3", content: JSON.stringify({ type: "noul", instructions: "Is the answer supported?", criteria: { true: "All supported", false: "Unsupported" } }) } },
  rawResponse: { kind: "typed-question", probability: 0.3, threshold: 0.3, label: "pass", rationaleStatus: "not_provided" }
} as ExceptionDetail;

describe("recorded evaluation presentation", () => {
  it("honors the inclusive threshold and preserves a probability of zero", () => {
    expect(recordedTypedEvaluation(recorded)).toMatchObject({ probability: 0.3, threshold: 0.3 });
    expect(recordedTypedEvaluation({ ...recorded, judgeRun: { ...recorded.judgeRun, score: 0, verdict: "fail" }, rawResponse: { ...recorded.rawResponse as object, probability: 0, label: "fail" } }))
      .toMatchObject({ probability: 0, threshold: 0.3 });
    expect(recordedVersionName(recorded)).toBe("1.2.3");
  });

  it("does not attribute a question or version label from a different saved evaluator", () => {
    const wrong = { ...recorded, judgeRun: { ...recorded.judgeRun, skillVersionId: "version_new" } };
    expect(recordedTypedEvaluation(wrong)).toBeNull();
    expect(recordedVersionName(wrong)).toBeNull();
  });

  it.each([
    { probability: 0.7 }, { threshold: null }, { threshold: 0.5 },
    { label: "fail" }, { probability: 1.1 }, { kind: "other" }
  ])("does not invent probability semantics for an inconsistent recorded result %j", (change) => {
    const result = recordedTypedEvaluation({ ...recorded, rawResponse: { ...recorded.rawResponse as object, ...change } });
    expect(result?.question.instructions).toBe("Is the answer supported?");
    expect(result?.probability).toBeNull();
    expect(result?.threshold).toBeNull();
  });

  it("keeps unknown input/output fields and malformed evidence on the generic path", () => {
    expect(evidenceClaim({ evidence: [{ text: "Nested evidence" }] }, { claim: "Claim" })).toBeNull();
    expect(evidenceClaim({ evidence: ["Evidence"] }, { claim: "Claim", caveat: "Important" })).toBeNull();
    expect(evidenceClaim({ evidence: ["Evidence"], more: "Important" }, { claim: "Claim" })).toBeNull();
  });
});
