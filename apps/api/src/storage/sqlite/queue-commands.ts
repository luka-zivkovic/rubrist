import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { QueueJobState, QueueName, QueueSendOptions } from '@rubrist/queue';
import type { SqliteDelivery } from '@rubrist/queue/sqlite';

// The clock is injectable only for deterministic tests of persisted deadlines.
export function sqliteQueueCommands(db: DatabaseSync, clock = Date.now) {
  function transaction<T>(work: (now: number) => T): T {
    if (db.isTransaction) throw new Error('Nested SQLite queue command');
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(clock()); db.exec('COMMIT'); return result; }
    catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  function integer(value: number, name: string, min: number): number {
    if (!Number.isSafeInteger(value) || value < min || value > 2_147_483_647) throw new Error(`Invalid queue ${name}`);
    return value;
  }
  function fail(row: Record<string, any>, now: number, error: string): void {
    const retry = Number(row.retry_count) < Number(row.retry_limit);
    const delay = Number(row.retry_delay_ms) * (row.retry_backoff ? 2 ** Math.min(Number(row.retry_count), 16) : 1);
    db.prepare(`UPDATE queue_jobs SET state=?,retry_count=retry_count+?,available_at=?,token=NULL,lease_until=NULL,
      finished_at=?,error=? WHERE name=? AND id=? AND state='active' AND token=?`).run(
      retry ? 'retry' : 'failed', retry ? 1 : 0, now + Math.min(delay, 2_147_483_647),
      retry ? null : now, error.slice(0, 4096), row.name, row.id, row.token);
  }
  function recover(name: QueueName, now: number): void {
    const expired = db.prepare("SELECT * FROM queue_jobs WHERE name=? AND state='active' AND lease_until<=? ORDER BY lease_until,id LIMIT 100").all(name,now);
    for (const row of expired) fail(row,now,'Queue delivery lease expired');
  }
  return {
    queueRecover(name: QueueName, localTokens: string[]): string[] {
      return transaction(now => {
        recover(name,now);
        return localTokens.filter(token => !db.prepare("SELECT 1 FROM queue_jobs WHERE name=? AND token=? AND state='active' AND lease_until>?").get(name,token,now));
      });
    },
    queueSend(name: QueueName, data: object, options: QueueSendOptions = {}): string | null {
      const id = options.id ?? randomUUID();
      if (typeof id !== 'string' || !id.length) throw new Error('Invalid queue id');
      const retryLimit = integer(options.retryLimit ?? 2, 'retryLimit', 0);
      const retryDelay = integer(options.retryDelay ?? (options.retryBackoff ? 1 : 0), 'retryDelay', 0);
      const expiry = integer(options.expireInSeconds ?? 900, 'expireInSeconds', 1);
      const singleton = options.singletonSeconds === undefined ? null : integer(options.singletonSeconds, 'singletonSeconds', 1);
      if (data === null || typeof data !== 'object' || Array.isArray(data) ||
          ![Object.prototype,null].includes(Object.getPrototypeOf(data))) throw new Error('Queue data must be a JSON object');
      const json = JSON.stringify(data);
      const encoded = json === undefined ? undefined : JSON.parse(json);
      if (encoded === null || typeof encoded !== 'object' || Array.isArray(encoded)) throw new Error('Queue data must be a JSON object');
      return transaction(now => {
        const result = db.prepare(`INSERT INTO queue_jobs(name,id,data,created_at,available_at,retry_limit,retry_delay_ms,
          retry_backoff,expire_ms,singleton_key,singleton_slot) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).run(
          name, id, json, now, now, retryLimit, (options.retryBackoff ? Math.max(1,retryDelay) : retryDelay) * 1000, options.retryBackoff ? 1 : 0, expiry * 1000,
          options.singletonKey ?? '', singleton === null ? null : Math.floor(now / (singleton * 1000)) * singleton * 1000);
        return result.changes ? id : null;
      });
    },
    queueState(name: QueueName, id: string): QueueJobState | null {
      return db.prepare('SELECT state FROM queue_jobs WHERE name=? AND id=?').get(name,id)?.state as QueueJobState ?? null;
    },
    queueClaim(name: QueueName): SqliteDelivery | null {
      return transaction(now => {
        // Bounded recovery work keeps one queue from monopolizing the writer.
        recover(name,now);
        const row = db.prepare(`SELECT * FROM queue_jobs WHERE name=? AND state IN ('created','retry')
          AND available_at<=? ORDER BY available_at,created_at,id LIMIT 1`).get(name,now);
        if (!row) return null;
        const token = randomUUID();
        db.prepare("UPDATE queue_jobs SET state='active',token=?,lease_until=? WHERE name=? AND id=?").run(token,now+Number(row.expire_ms),name,row.id!);
        return {id:String(row.id),data:JSON.parse(String(row.data)),retryCount:Number(row.retry_count),retryLimit:Number(row.retry_limit),token};
      });
    },
    queueSettle(name: QueueName, id: string, token: string, error: string | null): boolean {
      return transaction(now => {
        const row = db.prepare("SELECT * FROM queue_jobs WHERE name=? AND id=? AND state='active' AND token=? AND lease_until>?").get(name,id,token,now);
        if (!row) return false;
        if (error !== null) fail(row,now,error);
        else db.prepare("UPDATE queue_jobs SET state='completed',token=NULL,lease_until=NULL,finished_at=?,error=NULL WHERE name=? AND id=?").run(now,name,id);
        return true;
      });
    }
  };
}
