import { createHash } from "node:crypto";

/** Stable governed artifact identity, shared by storage backends. */
export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 48)}`;
}

export const ALLOWED_LABELS = ["pass", "fail", "cannot_determine"] as const;

export const MAX_BLIND_VIEW_BYTES = 2 * 1024 * 1024;

export function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

export function taskEventContent(input: {
  actorRoleAtReview: string | null;
  actorSubjectId: string | null;
  eventKind: string;
  taskId: string;
  sequence: number;
  previousEventDigest: string | null;
  labelId?: string | null;
  reason?: string | null;
  canonicalViewBytesBase64?: string | null;
  viewDigest?: string | null;
  viewContractVersion?: string | null;
  canonicalizationVersion?: string | null;
  exposureClass?: string | null;
  activity?: string | null;
}) {
  return {
    activity: input.activity ?? null,
    actorRoleAtReview: input.actorRoleAtReview,
    actorSubjectId: input.actorSubjectId,
    canonicalizationVersion: input.canonicalizationVersion ?? null,
    eventKind: input.eventKind,
    exposureClass: input.exposureClass ?? null,
    labelId: input.labelId ?? null,
    reason: input.reason ?? null,
    canonicalViewBytesBase64: input.canonicalViewBytesBase64 ?? null,
    previousEventDigest: input.previousEventDigest,
    sequence: input.sequence,
    stateVersion: input.sequence,
    taskId: input.taskId,
    viewContractVersion: input.viewContractVersion ?? null,
    viewDigest: input.viewDigest ?? null
  };
}

export const COVERED_CAPABILITIES = [
  "criterion_authoring", "instruction_authoring", "evaluator_authoring",
  "rubric_authoring", "prompt_authoring", "example_selection", "development_exposure"
] as const;
