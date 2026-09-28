// Deterministic and source-faithful: compact exception rows show the first
// sentence from the recorded judge rationale, never an LLM-generated gist.
export function rationalePreview(reason: string): string {
  const trimmed = reason.trim();
  const boundary = trimmed.search(/[.!?](?:\s|$)/);
  return boundary === -1 ? trimmed : trimmed.slice(0, boundary + 1);
}

export function queueReviewUrl(
  cases: Array<{ id: string; criterionVersionId?: string | null | undefined }>,
  search = "",
  category?: string | null,
  startCaseId?: string,
): string {
  const source = new URLSearchParams(search);
  const params = new URLSearchParams();
  if (source.has("criterionId")) params.set("criterionId", source.get("criterionId")!);
  if (category) params.set("cluster", category);
  if (source.has("verdict")) params.set("verdict", source.get("verdict")!);
  if (startCaseId && cases.some((item) => item.id === startCaseId)) params.set("at", startCaseId);
  const uniqueCases = [...new Map(cases.map((item) => [item.id, item])).values()];
  // Most queues share one definition. Index overrides keep even 50 distinct
  // pins below ordinary proxy request-line limits without repeating case IDs.
  const counts = new Map<string, number>();
  for (const item of uniqueCases) if (item.criterionVersionId) counts.set(item.criterionVersionId, (counts.get(item.criterionVersionId) ?? 0) + 1);
  const commonPin = uniqueCases.every((item) => item.criterionVersionId)
    ? [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
  if (commonPin) params.set("criterionVersionId", commonPin);
  uniqueCases.forEach((item, index) => {
    params.append("caseId", item.id);
    if (item.criterionVersionId && item.criterionVersionId !== commonPin) params.set(`cv.${index}`, item.criterionVersionId);
  });
  return `/review?${params.toString()}`;
}

export function caseReviewUrl(caseId: string, category?: string | null, search = "", criterionVersionId?: string | null): string {
  return queueReviewUrl([{ id: caseId, criterionVersionId }], search, category);
}

export function selectReviewCaseIds(input: {
  explicitCaseIds?: string[];
  explicitCaseId: string | null;
  stateCaseIds: string[] | undefined;
  exceptions: Array<{ id: string; capabilityGap?: string | null | undefined }>;
  categoryFilter: string | null;
}): string[] {
  if (input.explicitCaseIds?.length) return [...new Set(input.explicitCaseIds)];
  if (input.explicitCaseId) return [input.explicitCaseId];
  if (input.stateCaseIds && input.stateCaseIds.length > 0) return input.stateCaseIds;
  return input.exceptions
    .filter((exception) => !input.categoryFilter || exception.capabilityGap === input.categoryFilter)
    .map((exception) => exception.id);
}

export function reviewCaseCriterionPin(params: URLSearchParams, caseId: string): string | undefined {
  const index = [...new Set(params.getAll("caseId"))].indexOf(caseId);
  return params.get(`criterionVersionId[${caseId}]`) || (index >= 0 ? params.get(`cv.${index}`) : null) || params.get("criterionVersionId") || undefined;
}
