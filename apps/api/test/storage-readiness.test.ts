import {afterEach, expect, it, vi} from 'vitest';
import {mkdtempSync, mkdirSync, rmSync, statSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReadiness} from '../src/storage/readiness.js';
import {createApp} from '../src/app.js';
import {createSqliteRuntime} from '../src/storage/sqlite/runtime.js';
import {sqliteDiagnostic} from '../src/storage/sqlite/diagnostics.js';
import {acquireSqliteInstance} from '../src/storage/sqlite/instance-lock.js';
import type {Worker} from 'node:worker_threads';
import {ALL_QUEUES,PgBossQueue} from '@rubrist/queue';
import {SqliteQueue} from '@rubrist/queue/sqlite';

afterEach(() => {vi.useRealTimers();vi.unstubAllEnvs();vi.restoreAllMocks();});
it('bounds responses and coalesces a stuck storage probe until it settles', async () => {
  vi.useFakeTimers();
  let finish!: (ready:boolean)=>void;
  const probe=vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
  const readiness=createReadiness(probe,50);
  const calls=Array.from({length:20},()=>readiness.check());
  await vi.advanceTimersByTimeAsync(50);
  expect(await Promise.all(calls)).toEqual(Array(20).fill(false));
  const next=readiness.check();
  await vi.advanceTimersByTimeAsync(50);
  expect(await next).toBe(false);expect(probe).toHaveBeenCalledTimes(1);
  finish(true);await vi.advanceTimersByTimeAsync(0);
  const duringShutdown=readiness.check();readiness.stop();
  await vi.advanceTimersByTimeAsync(50);
  expect(await duringShutdown).toBe(false);expect(await readiness.check()).toBe(false);
});
it('requires recent poll-loop progress for every queue even when one queue is degraded',async()=>{
  vi.useFakeTimers();vi.spyOn(console,'error').mockImplementation(()=>{});
  let fail=false;
  const queue=new SqliteQueue({send:async()=>null,state:async()=>null,claim:async()=>null,settle:async()=>true,recover:async()=>{if(fail)throw Error('synthetic');return [];}},{pollMs:10});
  for(const name of ALL_QUEUES.slice(0,-1))await queue.work(name,async()=>{});
  await queue.start();await vi.advanceTimersByTimeAsync(10);expect(await queue.isReady()).toBe(false);
  await queue.work(ALL_QUEUES.at(-1)!,async()=>{});
  await vi.advanceTimersByTimeAsync(10);expect(await queue.isReady()).toBe(true);
  fail=true;await vi.advanceTimersByTimeAsync(10);expect(await queue.isReady()).toBe(true);
  fail=false;await vi.advanceTimersByTimeAsync(10);expect(await queue.isReady()).toBe(true);
  await queue.stop();expect(await queue.isReady()).toBe(false);
});
it('checks real storage and keeps liveness/readiness independent of auth session reads',async()=>{
  vi.stubEnv('BETTER_AUTH_SECRET','synthetic-readiness-secret-not-for-deployment');
  const dir=mkdtempSync(join(tmpdir(),'rubrist-ready-'));
  mkdirSync(join(dir,'new'),{mode:0o700});
  const path=join(dir,'new','database.sqlite');
  const runtime=await createSqliteRuntime(path,undefined,{seedStarterEvaluators:false,exclusiveInstance:true});
  try {
    await expect(createSqliteRuntime(path,undefined,{seedStarterEvaluators:false,exclusiveInstance:true})).rejects.toThrow('busy');
    expect(statSync(join(dir,'new')).mode&0o777).toBe(0o700);
    expect(statSync(path).mode&0o777).toBe(0o600);
    const session=vi.spyOn(runtime.auth.api,'getSession').mockRejectedValue(Error('private synthetic credential'));
    const readiness=createReadiness(async()=>{await runtime.storage.probe();return true;});
    const app=createApp(runtime.repository,{accounts:runtime.accounts,auth:runtime.auth,runtimeMode:'persistent',readiness:readiness.check});
    expect((await app.request('/ready')).status).toBe(200);
    expect((await app.request('/health')).status).toBe(200);expect(session).not.toHaveBeenCalled();
    readiness.stop();expect((await app.request('/ready')).status).toBe(503);
    expect((await app.request('/health')).status).toBe(200);
    await runtime.close();await expect(runtime.storage.probe()).rejects.toThrow('closed');
  } finally {await runtime.close();rmSync(dir,{recursive:true,force:true});}
});
it('returns redacted startup guidance for operational storage errors',()=>{
  for(const [errcode,expected]of [[13,'full'],[5,'busy'],[8,'permissions'],[10,'I/O'],[11,'corrupt']]as const){
    const message=sqliteDiagnostic({errcode,message:'secret DATABASE_URL private SQL'});
    expect(message).toContain(expected);expect(message).not.toContain('secret');
  }
  expect(sqliteDiagnostic(Error('SQLite migration checksum mismatch: private'))).toContain('schema');
  expect(sqliteDiagnostic(Error('private'))).not.toContain('private');
});

it('checks PostgreSQL worker liveness, registered queues, failures and shutdown races',async()=>{
 const queue=new PgBossQueue('postgres://synthetic:synthetic@localhost/synthetic');
 const workers=ALL_QUEUES.map(name=>({name,state:'active',lastFetchedOn:Date.now(),count:0}));
 const queues=ALL_QUEUES.map(name=>({name}));
 const boss={getWipData:()=>workers,getQueues:vi.fn(async()=>queues)};
 Object.assign(queue,{boss,running:true});
 expect(await queue.isReady()).toBe(true);
 workers[0]!.lastFetchedOn=0;expect(await queue.isReady()).toBe(false);
 workers[0]!.count=1;expect(await queue.isReady()).toBe(true);
 workers[0]!.state='stopped';expect(await queue.isReady()).toBe(false);
 workers[0]!.state='active';queues.pop();expect(await queue.isReady()).toBe(false);
 queues.push({name:ALL_QUEUES.at(-1)!});
 boss.getQueues.mockRejectedValueOnce(Error('private connection details'));
 expect(await createReadiness(()=>queue.isReady()).check()).toBe(false);
 let finish!:(value:typeof queues)=>void;
 boss.getQueues.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const readiness=createReadiness(()=>queue.isReady()),pending=readiness.check();
 await Promise.resolve();readiness.stop();finish(queues);expect(await pending).toBe(false);
});
it('rejects database symlinks and releases instance ownership after closing',()=>{
 const root=mkdtempSync(join(tmpdir(),'rubrist-instance-'));
 try{
  const path=join(root,'db.sqlite');
  const lock=acquireSqliteInstance(path);
  expect(()=>acquireSqliteInstance(path)).toThrow();lock.close();
  const next=acquireSqliteInstance(path);next.close();
  symlinkSync(path+'.instance-lock',join(root,'link.sqlite'));
  expect(()=>acquireSqliteInstance(join(root,'link.sqlite'))).toThrow('symlink');
  symlinkSync(join(root,'absent-target.sqlite'),join(root,'dangling.sqlite'));
  expect(()=>acquireSqliteInstance(join(root,'dangling.sqlite'))).toThrow('symlink');
  symlinkSync(join(root,'absent-lock.sqlite'),join(root,'new.sqlite.instance-lock'));
  expect(()=>acquireSqliteInstance(join(root,'new.sqlite'))).toThrow('symlink');
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('reports unexpected storage-worker death once and rejects subsequent probes',async()=>{
 vi.stubEnv('BETTER_AUTH_SECRET','synthetic-worker-fatal-secret-not-for-deployment');
 const root=mkdtempSync(join(tmpdir(),'rubrist-worker-fatal-')),onFailure=vi.fn();
 const runtime=await createSqliteRuntime(join(root,'db.sqlite'),undefined,{seedStarterEvaluators:false,onFailure,exclusiveInstance:true});
 try{
  await (runtime.storage as unknown as {worker:Worker}).worker.terminate();
  await vi.waitFor(()=>expect(onFailure).toHaveBeenCalledOnce());
  await expect(runtime.storage.probe()).rejects.toThrow('exited');
  await runtime.close();expect(onFailure).toHaveBeenCalledOnce();
 }finally{await runtime.close();rmSync(root,{recursive:true,force:true});}
});
