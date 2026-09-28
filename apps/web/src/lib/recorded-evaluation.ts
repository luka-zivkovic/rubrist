import { TypedQuestionSchema, type ExceptionDetail } from "@rubrist/shared";

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

// This is a projection of the recorded call only. Never substitute the current
// evaluator definition or infer probability semantics from the provider name.
export function recordedTypedEvaluation(detail: ExceptionDetail) {
  const request = object(detail.rawRequest);
  const prompt = object(request?.prompt);
  if (request?.provider !== "typesafe" || prompt?.id !== detail.judgeRun.skillVersionId || typeof prompt.content !== "string") return null;
  let value: unknown;
  try { value = JSON.parse(prompt.content); } catch { return null; }
  const parsed = TypedQuestionSchema.safeParse(value);
  if (!parsed.success) return null;
  const result = object(detail.rawResponse);
  const probability = result?.probability;
  const threshold = result?.threshold;
  const valid = result?.kind === "typed-question" && result.rationaleStatus === "not_provided"
    && typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1
    && typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
    && probability === detail.judgeRun.score
    && result.label === detail.judgeRun.verdict
    && result.label === (probability >= threshold ? "pass" : "fail");
  return { question: parsed.data, probability: valid ? probability : null, threshold: valid ? threshold : null };
}

export function recordedVersionName(detail: ExceptionDetail): string | null {
  const prompt = object(object(detail.rawRequest)?.prompt);
  return prompt?.id === detail.judgeRun.skillVersionId && typeof prompt.name === "string" && prompt.name.trim()
    ? prompt.name : null;
}

// Recognize only the complete evidence/claim shape. Unknown extra fields keep
// the generic payload view so they cannot silently disappear from the review.
export function evidenceClaim(input: unknown, output: unknown) {
  const source = object(input);
  const response = object(output);
  if (!source || !response || typeof response.claim !== "string"
    || Object.keys(response).some((key) => key !== "claim")
    || Object.keys(source).some((key) => key !== "evidence" && key !== "claim_context_for_reference_resolution_only")
    || !Array.isArray(source.evidence) || !source.evidence.every((part): part is string => typeof part === "string")) return null;
  const context = source.claim_context_for_reference_resolution_only;
  if (context !== undefined && typeof context !== "string") return null;
  return { claim: response.claim, evidence: source.evidence, context };
}
