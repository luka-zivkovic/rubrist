import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite, migrateSqlite } from '@rubrist/db/sqlite';
import { SqliteQueue, type SqliteQueueStore } from '@rubrist/queue/sqlite';
import { sqliteQueueCommands } from '../src/storage/sqlite/queue-commands.js';
import { SqliteStorage } from '../src/storage/sqlite/client.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(),'rubrist-queue-'));
  cleanup.push(() => rmSync(dir,{recursive:true,force:true}));
  const path = join(dir,'db.sqlite');
  const db = openSqlite(path); migrateSqlite(db);
  cleanup.push(() => db.close());
  let now = 1_000_000;
  const commands = sqliteQueueCommands(db, () => now);
  return { path, db, commands, advance: (ms: number) => { now += ms; }, now: () => now };
}
function store(commands: ReturnType<typeof sqliteQueueCommands>): SqliteQueueStore {
  return {
    send: async (...args) => commands.queueSend(...args), state: async (...args) => commands.queueState(...args),
    recover: async (...args) => commands.queueRecover(...args),
    claim: async (...args) => commands.queueClaim(...args), settle: async (...args) => commands.queueSettle(...args)
  };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve=r; }); return {promise,resolve}; }

describe('durable SQLite queue', () => {
  it('retains stable IDs, JSON and singleton slots across connections, including after completion', () => {
    const f = fixture();
    expect(f.commands.queueSend('eval.item',{text:'a\u0000😀',nested:{empty:null}},{id:'stable'})).toBe('stable');
    expect(f.commands.queueSend('eval.item',{different:true},{id:'stable'})).toBeNull();
    const second = openSqlite(f.path); cleanup.push(() => second.close());
    const peer = sqliteQueueCommands(second,f.now);
    const job = peer.queueClaim('eval.item')!;
    expect(job.data).toEqual({text:'a\u0000😀',nested:{empty:null}});
    expect(f.commands.queueClaim('eval.item')).toBeNull();
    expect(f.commands.queueSettle('eval.item',job.id,job.token,null)).toBe(true);
    expect(peer.queueState('eval.item',job.id)).toBe('completed');
    expect(peer.queueSend('eval.item',{}, {id:'stable'})).toBeNull();
    expect(peer.queueSend('eval.run',{}, {id:'stable'})).toBe('stable');
    expect(peer.queueSend('feedback.sync',{}, {singletonKey:'same',singletonSeconds:30})).toBeTypeOf('string');
    expect(peer.queueSend('feedback.sync',{}, {singletonKey:'same',singletonSeconds:30})).toBeNull();
    f.advance(30_000);
    expect(peer.queueSend('feedback.sync',{}, {singletonKey:'same',singletonSeconds:30})).toBeTypeOf('string');
    expect(peer.queueState('eval.run','absent')).toBeNull();
  });
  it('consumes bounded retries, persists exponential deadlines, and never revives exhausted jobs', () => {
    const f=fixture(), q=f.commands;
    q.queueSend('eval.item',{}, {id:'retry',retryLimit:2,retryDelay:2,retryBackoff:true});
    for (const [count,delay] of [[0,2000],[1,4000]] as const) {
      const job=q.queueClaim('eval.item')!;
      expect(job.retryCount).toBe(count);
      expect(q.queueSettle('eval.item',job.id,job.token,'transient')).toBe(true);
      expect(q.queueState('eval.item','retry')).toBe('retry');
      f.advance(delay-1); expect(q.queueClaim('eval.item')).toBeNull(); f.advance(1);
    }
    const last=q.queueClaim('eval.item')!;
    expect(last.retryCount).toBe(last.retryLimit);
    expect(q.queueSettle('eval.item',last.id,last.token,'exhausted')).toBe(true);
    expect(q.queueState('eval.item','retry')).toBe('failed');
    f.advance(1_000_000); expect(q.queueClaim('eval.item')).toBeNull();
    expect(q.queueSettle('eval.item',last.id,last.token,null)).toBe(false);
  });
  it('recovers expired deliveries, fences both late success and late failure, expires the final attempt', () => {
    const f=fixture(), q=f.commands;
    q.queueSend('eval.item',{}, {id:'lease',retryLimit:1,expireInSeconds:1});
    const old=q.queueClaim('eval.item')!;
    f.advance(1000);
    expect(q.queueSettle('eval.item',old.id,old.token,null)).toBe(false);
    const replacement=q.queueClaim('eval.item')!;
    expect(replacement.retryCount).toBe(1); expect(replacement.token).not.toBe(old.token);
    expect(q.queueSettle('eval.item',old.id,old.token,'late failure')).toBe(false);
    expect(q.queueState('eval.item',old.id)).toBe('active');
    f.advance(1000); expect(q.queueClaim('eval.item')).toBeNull();
    expect(q.queueState('eval.item',old.id)).toBe('failed');
  });
  it('rejects invalid policy/input and direct mutation of job identity and terminal state', () => {
    const {commands:q,db}=fixture();
    for (const options of [{retryLimit:-1},{retryDelay:NaN},{expireInSeconds:0},{singletonSeconds:0}]) {
      expect(()=>q.queueSend('eval.item',{}, options)).toThrow();
    }
    for(const invalid of [null, [], 1, 'text', true, undefined, Symbol('x'), ()=>{}, new Date(), {toJSON:()=>[]}]) {
      expect(()=>q.queueSend('eval.item',invalid as object)).toThrow('Queue data must be a JSON object');
      expect(db.isTransaction).toBe(false);
    }
    expect(db.prepare('SELECT count(*) n FROM queue_jobs').get()?.n).toBe(0);
    q.queueSend('eval.item',{}, {id:'protected'});
    expect(()=>db.exec("UPDATE queue_jobs SET data='{} ',retry_limit=5")).toThrow(/immutable/);
    const job=q.queueClaim('eval.item')!; q.queueSettle('eval.item',job.id,job.token,null);
    expect(()=>db.exec("UPDATE queue_jobs SET state='created',finished_at=NULL")).toThrow(/terminal/);
    expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  });
  it('runs overlapping handlers outside transactions, bounds concurrency and drains on stop', async () => {
    const f=fixture(), q=new SqliteQueue(store(f.commands),{concurrency:2,pollMs:5});
    cleanup.push(()=>q.stop());
    const release=deferred(); let entered=0;
    await q.work('eval.item',async () => { expect(f.db.isTransaction).toBe(false); entered++; await release.promise; });
    for (let n=0;n<3;n++) await q.send('eval.item',{},{id:String(n)});
    await q.start();
    await vi.waitFor(()=>expect(entered).toBe(2));
    let stopped=false; const stopping=q.stop().then(()=>{stopped=true;});
    await Promise.resolve(); expect(stopped).toBe(false);
    release.resolve(); await stopping;
    expect(f.commands.queueState('eval.item','0')).toBe('completed');
    expect(f.commands.queueState('eval.item','1')).toBe('completed');
    expect(f.commands.queueState('eval.item','2')).toBe('created');
  });
  it('leaves failed acknowledgements for lease recovery without directly rerunning a handler', async () => {
    const f=fixture(), backend=store(f.commands), error=vi.spyOn(console,'error').mockImplementation(()=>{});
    cleanup.push(()=>{error.mockRestore();});
    const q=new SqliteQueue({...backend, settle:async()=>{throw new Error('connection lost');}},{pollMs:5});
    cleanup.push(()=>q.stop());
    const handler=vi.fn(async()=>{}); await q.work('eval.item',handler);
    await q.send('eval.item',{}, {id:'ack',expireInSeconds:1}); await q.start();
    await vi.waitFor(()=>expect(error).toHaveBeenCalled()); await q.stop();
    expect(handler).toHaveBeenCalledTimes(1); expect(f.commands.queueState('eval.item','ack')).toBe('active');
    f.advance(1000); expect(f.commands.queueClaim('eval.item')?.retryCount).toBe(1);
  });
  it('applies positive backoff with the production option shape', () => {
    const f=fixture(), q=f.commands;
    q.queueSend('eval.item',{}, {id:'backoff',retryLimit:5,retryBackoff:true});
    const first=q.queueClaim('eval.item')!;
    q.queueSettle('eval.item',first.id,first.token,'transient');
    expect(q.queueClaim('eval.item')).toBeNull();
    f.advance(999); expect(q.queueClaim('eval.item')).toBeNull();
    f.advance(1); expect(q.queueClaim('eval.item')?.retryCount).toBe(1);
  });
  it('recovers expiry with every slot occupied and fences a late callback', async () => {
    const f=fixture(), q=new SqliteQueue(store(f.commands),{concurrency:1,pollMs:5});
    cleanup.push(()=>q.stop());
    const release=deferred(); const entered: string[]=[];
    await q.work('eval.item',async job => { entered.push(job.id); if(job.id==='hung') await release.promise; });
    await q.send('eval.item',{}, {id:'hung',retryLimit:0,expireInSeconds:1});
    await q.start(); await vi.waitFor(()=>expect(entered).toEqual(['hung']));
    await q.send('eval.item',{}, {id:'next'}); f.advance(1000);
    await vi.waitFor(()=>expect(f.commands.queueState('eval.item','next')).toBe('completed'));
    expect(f.commands.queueState('eval.item','hung')).toBe('failed');
    release.resolve(); await q.stop();
    expect(f.commands.queueState('eval.item','hung')).toBe('failed');
  });
  it('bounds shutdown without acknowledging unfinished callbacks', async () => {
    const f=fixture(), q=new SqliteQueue(store(f.commands),{pollMs:5,drainMs:20});
    const release=deferred(), entered=deferred();
    const error=vi.spyOn(console,'error').mockImplementation(()=>{}); cleanup.push(()=>{error.mockRestore();});
    await q.work('eval.item',async()=>{entered.resolve();await release.promise;});
    await q.send('eval.item',{}, {id:'unfinished'}); await q.start(); await entered.promise;
    await q.stop(); expect(error).toHaveBeenCalled();
    release.resolve(); await Promise.resolve();
    expect(f.commands.queueState('eval.item','unfinished')).toBe('active');
  });
  it('does not revive an old polling generation after timed-out shutdown and restart', async () => {
    const f=fixture(), backend=store(f.commands), claimed=deferred(), oldReply=deferred(), release=deferred();
    const error=vi.spyOn(console,'error').mockImplementation(()=>{}); cleanup.push(()=>{error.mockRestore();});
    let hold=true;
    const q=new SqliteQueue({...backend,claim:async name=>{
      const job=await backend.claim(name);
      if(hold) { hold=false; claimed.resolve(); await oldReply.promise; }
      return job;
    }},{concurrency:1,pollMs:5,drainMs:20});
    cleanup.push(()=>q.stop()); const entered: string[]=[];
    await q.work('eval.item',async job=>{entered.push(job.id);await release.promise;});
    await q.send('eval.item',{}, {id:'old'}); await q.start(); await claimed.promise;
    await q.stop(); await q.send('eval.item',{}, {id:'new'}); await q.start();
    await vi.waitFor(()=>expect(entered).toEqual(['new']));
    oldReply.resolve(); await new Promise(resolve=>setTimeout(resolve,20));
    expect(entered).toEqual(['new']); expect(f.commands.queueState('eval.item','old')).toBe('active');
    release.resolve(); await q.stop();
  });
  it('serializes concurrent sends and claims across actual storage workers and survives restart', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET','sqlite-queue-test-secret-at-least-32-characters');
    const f=fixture(), a=new SqliteStorage(f.path), b=new SqliteStorage(f.path);
    cleanup.push(()=>a.close(),()=>b.close()); await Promise.all([a.ready,b.ready]);
    const sent=await Promise.all(Array.from({length:16},(_,i)=>(i%2?a:b).command('queueSend','eval.item',{value:'persisted'},{id:'once'})));
    expect(sent.filter(Boolean)).toEqual(['once']);
    const claims=await Promise.all([a.command('queueClaim','eval.item'),b.command('queueClaim','eval.item')]);
    const job=claims.find(Boolean)!; expect(claims.filter(Boolean)).toHaveLength(1);
    await Promise.all([a.close(),b.close()]);
    const restarted=new SqliteStorage(f.path); cleanup.push(()=>restarted.close()); await restarted.ready;
    expect(await restarted.command('queueState','eval.item','once')).toBe('active');
    expect(await restarted.command('queueSettle','eval.item','once',job.token,null)).toBe(true);
    expect(await restarted.command('queueState','eval.item','once')).toBe('completed');
  });
});
