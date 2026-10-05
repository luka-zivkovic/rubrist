import { DatabaseSync, constants } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function openSqlite(path: string): DatabaseSync {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major! < 24 || (major === 24 && minor! < 15)) throw new Error('SQLite storage requires Node 24.15 or newer');
  const deadline = performance.now() + 5000;
  const delay = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { timeout: Math.max(1, Math.ceil(deadline - performance.now())) });
      if (path !== ':memory:') chmodSync(path, 0o600);
      db.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      for (const [setting,value] of [['foreign_keys',1],['recursive_triggers',1],['synchronous',2]] as const) {
        if (db.prepare(`PRAGMA ${setting}`).get()?.[setting] !== value) throw new Error(`SQLite requires ${setting}=${value}`);
      }
      if (path !== ':memory:' && db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal') throw new Error('SQLite requires WAL');
      db.exec('PRAGMA busy_timeout=5000');
      return db;
    } catch (error) {
      // WAL lock upgrades can return BUSY immediately despite busy_timeout.
      // Release partial connection locks before retrying a competing startup.
      try { db?.close(); } catch { /* Keep the original startup error. */ }
      const code = (error as {errcode?: number}).errcode;
      const remaining = deadline - performance.now();
      if (code === undefined || ![5,6].includes(code & 0xff) || remaining <= 0) throw error;
      Atomics.wait(delay, 0, 0, Math.min(25, remaining));
    }
  }
}

export function migrateSqlite(db: DatabaseSync, directory = fileURLToPath(new URL('../sqlite-migrations/', import.meta.url))): void {
  const files = readdirSync(directory).filter(f => f.endsWith('.sql')).sort();
  if (!files.length || files.some((f,i) => !f.startsWith(`${String(i+1).padStart(4,'0')}_`))) throw new Error('Invalid SQLite migration sequence');
  if (db.isTransaction) throw new Error('SQLite migrations require an idle migration connection');
  // A table rebuild must suppress FK cascade actions during DROP TABLE. This
  // connection never serves application work; every FK is checked before
  // commit, and enforcement is restored on success and on rollback.
  try {
    db.exec('PRAGMA foreign_keys=OFF');
    if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 0) throw new Error('Cannot prepare SQLite migration connection');
    db.exec('BEGIN IMMEDIATE');
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'").all();
    if (tables.length && !tables.some(t => t.name === 'rubrist_sqlite_migrations')) throw new Error('Unrecognized SQLite database; refusing initialization');
    db.exec('CREATE TABLE IF NOT EXISTS rubrist_sqlite_migrations (id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
    const applied = db.prepare('SELECT id,checksum FROM rubrist_sqlite_migrations ORDER BY id').all();
    for (const [i,row] of applied.entries()) {
      if (row.id !== files[i]) throw new Error('Incompatible SQLite migration history; preserve this database');
    }
    for (const [i,file] of files.entries()) {
      const sql = readFileSync(`${directory}/${file}`, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (applied[i]) {
        if (applied[i]!.checksum !== checksum) throw new Error(`SQLite migration checksum mismatch: ${file}`);
      } else {
        // Only this runner may end the transaction. Checking isTransaction
        // after execution would be too late to undo an accidental COMMIT.
        db.setAuthorizer(action => action === constants.SQLITE_TRANSACTION || action === constants.SQLITE_SAVEPOINT
          ? constants.SQLITE_DENY : constants.SQLITE_OK);
        try { db.exec(sql); } finally { db.setAuthorizer(null); }
        db.prepare('INSERT INTO rubrist_sqlite_migrations VALUES(?,?,?)').run(file,checksum,new Date().toISOString());
      }
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite foreign-key integrity check failed');
    if (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB '*__new'").all().length) throw new Error('SQLite migration left unfinished replacement tables');
    if (db.prepare("SELECT name FROM temp.sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all().length) throw new Error('SQLite migration left temporary objects');
    db.exec('COMMIT');
  } catch(error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  finally {
    try {
      db.exec('PRAGMA foreign_keys=ON');
      if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('Cannot restore SQLite foreign-key enforcement');
    } catch(error) { try { db.close(); } catch { /* Preserve restoration failure. */ } throw error; }
  }
}
