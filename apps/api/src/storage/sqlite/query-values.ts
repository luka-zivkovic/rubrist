/** SQLite interprets negative LIMIT as unlimited; PostgreSQL rejects it. */
export function sqliteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Query limit must be a nonnegative safe integer');
  return value;
}
