// Milestone 0 only. Never imported by application startup or migration code.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function openPrototype(path, { initialize = false, clock = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=50;');
  if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) throw new Error('foreign keys required');
  let context = null;
  db.function('bytes_sha256', { deterministic: true }, digest);
  db.function('command_token', () => {
    if (!context) throw new Error('managed transaction required');
    return context.token;
  });
  db.function('command_time', () => {
    if (!context) throw new Error('managed transaction required');
    return context.time;
  });
  db.function('clock_ms', () => clock());
  if (initialize) db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return {
    db,
    transaction(fn) {
      if (context || db.isTransaction) throw new Error('nested transaction forbidden');
      // Reject async callbacks before they can open a transaction or dispatch work.
      if (fn.constructor.name === 'AsyncFunction') throw new Error('synchronous commands only');
      db.exec('BEGIN IMMEDIATE');
      context = { token: randomUUID(), time: clock() };
      try {
        const value = fn(db, context);
        if (value && typeof value.then === 'function') throw new Error('synchronous commands only');
        db.exec('COMMIT');
        return value;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      } finally {
        context = null;
      }
    },
    close() { db.close(); }
  };
}
