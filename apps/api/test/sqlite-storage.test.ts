import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { migrateSqlite, openSqlite } from '@rubrist/db/sqlite';
import { storageConfig } from '../src/storage/config.js';
import { createSqliteRuntime } from '../src/storage/sqlite/runtime.js';
import { createApp } from '../src/app.js';
import { DemoRepository } from '../src/repository.js';

const dirs: string[] = [];
function temp() { const dir=mkdtempSync(`${tmpdir()}/rubrist-sqlite-storage-`); dirs.push(dir); return dir; }
afterEach(()=> { for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
const secret = 'synthetic-storage-secret-at-least-32-bytes';

describe('fixed backend selection', () => {
  it('preserves legacy PG and development demo; selects SQLite explicitly', () => {
    expect(storageConfig({})).toEqual({kind:'demo'});
    expect(storageConfig({NODE_ENV:'production',RUBRIST_STORAGE:'demo'})).toEqual({kind:'demo'});
    expect(storageConfig({DATABASE_URL:'postgres://localhost/test',BETTER_AUTH_SECRET:secret})).toEqual({kind:'postgres',url:'postgres://localhost/test'});
    expect(storageConfig({RUBRIST_STORAGE:'sqlite',RUBRIST_SQLITE_PATH:'/data/rubrist.sqlite',BETTER_AUTH_SECRET:secret})).toEqual({kind:'sqlite',path:'/data/rubrist.sqlite'});
  });
  it.each([
    {NODE_ENV:'production'}, {DATABASE_URL:''}, {RUBRIST_STORAGE:''}, {RUBRIST_STORAGE:'unknown'},
    {RUBRIST_STORAGE:'sqlite'}, {RUBRIST_STORAGE:'postgres'}, {RUBRIST_SQLITE_PATH:'/data/test'},
    {RUBRIST_STORAGE:'sqlite',RUBRIST_SQLITE_PATH:'relative.sqlite',BETTER_AUTH_SECRET:secret},
    {RUBRIST_STORAGE:'sqlite',RUBRIST_SQLITE_PATH:'/data/test'},
    {RUBRIST_STORAGE:'demo',DATABASE_URL:'postgres://localhost/test'},
    {RUBRIST_STORAGE:'sqlite',RUBRIST_SQLITE_PATH:'/data/test',DATABASE_URL:'postgres://localhost/test',BETTER_AUTH_SECRET:secret},
    {DATABASE_URL:'https://localhost/test',BETTER_AUTH_SECRET:secret},
    {DATABASE_URL:'not-a-url',BETTER_AUTH_SECRET:secret},
    {DATABASE_URL:'postgres://localhost/test',BETTER_AUTH_SECRET:' '},
  ])('rejects ambiguous/malformed persistent config %j', env => { expect(()=>storageConfig(env)).toThrow(); });
  it('refuses an incompletely composed authenticated runtime', () => {
    expect(()=>createApp(new DemoRepository(),{runtimeMode:'persistent'})).toThrow(/auth.*account/i);
  });
});

describe('SQLite migrations and connection lifecycle', () => {
  it('is durable and retryable, verifies each connection, rejects checksum drift without changing history', () => {
    const path = `${temp()}/test.sqlite`;
    const db=openSqlite(path);
    migrateSqlite(db); migrateSqlite(db);
    expect(db.prepare('SELECT count(*) n FROM rubrist_sqlite_migrations').get()?.n).toBe(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    expect(db.prepare('PRAGMA synchronous').get()?.synchronous).toBe(2);
    expect(()=>db.prepare("INSERT INTO api_keys(id,project_id,name,key_hash,key_prefix,capability,created_at) VALUES('key','absent','name','hash','prefix','judge','now')").run()).toThrow(/FOREIGN KEY/);
    db.prepare("UPDATE rubrist_sqlite_migrations SET checksum='altered'").run();
    expect(()=>migrateSqlite(db)).toThrow(/checksum/);
    expect(db.isTransaction).toBe(false);
    expect(db.prepare('SELECT checksum FROM rubrist_sqlite_migrations').get()?.checksum).toBe('altered');
    db.close();
    const second=openSqlite(path);
    expect(second.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    second.close();
  });
  it('rejects unknown databases and newer histories without erasing them', () => {
    const db=openSqlite(`${temp()}/unknown.sqlite`);
    db.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES(\'preserve\')');
    expect(()=>migrateSqlite(db)).toThrow(/Unrecognized/);
    expect(db.prepare('SELECT * FROM unrelated').get()?.value).toBe('preserve');
    db.close();
    const other=openSqlite(`${temp()}/newer.sqlite`); migrateSqlite(other);
    other.exec("INSERT INTO rubrist_sqlite_migrations VALUES('9999_future.sql','checksum','now')");
    expect(()=>migrateSqlite(other)).toThrow(/Incompatible/);
    expect(other.prepare('SELECT count(*) n FROM rubrist_sqlite_migrations').get()?.n).toBe(2);
    other.close();
  });
  it('rolls back an entire failed migration and can retry repaired unapplied SQL', () => {
    const dir=temp(); mkdirSync(`${dir}/migrations`);
    const migration=`${dir}/migrations/0001_test.sql`;
    writeFileSync(migration,'CREATE TABLE example(id TEXT); INSERT INTO absent VALUES(1);');
    const db=openSqlite(`${dir}/test.sqlite`);
    expect(()=>migrateSqlite(db,`${dir}/migrations`)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([]);
    writeFileSync(migration,'CREATE TABLE example(id TEXT);');
    migrateSqlite(db,`${dir}/migrations`);
    expect(db.prepare('SELECT count(*) n FROM rubrist_sqlite_migrations').get()?.n).toBe(1);
    db.close();
  });
  it('opens a fresh file concurrently with busy handling already installed', async () => {
    for (let attempt=0; attempt<10; attempt++) {
      const path=`${temp()}/fresh.sqlite`, signal=new SharedArrayBuffer(4);
      const workers=Array.from({length:8},()=>new Worker(`
        const {parentPort,workerData}=require('node:worker_threads');
        (async()=>{
          const {openSqlite,migrateSqlite}=await import(workerData.moduleUrl);
          parentPort.postMessage('ready');
          Atomics.wait(new Int32Array(workerData.signal),0,0);
          const db=openSqlite(workerData.path); migrateSqlite(db); db.close();
          parentPort.postMessage('done');
        })();
      `,{eval:true,workerData:{path,signal,moduleUrl:new URL('../../../packages/db/dist/sqlite.js',import.meta.url).href}}));
      const ready=workers.map(worker=>new Promise<void>((resolve,reject)=>{
        worker.once('message',()=>resolve()); worker.once('error',reject);
      }));
      const complete=workers.map(worker=>new Promise<void>((resolve,reject)=>{
        worker.on('message',message=>{if(message==='done')resolve();}); worker.once('error',reject);
      }));
      const completed=Promise.all(complete);
      void completed.catch(()=>undefined);
      try {
        await Promise.all(ready);
        Atomics.store(new Int32Array(signal),0,1); Atomics.notify(new Int32Array(signal),0);
        await completed;
      } finally { await Promise.all(workers.map(worker=>worker.terminate())); }
    }
  });
  it('serializes competing migrations from workers and keeps the HTTP event loop responsive under write contention', async () => {
    process.env.BETTER_AUTH_SECRET=secret;
    const path=`${temp()}/parallel.sqlite`;
    const runtimes=await Promise.all([createSqliteRuntime(path),createSqliteRuntime(path)]);
    try {
      const db=openSqlite(path);
      expect(db.prepare('SELECT count(*) n FROM rubrist_sqlite_migrations').get()?.n).toBe(1);
      db.exec('BEGIN IMMEDIATE');
      const write=runtimes[0]!.repository.revokeApiKey('absent','absent');
      const started=performance.now();
      await new Promise(resolve=>setTimeout(resolve,50));
      expect(performance.now()-started).toBeLessThan(1000);
      db.exec('ROLLBACK'); db.close();
      expect(await write).toBe(false);
    } finally { await Promise.all(runtimes.map(r=>r.close())); }
  });
  it('fails startup without a writable/recognized database and never substitutes demo', async () => {
    process.env.BETTER_AUTH_SECRET=secret;
    const dir=temp();
    await expect(createSqliteRuntime(`${dir}/absent/test.sqlite`)).rejects.toThrow();
    writeFileSync(`${dir}/invalid.sqlite`,'synthetic not a database');
    await expect(createSqliteRuntime(`${dir}/invalid.sqlite`)).rejects.toThrow();
    expect(readFileSync(`${dir}/invalid.sqlite`,'utf8')).toBe('synthetic not a database');
  });
});
