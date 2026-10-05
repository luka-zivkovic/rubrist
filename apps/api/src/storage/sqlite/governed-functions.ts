import type { DatabaseSync } from 'node:sqlite';
import { canonicalGovernedJsonV1, governedContentV1Digest } from '../../lib/governed-content-digest.js';

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
    value => canonicalGovernedJsonV1(JSON.parse(text(value))));
  db.function('governed_content_v1_digest', { deterministic: true },
    (kind, content) => governedContentV1Digest(text(kind), JSON.parse(text(content))));
  db.function('governed_utf16_sort_key_v1', { deterministic: true },
    value => governedUtf16SortKey(text(value)));
  initialized.add(db);
}
