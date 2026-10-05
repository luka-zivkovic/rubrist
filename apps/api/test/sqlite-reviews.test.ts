import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlite, migrateSqlite } from '@rubrist/db/sqlite';
import { CreateCriterionInputSchema } from '@rubrist/shared';
import { createUnseededSqliteRuntime as createSqliteRuntime } from './helpers/sqlite.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { createAuth } from '../src/lib/auth.js';
import { MOCK_BINDING, bindingInput } from './fixtures/execution-binding.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs();});
const definition=CreateCriterionInputSchema.parse({stableKey:'grounded',name:'Grounded',definition:'Use evidence.',evaluator:{rubricMarkdown:'Pass grounded answers.',prompt:'Judge {{rubric_markdown}}.',executionBinding:bindingInput(MOCK_BINDING)}});
async function fixture() {
  vi.stubEnv('BETTER_AUTH_SECRET','sqlite-review-test-secret-at-least-32-characters');
  const dir=mkdtempSync(join(tmpdir(),'rubrist-reviews-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'db.sqlite'),runtime=await createSqliteRuntime(path);cleanup.push(()=>runtime.close());
  const {user}=await runtime.auth.api.signUpEmail({body:{email:'owner@example.test',password:'synthetic-long-password',name:'Owner'}});
  const {projectId}=await runtime.accounts.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
  const r=runtime.repository,created=await r.createCriterion(projectId,definition,{}),versionId=created.evaluator.currentVersion.id,criterionVersionId=created.versions[0]!.id;
  const trace=await r.importTrace(projectId,'manual',{input:'x',output:'y',metadata:{}},{ingestionPurpose:'judge_api'});
  const judge=await r.recordJudgeRun({projectId,caseId:trace.caseId,skillVersionId:versionId,verdict:{label:'fail',score:0.1,confidence:0.9,reason:'Synthetic failure'}});
  const db=openSqlite(path);cleanup.push(()=>db.close());sqliteCommands(db);
  return {dir,path,runtime,r,projectId,user,versionId,criterionVersionId,trace,judge,db};
}
describe('SQLite ungoverned review queues',()=>{
  it('pins evidence, excludes pending work from suggestions and atomically deduplicates review submissions',async()=> {
    const f=await fixture();expect((await f.r.suggestReviewQueue(f.projectId,f.versionId,5)).items).toHaveLength(1);
    const q=await f.r.createReviewQueue({projectId:f.projectId,name:'Review',caseIds:[f.trace.caseId,f.trace.caseId],skillVersionId:f.versionId,judgeRunIds:{[f.trace.caseId]:f.judge.id}});
    const detail=(await f.r.getReviewQueueDetail(f.projectId,q.id))!,item=detail.items[0]!;expect(detail.items).toHaveLength(1);expect(q.pendingCount).toBe(1);
    expect(item).toMatchObject({skillVersionId:f.versionId,judgeRunId:f.judge.id,criterionVersionId:f.criterionVersionId});
    expect((await f.r.suggestReviewQueue(f.projectId,f.versionId,5)).items).toEqual([]);
    const peer=await createSqliteRuntime(f.path);cleanup.push(()=>peer.close());
    expect((await f.r.listReviewQueues(f.projectId)).map(row=>row.id)).toContain(q.id);
    expect(await f.r.listReviewQueues('other')).toEqual([]);
    const input={projectId:f.projectId,caseId:f.trace.caseId,skillVersionId:f.versionId,source:'human' as const,actorUserId:f.user.id,payload:{kind:'binary' as const,pass:true,rationale:'Reviewed'},reviewContext:{queueItemId:item.id,judgeRunId:f.judge.id,submissionId:randomUUID()}};
    const rulings=await Promise.all([f.r.recordVerdict(input),peer.repository.recordVerdict(input)]);expect(rulings[0]).toEqual(rulings[1]);
    expect(rulings[0]?.reviewContext).toEqual(input.reviewContext);
    expect(await f.r.recordVerdict({...input,reviewContext:{...input.reviewContext,submissionId:input.reviewContext.submissionId.toUpperCase()}})).toEqual(rulings[0]);
    const stored=f.db.prepare('SELECT * FROM verdicts WHERE id=?').get(rulings[0]!.id)!;
    for(const submission of ['invalid','not-a-uuid-at-all','xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx']) {
      const invalid={...stored,id:randomUUID(),review_submission_id:submission};
      expect(()=>f.db.prepare(`INSERT INTO verdicts(${Object.keys(invalid).join(',')}) VALUES(${Object.keys(invalid).map(()=>'?').join(',')})`).run(...Object.values(invalid))).toThrow(/CHECK/);
    }
    expect((await f.r.getReviewQueueDetail(f.projectId,q.id))?.queue).toMatchObject({pendingCount:0,completedCount:1});
    await expect(f.r.recordVerdict({...input,payload:{...input.payload,pass:false}})).rejects.toThrow(/submission ID/);
    await f.r.closeReviewQueue(f.projectId,q.id);expect(await f.r.recordVerdict(input)).toEqual(rulings[0]);
    await expect(f.r.recordVerdict({...input,reviewContext:{...input.reviewContext,submissionId:randomUUID()}})).rejects.toThrow(/closed/);
    expect(await f.r.getNextPendingQueueItem(f.projectId,q.id)).toBeNull();
    expect((await f.r.reopenReviewQueue(f.projectId,q.id))?.status).toBe('open');
    expect(await f.r.recordVerdict(input)).toEqual(rulings[0]);
    await expect(peer.repository.recordVerdict({...input,reviewContext:{...input.reviewContext,submissionId:randomUUID()}})).rejects.toThrow(/already completed/);
    expect(f.db.prepare('SELECT count(*) n FROM verdicts WHERE review_queue_item_id=?').get(item.id)?.n).toBe(1);
    expect(await f.r.getReviewQueueDetail('other',q.id)).toBeNull();
    expect(()=>f.db.prepare("UPDATE judge_runs SET reasoning='changed' WHERE id=?").run(f.judge.id)).toThrow(/immutable/);
    expect(()=>f.db.prepare('DELETE FROM review_queue_items WHERE id=?').run(item.id)).toThrow(/erasure/);
    expect(()=>f.db.prepare('DELETE FROM cases WHERE id=?').run(f.trace.caseId)).toThrow();
    expect(await f.r.listVerdicts({projectId:f.projectId,source:'human',limit:10})).toEqual([expect.objectContaining({id:rulings[0]!.id,actorName:'Owner'})]);
    await peer.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('preserves overlap assignments through account anonymization and rolls back invalid task appends',async()=> {
    const f=await fixture(),{user:other}=await f.runtime.auth.api.signUpEmail({body:{email:'reviewer@example.test',password:'synthetic-long-password',name:'Reviewer'}});
    const q=await f.r.createReviewQueue({projectId:f.projectId,name:'Overlap',caseIds:[],criterionVersionId:f.criterionVersionId});
    const items=await f.r.addReviewQueueItems({projectId:f.projectId,queueId:q.id,items:[{caseId:f.trace.caseId,skillVersionId:f.versionId,assignedToUserId:f.user.id},{caseId:f.trace.caseId,skillVersionId:f.versionId,assignedToUserId:other.id}]});expect(items).toHaveLength(2);
    expect(await f.r.addReviewQueueItems({projectId:f.projectId,queueId:q.id,items:[{caseId:f.trace.caseId,skillVersionId:f.versionId,assignedToUserId:other.id}]})).toEqual([]);
    await expect(f.r.addReviewQueueItems({projectId:f.projectId,queueId:q.id,items:[{caseId:f.trace.caseId,skillVersionId:f.versionId},{caseId:'missing',skillVersionId:f.versionId}]})).rejects.toThrow();
    expect((await f.r.getReviewQueueDetail(f.projectId,q.id))?.items).toHaveLength(2);
    const input={projectId:f.projectId,caseId:f.trace.caseId,source:'human' as const,actorUserId:other.id,payload:{kind:'binary' as const,pass:true,rationale:'Reviewed'},reviewContext:{queueItemId:items[0]!.id,judgeRunId:f.judge.id,submissionId:randomUUID()}};
    await expect(f.r.recordVerdict(input)).rejects.toThrow(/assignment/);
    const ruling=await f.r.recordVerdict({...input,actorUserId:f.user.id});expect(ruling.skillVersionId).toBe(f.versionId);
    expect((await f.r.getNextPendingQueueItem(f.projectId,q.id,{assignedToUserId:other.id}))?.id).toBe(items[1]!.id);
    f.db.prepare('DELETE FROM "user" WHERE id=?').run(f.user.id);
    expect(f.db.prepare('SELECT actor_user_id FROM verdicts WHERE id=?').get(ruling.id)?.actor_user_id).toBeNull();
    expect(f.db.prepare('SELECT assignment_key FROM review_queue_items WHERE id=?').get(items[0]!.id)?.assignment_key).toBe(f.user.id);
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('scopes agreement, disagreement and consistency reads to their criterion and version',async()=> {
    const f=await fixture(),{user:other}=await f.runtime.auth.api.signUpEmail({body:{email:'second@example.test',password:'synthetic-long-password',name:'Second'}});
    for(const [source,actorUserId,pass] of [['human',f.user.id,true],['human',other.id,false],['llm_judge',null,true],['llm_judge',null,false]] as const) {
      await f.r.recordVerdict({projectId:f.projectId,caseId:f.trace.caseId,skillVersionId:f.versionId,source,...(actorUserId?{actorUserId}:{}),payload:{kind:'binary',pass,rationale:'Synthetic'}});
    }
    expect(await f.r.getProjectKappaSummary(f.projectId,f.criterionVersionId)).toMatchObject({raterCount:2,overlappingCases:1});
    expect((await f.r.getDisagreementSummary(f.projectId,f.criterionVersionId)).cases).toHaveLength(1);
    expect((await f.r.getDisagreementSummary(f.projectId,f.criterionVersionId)).cases[0]?.labels.map(label=>label.actorName).sort()).toEqual(['Owner','Second']);
    expect((await f.r.getJudgeHumanDisagreementSummary(f.projectId,f.criterionVersionId)).cases).toHaveLength(1);
    expect((await f.r.getProjectJudgeHumanCalibration(f.projectId,f.criterionVersionId,f.versionId)).raterCount).toBe(3);
    const second=await f.r.createCriterion(f.projectId,{...definition,stableKey:'second'},{});
    expect((await f.r.getProjectKappaSummary(f.projectId,second.versions[0]!.id)).raterCount).toBe(0);
    await expect(f.r.getProjectKappaSummary('other',f.criterionVersionId)).rejects.toThrow(/project/);
    expect((await f.r.getSelfConsistencyReport(f.projectId,f.versionId)).cases).toHaveLength(1);
    expect((await f.r.getSelfConsistencyReport('other',f.versionId)).cases).toEqual([]);
    await f.r.setJudgeProviderKey(f.projectId,'openai','synthetic-key',f.user.id);
    expect(await f.r.listAuditEntries(f.projectId,'judge_provider_key','openai')).toHaveLength(1);
    expect(await f.r.listAuditEntries('other','judge_provider_key','openai')).toEqual([]);
  });
  it('pages exact convergence totals against a stable verdict watermark',async()=> {
    const f=await fixture(),original=f.db.prepare('SELECT * FROM skill_versions WHERE id=?').get(f.versionId)!;
    const next={...original,id:'skillv_next',version:'0.2.0',created_at:new Date(Date.parse(String(original.created_at))+1).toISOString()};
    f.db.prepare(`INSERT INTO skill_versions(${Object.keys(next).join(',')}) VALUES(${Object.keys(next).map(()=>'?').join(',')})`).run(...Object.values(next));
    const cases=[];
    for(const [index,labels] of [[true,false],[false,true],[true,true],[false,false],[null,null]].entries()) {
      const trace=await f.r.importTrace(f.projectId,'manual',{input:`case${index}`,output:'y',metadata:{}},{ingestionPurpose:'judge_api'});cases.push(trace.caseId);
      for(const [source,skillVersionId,pass] of [['adjudicated',next.id,true],['llm_judge',f.versionId,labels[0]],['llm_judge',next.id,labels[1]]] as const) {
        if(pass===null)continue;
        await f.r.recordVerdict({projectId:f.projectId,caseId:trace.caseId,skillVersionId:String(skillVersionId),source,actorUserId:source==='adjudicated'?f.user.id:undefined,payload:{kind:'binary',pass:Boolean(pass),rationale:'Synthetic'}});
      }
    }
    // Put the snapshot watermark after every case's existing truth, regardless
    // of how many worker commands happened to share a clock millisecond.
    const {sequence:anchorSequence,...anchorRow}=f.db.prepare('SELECT * FROM verdicts ORDER BY created_at DESC,id DESC LIMIT 1').get()!;
    const anchor={...anchorRow,id:'zzzz-watermark',case_id:cases[4]!,skill_version_id:next.id,source:'adjudicated',actor_user_id:f.user.id,
      created_at:new Date(Date.parse(String(anchorRow.created_at))+1).toISOString(),payload:JSON.stringify({kind:'binary',pass:true,rationale:'Watermark'})};
    f.db.prepare(`INSERT INTO verdicts(${Object.keys(anchor).join(',')}) VALUES(${Object.keys(anchor).map(()=>'?').join(',')})`).run(...Object.values(anchor));
    const first=await f.r.getConvergenceAudit(f.projectId,String(original.skill_id),next.id,{limit:2});
    expect(first.audit).toMatchObject({adjudicatedTotal:5,comparedCases:4,afterAgreed:2,beforeKnown:4,beforeAgreed:2,improved:1,regressed:1});
    expect(first.audit.cases.map(c=>c.change)).toEqual(['regressed','improved']);expect(first.nextUncoveredCaseId).toBe(cases[4]);expect(first.nextCursor).not.toBeNull();
    // Append after page one at its SAME millisecond with an ID below its
    // timestamp watermark. Timestamp+random UUID alone must not admit it.
    const latest=f.db.prepare('SELECT * FROM verdicts ORDER BY created_at DESC,id DESC LIMIT 1').get()!;
    const {sequence,...copy}=latest;
    const correction={...copy,id:'0000-later-ruling',case_id:cases[3]!,skill_version_id:next.id,source:'adjudicated',actor_user_id:f.user.id,payload:JSON.stringify({kind:'binary',pass:false,rationale:'Later correction'})};
    f.db.prepare(`INSERT INTO verdicts(${Object.keys(correction).join(',')}) VALUES(${Object.keys(correction).map(()=>'?').join(',')})`).run(...Object.values(correction));
    const page=await f.r.getConvergenceAudit(f.projectId,String(original.skill_id),next.id,{limit:2,cursor:first.nextCursor!});
    expect(page.audit.cases.map(c=>c.change)).toEqual(['still_disagree','still_agree']);expect(page.audit.afterAgreed).toBe(2);expect(page.nextCursor).toBeNull();
    expect((await f.r.getConvergenceAudit(f.projectId,String(original.skill_id),next.id)).audit.afterAgreed).toBe(3);
    await expect(f.r.getConvergenceAudit(f.projectId,String(original.skill_id),f.versionId,{cursor:first.nextCursor!})).rejects.toThrow(/cursor/i);
    expect((await f.r.getConvergenceAudit('other',String(original.skill_id),next.id)).audit.comparedCases).toBe(0);
  });
  it('retains ordinary human and imported verdicts with explicit tenant/version bindings',async()=> {
    const f=await fixture(),q=await f.r.createReviewQueue({projectId:f.projectId,name:'Unpinned',caseIds:[f.trace.caseId],criterionVersionId:f.criterionVersionId});
    const v=await f.r.recordVerdict({projectId:f.projectId,caseId:f.trace.caseId,source:'human',actorUserId:f.user.id,payload:{kind:'binary',pass:true,rationale:'Human'}});
    expect(v.skillVersionId).toBe(f.versionId);expect((await f.r.getReviewQueueDetail(f.projectId,q.id))?.queue.completedCount).toBe(1);
    const imported={projectId:f.projectId,caseId:f.trace.caseId,source:'imported_external' as const,externalRunId:'external',payload:{kind:'binary' as const,pass:false,rationale:'Imported'}};
    const [a,b]=await Promise.all([f.r.recordVerdict(imported),f.r.recordVerdict(imported)]);expect(a).toEqual(b);
    expect((await f.r.listVerdicts({projectId:f.projectId,source:'imported_external',limit:10}))[0]?.skillVersionId).toBeNull();
    await expect(f.r.recordVerdict({...imported,source:'human',externalRunId:undefined,skillVersionId:'missing'})).rejects.toThrow();
    await f.r.createCriterion(f.projectId,{...definition,stableKey:'second'},{});
    await expect(f.r.recordVerdict({...imported,source:'human',externalRunId:undefined})).rejects.toThrow(/multiple|criterion|ambiguous/i);
  });
});

it('upgrades M2 verdicts without changing any existing row, receipt BLOB, or migration checksum',async()=> {
  vi.stubEnv('BETTER_AUTH_SECRET','sqlite-review-upgrade-secret-at-least-32-characters');
  const dir=mkdtempSync(join(tmpdir(),'rubrist-review-upgrade-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'db.sqlite'),migrations=join(dir,'migrations');mkdirSync(migrations);
  const source=fileURLToPath(new URL('../../../packages/db/sqlite-migrations/',import.meta.url));
  for(const file of readdirSync(source).filter(name=>name.endsWith('.sql')&&name<'0007'))copyFileSync(join(source,file),join(migrations,file));
  const db=openSqlite(path);cleanup.push(()=>db.close());migrateSqlite(db,migrations);const c=sqliteCommands(db),auth=createAuth(db);
  const {user}=await auth.api.signUpEmail({body:{email:'owner@example.test',password:'synthetic-long-password',name:'Owner'}});
  const {projectId}=c.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
  // Current command wrappers require a clock; this TEMP fixture clock is not
  // part of historical storage and is removed before migration qualification.
  db.exec('CREATE TEMP TABLE rubrist_command_clock(singleton INTEGER PRIMARY KEY,last_ms INTEGER NOT NULL); INSERT INTO rubrist_command_clock VALUES(1,0)');
  const created=c.createCriterion(projectId,definition,{}),version=created.evaluator.currentVersion.id;
  const trace=c.importTrace(projectId,'release_evidence',{input:'Unicode 😀',output:'Evidence',metadata:{}},{ingestionPurpose:'release_evidence'});
  // Seed using the applied M2 schema, independently of newer command columns.
  const stamp=new Date().toISOString(),runId='upgrade-run',itemId='upgrade-item';
  db.prepare(`INSERT INTO eval_runs(id,project_id,skill_version_id,trigger,status,total_items,created_at)
    VALUES(?,?,?,'release_evidence','pending',1,?)`).run(runId,projectId,version,stamp);
  db.prepare(`INSERT INTO eval_run_items(id,project_id,eval_run_id,case_id,client_item_id,content_digest,status,created_at)
    VALUES(?,?,?,?,?,?,'pending',?)`).run(itemId,projectId,runId,trace.caseId,'one','sha256:'+'a'.repeat(64),stamp);
  const run=c.getEvalRunDetail(projectId,runId)!;
  const v=c.recordVerdict({projectId,caseId:trace.caseId,skillVersionId:version,source:'llm_judge',payload:{kind:'binary',pass:true,rationale:'Unicode 😀'},observed:{model:'mock',requestId:null,responseId:null,systemFingerprint:null,upstreamProvider:null,thinkingReturned:null,reasoningTokens:null}});
  const execution={projectId,evalRunId:run.id,evalRunItemId:run.items[0]!.id,executionToken:'one'};c.claimEvalRunItemExecution(execution);c.beginEvalRunItemProviderCall(execution);c.markEvalRunItemProviderCallReturned(execution);c.completeEvalRunItem({...execution,verdictId:v.id,resultLabel:'pass'});
  db.exec('DROP TABLE temp.rubrist_command_clock');
  const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'").all().map(row=>String(row.name));
  const snapshots=tables.map(table=>({table,rows:db.prepare(`SELECT rowid AS retained_rowid,* FROM "${table}" ORDER BY rowid`).all()}));
  migrateSqlite(db,source);migrateSqlite(db,source);
  for(const {table,rows} of snapshots) {
    const after=db.prepare(`SELECT rowid AS retained_rowid,* FROM "${table}" ORDER BY rowid`).all();
    if(table==='rubrist_sqlite_migrations')expect(after.slice(0,rows.length)).toEqual(rows);
    else expect(after.map(row=>Object.fromEntries(Object.keys(rows[0]??{}).map(key=>[key,row[key]])))).toEqual(rows);
  }
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
});
