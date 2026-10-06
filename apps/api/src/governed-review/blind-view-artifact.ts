import { canonicalJson } from '../lib/canonical-json.js';
import { GovernedReviewConflictError } from './errors.js';
import { assertBlindProjectionSafe } from './projection.js';
import type { GovernedBlindTaskViewArtifact } from './repository.js';
import { ALLOWED_LABELS,MAX_BLIND_VIEW_BYTES,parseJson,sha256Bytes } from './storage-values.js';

export function buildBlindTaskViewArtifact(row: Record<string, unknown>): GovernedBlindTaskViewArtifact {
  const payloadSnapshot = parseJson(row.review_payload_snapshot);
  assertBlindProjectionSafe(payloadSnapshot);
  const view = {
    contract: "rubrist/governed-blind-task-view/v1",
    schemaVersion: 1,
    canonicalizationVersion: "rubrist-canonical-json/v1",
    taskId: String(row.task_id ?? row.id),
    batchId: String(row.batch_id),
    servePosition: Number(row.serve_order),
    criterion: {
      criterionId: String(row.criterion_id),
      criterionVersionId: String(row.criterion_version_id),
      name: String(row.criterion_name),
      definition: String(row.criterion_definition),
      criterionDigest: String(row.criterion_digest)
    },
    instruction: {
      instructionVersionId: String(row.instruction_version_id),
      title: String(row.title),
      instructions: String(row.instructions),
      failureCodeGuidance: String(row.failure_code_guidance),
      allowedLabels: ALLOWED_LABELS,
      instructionDigest: String(row.instruction_digest)
    },
    payloadSnapshot
  };
  const canonicalBytes = Buffer.from(canonicalJson(view), "utf8");
  if (canonicalBytes.byteLength > MAX_BLIND_VIEW_BYTES) {
    throw new GovernedReviewConflictError(
      "governed_review_transition_conflict",
      "The immutable blind view exceeds the governed 2 MiB boundary"
    );
  }
  return { canonicalBytes, viewDigest: sha256Bytes(canonicalBytes) };
}
