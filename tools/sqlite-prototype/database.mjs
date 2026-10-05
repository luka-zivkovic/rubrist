// Milestone 0 only. Never imported by application startup or migration code.
import { DatabaseSync, constants } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function openPrototype(path, { initialize = false, clock = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=50;');
  if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) throw new Error('foreign keys required');
  let context = null;
  let callbackActive = false;
  const authorize = action => callbackActive && action === constants.SQLITE_TRANSACTION
    ? constants.SQLITE_DENY : constants.SQLITE_OK;
  // Bind every SQL operation to one command, including cached statements.
  // SQLite can implicitly roll back (e.g. INSERT OR ROLLBACK) without a
  // SQLITE_TRANSACTION authorization event; no later write may autocommit.
  function commandFor(owner) {
    const assertOwned = () => {
      if (!callbackActive || context !== owner || !db.isTransaction) {
        throw new Error('managed transaction ownership lost');
      }
    };
    return Object.freeze({
      exec(sql) { assertOwned(); return db.exec(sql); },
      prepare(sql) {
        assertOwned();
        const statement = db.prepare(sql);
        return Object.freeze(Object.fromEntries(['run', 'get', 'all'].map(method =>
          [method, (...args) => { assertOwned(); return statement[method](...args); }])));
      }
    });
  }
  db.function('bytes_sha256', { deterministic: true }, digest);
  db.function('command_token', () => {
    if (!context || !db.isTransaction) throw new Error('managed transaction required');
    return context.token;
  });
  db.function('command_time', () => {
    if (!context || !db.isTransaction) throw new Error('managed transaction required');
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
      try {
        db.exec('BEGIN IMMEDIATE');
        context = { token: randomUUID(), time: clock() };
        // Resetting the authorizer also invalidates statements prepared before
        // the managed command, so a cached COMMIT cannot escape this boundary.
        db.setAuthorizer(authorize);
        callbackActive = true;
        const value = fn(commandFor(context));
        if (value && typeof value.then === 'function') throw new Error('synchronous commands only');
        callbackActive = false;
        db.exec('COMMIT');
        return value;
      } catch (error) {
        callbackActive = false;
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      } finally {
        context = null;
      }
    },
    close() { db.close(); }
  };
}
