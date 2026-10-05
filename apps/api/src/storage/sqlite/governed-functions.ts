import { projectGovernedReviewPayload } from '../../governed-review/projection.js';
import { governedTimestamp } from './governed-timestamp.js';
import { createHash } from 'node:crypto';
import { postgresJsonTextOctets, canonicalGovernedJsonText, analysisPayloadSnapshotText, governedJsonTextDigest, analysisJsonTextDigest } from './governed-json-text.js';
import { productionTimestamp } from './production-time.js';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeAnalysisPopulationTimestamp } from '../../lib/analysis-population.js';
import { canonicalGovernedJsonV1 } from '../../lib/governed-content-digest.js';

const initialized = new WeakSet<DatabaseSync>();

/** SQLite compares this big-endian BLOB in the evidence contract's UTF-16 order. */
export function governedUtf16SortKey(value: string): Buffer {
  // Match the persisted PostgreSQL text domain before producing the key.
  canonicalGovernedJsonV1(value);
  const bytes = Buffer.alloc(value.length * 2);
  for (let index = 0; index < value.length; index++) bytes.writeUInt16BE(value.charCodeAt(index), index * 2);
  return bytes;
}

/** Pure validators live in triggers, leaving maintenance reads independent of UDFs. */
export function initializeGovernedSqliteFunctions(db: DatabaseSync): void {
  if (initialized.has(db)) return;
  const text = (value: unknown): string => {
    if (typeof value !== 'string') throw new Error('Governed SQL function requires text');
    return value;
  };
  db.function('governed_canonical_json_v1', { deterministic: true },
    value => canonicalGovernedJsonText(text(value)));
  db.function('governed_content_v1_digest', { deterministic: true },
    (kind, content) => governedJsonTextDigest(text(kind), text(content)));
  db.function('governed_utf16_sort_key_v1', { deterministic: true },
    value => governedUtf16SortKey(text(value)));
  db.function('analysis_sha256_v1', { deterministic: true },
    value => analysisJsonTextDigest(text(value)));
  db.function('analysis_timestamp_v1', { deterministic: true },
    value => normalizeAnalysisPopulationTimestamp(productionTimestamp(text(value))));
  db.function('analysis_payload_snapshot_v1', { deterministic: true }, value => analysisPayloadSnapshotText(text(value)));
  db.function('analysis_trimmed_text_v1', { deterministic: true }, (value,limit) =>
    typeof value==='string' && value.length>0 && value===value.trim() && [...value].length<=Number(limit) ? 1 : 0);
  db.function('governed_review_payload_project_v1', { deterministic: true }, value => JSON.stringify(projectGovernedReviewPayload(JSON.parse(text(value)))));
  db.function('governed_timestamp_v1', { deterministic: true }, value => governedTimestamp(text(value)));
  db.function('governed_jsonb_octets_v1', { deterministic: true }, value => value===null ? 0 : postgresJsonTextOctets(text(value)));
  db.function('governed_bytes_v1_digest', { deterministic: true }, value => {
    if(!(value instanceof Uint8Array))throw new Error('Governed bytes require BLOB');
    return 'sha256:'+createHash('sha256').update(value).digest('hex');
  });
  initialized.add(db);
}
