import { createHash, randomUUID } from 'node:crypto';
import { PRODUCTION_CALIBRATION_CONTRACT, PRODUCTION_DECISION_RECORD_CONTRACT, type ProductionDecisionLedgerRecord } from '@rubrist/shared';
import { governedContentV1Digest } from '../lib/governed-content-digest.js';
import { PRODUCTION_RECORD_MAX_BYTES, PRODUCTION_SNAPSHOT_MAX_BYTES, ProductionRecordRepositoryError, type ProductionRecordDeletionCounts, type ProductionCalibrationSnapshotSummary } from './repository.js';

export interface PreparedRecord {
  id: string;
  /** One-based position in the submitted batch. */
  line: number;
  kind: ProductionDecisionLedgerRecord["kind"];
  decision_id: string;
  record_at: string;
  content: ProductionDecisionLedgerRecord;
  content_digest: string;
}

export function prepareRecords(records: readonly ProductionDecisionLedgerRecord[]): PreparedRecord[] {
  const byDigest = new Map<string, PreparedRecord>();
  const decisionDigests = new Map<string, { digest: string; line: number }>();
  records.forEach((record, index) => {
    const line = index + 1;
    // PostgreSQL stores the JSON text, so digest exactly what a JSON round trip keeps.
    const json = JSON.stringify(record);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > PRODUCTION_RECORD_MAX_BYTES) {
      throw new ProductionRecordRepositoryError(
        "record_too_large",
        `Record ${line} is ${bytes} bytes; a record may be at most ${PRODUCTION_RECORD_MAX_BYTES} bytes`,
        { line, bytes, maximum: PRODUCTION_RECORD_MAX_BYTES }
      );
    }
    const content = JSON.parse(json) as ProductionDecisionLedgerRecord;
    let contentDigest: string;
    try {
      contentDigest = governedContentV1Digest(PRODUCTION_DECISION_RECORD_CONTRACT, content);
    } catch (error) {
      throw new ProductionRecordRepositoryError(
        "invalid_record",
        `Record ${line} cannot be stored: ${error instanceof Error ? error.message : String(error)}`,
        { line }
      );
    }
    const decisionId = content.kind === "decision" ? content.id : content.decisionId;
    if (content.kind === "decision") {
      const seen = decisionDigests.get(decisionId);
      if (seen && seen.digest !== contentDigest) {
        throw new ProductionRecordRepositoryError(
          "conflicting_decision",
          `Records ${seen.line} and ${line} give decision ${decisionId} different contents`,
          { decisionId, line }
        );
      }
      decisionDigests.set(decisionId, { digest: contentDigest, line });
    }
    if (byDigest.has(contentDigest)) return;
    byDigest.set(contentDigest, {
      id: `pdr_${randomUUID()}`,
      line,
      kind: content.kind,
      decision_id: decisionId,
      record_at: content.at,
      content,
      content_digest: contentDigest
    });
  });
  const order = (row: PreparedRecord) => row.kind === "decision" ? row.decision_id : row.content_digest;
  return [...byDigest.values()].sort((left, right) =>
    Number(right.kind === "decision") - Number(left.kind === "decision") ||
    (order(left) < order(right) ? -1 : order(left) > order(right) ? 1 : 0));
}

export function textDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function deletionCounts(rows: ReadonlyArray<{ kind: string }>): ProductionRecordDeletionCounts {
  const counts = { decisions: 0, actions: 0, outcomes: 0 };
  for (const row of rows) {
    if (row.kind === "decision") counts.decisions += 1;
    else if (row.kind === "action") counts.actions += 1;
    else counts.outcomes += 1;
  }
  return counts;
}

export function bytesDigest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function iso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

export function snapshotSummary(row: Record<string, unknown>): ProductionCalibrationSnapshotSummary {
  if (row.report_contract !== PRODUCTION_CALIBRATION_CONTRACT) {
    throw new Error(`Unsupported production calibration snapshot contract ${String(row.report_contract)}`);
  }
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    reportContract: String(row.report_contract),
    artifactDigest: String(row.artifact_digest),
    window: {
      from: row.window_from === null ? null : iso(row.window_from),
      to: row.window_to === null ? null : iso(row.window_to)
    },
    parameters: row.parameters as Record<string, unknown>,
    recordCount: Number(row.record_count),
    recordSetDigest: String(row.record_set_digest),
    builtAt: iso(row.built_at),
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at)
  };
}

export function snapshotTooLarge(bytes: number | null): ProductionRecordRepositoryError {
  return new ProductionRecordRepositoryError(
    "snapshot_too_large",
    `The report is larger than a snapshot may be (${PRODUCTION_SNAPSHOT_MAX_BYTES} bytes); choose a narrower window`,
    { bytes, maximum: PRODUCTION_SNAPSHOT_MAX_BYTES }
  );
}
