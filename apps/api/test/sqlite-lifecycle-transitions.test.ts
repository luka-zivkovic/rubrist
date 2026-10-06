import {expect,it} from 'vitest';
import {activationFixture} from './helpers/sqlite-lifecycle-activation.js';
import {sqliteCommand} from '../src/storage/sqlite/command-context.js';
it('activates exact complete evidence, authorizes implicit use and atomically revokes to needs-review',async()=>{
 const f=await activationFixture(),repo=f.runtime.evaluatorLifecycle,id=f.candidate.skill.currentVersion.id;
 const active=await repo.activate(f.actor,id,f.activation);expect(active.projection.implicitExecutionAllowed).toBe(true);
 expect((await f.runtime.repository.getCurrentSkillForCriterion(f.projectId,f.candidate.skill.criterionId)).currentVersion.status).toBe('production');
 await repo.authorizeExecution({projectId:f.projectId,skillVersionId:id,context:'implicit_production',resourceKind:'test',resourceId:'test',idempotencyKey:'active'});
 const before=Buffer.from(f.calibration.artifactCopy.canonicalBytes);
 sqliteCommand(f.db,c=>c.db.prepare('INSERT INTO binary_calibration_revocation_events VALUES(?,?,?,?,?,?,?,?)').run('revoke',f.calibration.artifact.artifactId,f.calibration.run.runId,f.projectId,'provider_policy_invalidated','fixture','policy',c.timestamp));
 const revoked=await repo.getLifecycle(f.actor,id);expect(revoked?.currentEvent.state).toBe('needs_review');expect(revoked?.implicitExecutionAllowed).toBe(false);
 expect(Buffer.from((await f.runtime.binaryCalibration.getArtifact(f.actor,f.calibration.artifact.artifactId)).canonicalBytes)).toEqual(before);
 await expect(repo.authorizeExecution({projectId:f.projectId,skillVersionId:id,context:'implicit_production',resourceKind:'test',resourceId:'test',idempotencyKey:'active'})).rejects.toMatchObject({code:'execution_forbidden'});
 expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('SELECT * FROM evaluator_activation_claims').all()).toEqual([]);
});
import {vi} from 'vitest';
import {activationInput,calibrationEvidence,regressionEvidence} from './helpers/sqlite-lifecycle-activation.js';
import {transitionLifecycle} from '../src/storage/sqlite/lifecycle-transition.js';
import {loadLifecycleProjection} from '../src/storage/sqlite/lifecycle-reads.js';
import {rowToEvent} from '../src/evaluator-lifecycle/storage-values.js';
import {evaluatorLifecycleDigest} from '../src/lib/evaluator-lifecycle.js';
import {lifecycleRawEventDigest} from '../src/storage/sqlite/lifecycle-values.js';
import type {SQLInputValue} from 'node:sqlite';
function headInput(p:NonNullable<ReturnType<typeof loadLifecycleProjection>>){const h=p.currentEvent;if(h.state==='retired')throw new Error('Already retired');return {expectedState:h.state,expectedSequence:h.sequence,expectedEventId:h.id,expectedEventDigest:h.contentDigest,rationale:'Retire exact evaluator.',idempotencyKey:'retire:'+h.id};}
function intercept(db:import('node:sqlite').DatabaseSync,table:string,mutate:(row:Record<string,SQLInputValue>)=>Record<string,SQLInputValue>|null){
 const prepare=db.prepare.bind(db);
 return vi.spyOn(db,'prepare').mockImplementation(sql=>{const statement=prepare(sql),m=new RegExp(`^INSERT INTO ${table}\\(([^)]+)\\)`).exec(sql);if(!m)return statement;return new Proxy(statement,{get(target,key){if(key==='run')return (...values:SQLInputValue[])=>{const columns=m[1]!.split(','),row=mutate(Object.fromEntries(columns.map((k,i)=>[k,values[i]!])));return row?target.run(...columns.map(k=>row[k]!)):{changes:0,lastInsertRowid:0};};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});});
}
it('serializes competing activation, replays the winner and retires with an exact head',async()=>{
 const f=await activationFixture(),repo=f.runtime.evaluatorLifecycle,id=f.candidate.skill.currentVersion.id;
 const results=await Promise.allSettled([repo.activate(f.actor,id,{...f.activation,idempotencyKey:'a'}),repo.activate(f.actor,id,{...f.activation,idempotencyKey:'b'})]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 const active=await repo.getLifecycle(f.actor,id);if(!active)throw new Error('projection');
 const key=active.currentEvent.idempotencyKey;expect((await repo.activate(f.actor,id,{...f.activation,idempotencyKey:key})).replayed).toBe(true);
 const input=headInput(active),retired=await repo.retire(f.actor,id,input);expect(retired.projection.currentEvent.state).toBe('retired');expect((await repo.retire(f.actor,id,input)).replayed).toBe(true);
 await expect(repo.authorizeExecution({projectId:f.projectId,skillVersionId:id,context:'binary_calibration_evidence',resourceKind:'test',resourceId:'test',idempotencyKey:'retired'})).rejects.toMatchObject({code:'execution_forbidden'});
});
it('replaces the sole active evaluator with a reciprocal retirement bundle',async()=>{
 const f=await activationFixture(true),repo=f.runtime.evaluatorLifecycle,first=await repo.activate(f.actor,f.candidate.skill.currentVersion.id,f.activation);
 const second=f.second!,regression=f.secondRegression!,calibration=calibrationEvidence(f,second,f.sealedRevisionId),input=activationInput(second,calibration,regression),id=second.skill.currentVersion.id;
 await expect(repo.activate(f.actor,id,input)).rejects.toMatchObject({code:'prior_active_conflict'});
 const replacement={...input,expectedPriorActiveSkillVersionId:f.candidate.skill.currentVersion.id,expectedPriorActiveEventId:first.event.id,expectedPriorActiveEventDigest:first.event.contentDigest};
 const spy=intercept(f.db,'evaluator_activation_finalizations',()=>null);
 try{expect(()=>transitionLifecycle(f.db,f.actor,id,replacement,'activated')).toThrow(/FOREIGN KEY/);}finally{spy.mockRestore();}
 expect(loadLifecycleProjection(f.db,f.projectId,f.candidate.skill.currentVersion.id)?.currentEvent.id).toBe(first.event.id);
 const result=await repo.activate(f.actor,id,replacement);expect(result.replacedEvent?.state).toBe('retired');expect(result.replacedEvent?.activationBundleId).toBe(result.event.activationBundleId);
 expect(f.db.prepare("SELECT count(*) n FROM evaluator_lifecycle_heads WHERE criterion_id=? AND state='active'").get(second.skill.criterionId)?.n).toBe(1);
 expect((await repo.activate(f.actor,id,replacement)).replayed).toBe(true);
 expect((await f.runtime.repository.getCurrentSkillForCriterion(f.projectId,second.skill.criterionId)).currentVersion.id).toBe(id);
});
it.each(['expectedCalibrationArtifactDigest','expectedCalibrationEvidenceDigest','regressionRunId'])('rejects wrong activation %s',async field=>{
 const f=await activationFixture(),input={...f.activation,[field]:field==='regressionRunId'?'foreign':'sha256:'+'a'.repeat(64)};
 await expect(f.runtime.evaluatorLifecycle.activate(f.actor,f.candidate.skill.currentVersion.id,input)).rejects.toMatchObject({code:'state_conflict'});
 expect(f.db.prepare('SELECT * FROM evaluator_activation_claims').all()).toEqual([]);
});
it.each(['bundle','system-owner','replaced-id'])('rejects a self-consistent invalid event shape: %s',async kind=>{
 const f=await activationFixture(),id=f.candidate.skill.currentVersion.id,retire=kind!=='bundle',input=retire?headInput(f.candidate.projection):f.activation;
 const spy=intercept(f.db,'evaluator_lifecycle_events',row=>{
  const {contentDigest:_digest,occurredAt:_time,...event}=rowToEvent(row);
  if(kind==='bundle'){row.activation_bundle_id=null;event.activationBundleId=null;}
  else if(kind==='system-owner'){row.actor_role='system';row.actor_user_id=null;row.actor_subject_id=null;event.actorRole='system';event.actorUserId=null;event.actorSubjectId=null;}
  else{row.replaced_skill_version_id=id;event.replacedSkillVersionId=id;}
  row.content_digest=evaluatorLifecycleDigest({basis:'evaluator-lifecycle-event/v1',...event});return row;
 });
 try{expect(()=>transitionLifecycle(f.db,f.actor,id,input,retire?'retired':'activated')).toThrow(/transition evidence/);}finally{spy.mockRestore();}
 expect(loadLifecycleProjection(f.db,f.projectId,id)?.currentEvent.state).toBe('candidate');
});
it.each(['id','idempotency_key'])('hashes exact stored event %s rather than its trimmed projection',async key=>{
 const f=await activationFixture(),id=f.candidate.skill.currentVersion.id,spy=intercept(f.db,'evaluator_lifecycle_events',row=>{
  const unpadded=lifecycleRawEventDigest(row),padded={...row,[key]:' '+row[key]+' '};expect(lifecycleRawEventDigest(padded)).not.toBe(unpadded);
  return padded; // retains the original digest: this must fail at the database.
 });
 try{expect(()=>transitionLifecycle(f.db,f.actor,id,headInput(f.candidate.projection),'retired')).toThrow(/transition evidence/);}finally{spy.mockRestore();}
});
it('does not let an outer OR IGNORE skip the automatic needs-review event',async()=>{
 const f=await activationFixture(),id=f.candidate.skill.currentVersion.id;await f.runtime.evaluatorLifecycle.activate(f.actor,id,f.activation);
 // Simulate a conflicting index that makes the trigger insert eligible for IGNORE.
 f.db.exec("CREATE UNIQUE INDEX test_system_event_conflict ON evaluator_lifecycle_events(criterion_id) WHERE state IN('active','needs_review')");
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare('INSERT OR IGNORE INTO binary_calibration_revocation_events VALUES(?,?,?,?,?,?,?,?)').run('ignored',f.calibration.artifact.artifactId,f.calibration.run.runId,f.projectId,'provider_policy_invalidated','fixture','policy',c.timestamp))).toThrow(/must append needs-review/);
 expect(f.db.prepare("SELECT * FROM binary_calibration_revocation_events WHERE id='ignored'").all()).toEqual([]);expect(loadLifecycleProjection(f.db,f.projectId,id)?.currentEvent.state).toBe('active');
 f.db.exec('DROP INDEX test_system_event_conflict');
});
it('rejects all updates to activation-cited regression evidence while allowing project erasure',async()=>{
 const f=await activationFixture(),id=f.candidate.skill.currentVersion.id;
 expect(f.db.prepare('UPDATE regression_runs SET status=status WHERE id=?').run(f.regression.id).changes).toBe(1);
 await f.runtime.evaluatorLifecycle.activate(f.actor,id,f.activation);
 expect(()=>f.db.prepare('UPDATE regression_runs SET status=status WHERE id=?').run(f.regression.id)).toThrow(/activation is immutable/);
 expect(()=>f.db.prepare('UPDATE regression_runs SET compared=compared+1 WHERE id=?').run(f.regression.id)).toThrow(/immutable/);
 expect(()=>f.db.prepare('DELETE FROM regression_runs WHERE id=?').run(f.regression.id)).toThrow(/project erasure/);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('SELECT * FROM regression_runs').all()).toEqual([]);
});
it.each(['demote','remove'])('rechecks live ownership at direct event insertion after %s',async action=>{
 const f=await activationFixture(),spy=intercept(f.db,'evaluator_lifecycle_events',row=>{
  f.db.prepare(action==='demote'?"UPDATE project_members SET role='member' WHERE project_id=? AND user_id=?":'DELETE FROM project_members WHERE project_id=? AND user_id=?').run(f.projectId,f.userId);return row;
 });
 try{expect(()=>transitionLifecycle(f.db,f.actor,f.candidate.skill.currentVersion.id,f.activation,'activated')).toThrow(/transition evidence/);}finally{spy.mockRestore();}
 expect(loadLifecycleProjection(f.db,f.projectId,f.candidate.skill.currentVersion.id)?.currentEvent.state).toBe('candidate');
 expect(f.db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(f.projectId,f.userId)?.role).toBe('owner');
});
import {EVALUATOR_EXECUTION_AUTHORIZATION_VERSION} from '@rubrist/shared';
import {evaluatorExecutionAuthorizationDigest} from '../src/lib/evaluator-lifecycle.js';
it.each(['head','artifact','tenant','digest'])('rejects direct execution authorization with invalid %s',async field=>{
 const f=await activationFixture(),active=await f.runtime.evaluatorLifecycle.activate(f.actor,f.candidate.skill.currentVersion.id,f.activation);
 const input={projectId:f.projectId,skillVersionId:f.candidate.skill.currentVersion.id,context:'implicit_production' as const,lifecycleEventId:active.event.id,calibrationArtifactId:f.calibration.artifact.artifactId,resourceKind:'test',resourceId:'forged'};
 if(field==='head')input.lifecycleEventId=f.candidate.projection.currentEvent.id;
 if(field==='artifact')input.calibrationArtifactId='foreign';
 if(field==='tenant')input.projectId='foreign';
 const digest=evaluatorExecutionAuthorizationDigest(input);
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare('INSERT INTO evaluator_execution_authorizations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('forged',EVALUATOR_EXECUTION_AUTHORIZATION_VERSION,input.projectId,input.skillVersionId,input.context,input.lifecycleEventId,input.calibrationArtifactId,input.resourceKind,input.resourceId,'forged',field==='digest'?'sha256:'+'a'.repeat(64):digest,c.timestamp))).toThrow(field==='digest'?/digest or command time/:/eligible current lifecycle head/);
 expect(f.db.prepare("SELECT * FROM evaluator_execution_authorizations WHERE id='forged'").all()).toEqual([]);
});
import {buildEvaluatorSuiteManifest,canonicalEvaluatorSuiteManifestBytes,evaluatorSuiteArtifactDigest,evaluatorSuiteCreateRequestDigest,suiteMemberEvaluator} from '../src/lib/evaluator-suite-manifest.js';
it.each(['candidate','revoked','retired'])('rejects direct canonical suite publication for %s lifecycle',async state=>{
 const f=await activationFixture(),v=f.candidate.skill.currentVersion,criterion=f.promoted.criterionVersion;
 if(state!=='candidate'){
  const active=await f.runtime.evaluatorLifecycle.activate(f.actor,v.id,f.activation);
  const published=await f.runtime.repository.createEvaluatorSuiteManifest(f.projectId,{idempotencyKey:'active-suite',members:[{criterionVersionId:criterion.id,skillVersionId:v.id}],trialPlan:null},{actorUserId:f.userId});expect(published.members[0]?.skillVersionId).toBe(v.id);
  if(state==='retired')await f.runtime.evaluatorLifecycle.retire(f.actor,v.id,headInput(active.projection));
  else sqliteCommand(f.db,c=>c.db.prepare('INSERT INTO binary_calibration_revocation_events VALUES(?,?,?,?,?,?,?,?)').run('suite-revoked',f.calibration.artifact.artifactId,f.calibration.run.runId,f.projectId,'provider_policy_invalidated','fixture','policy',c.timestamp));
 }
 const input={suiteId:'direct-suite',idempotencyKey:'direct-suite',members:[{criterionVersionId:criterion.id,skillVersionId:v.id}],trialPlan:null},manifest=buildEvaluatorSuiteManifest({manifestId:'direct-manifest',projectId:f.projectId,suiteId:input.suiteId,revision:1,members:[{criterionId:criterion.criterionId,criterionVersionId:criterion.id,criterionName:criterion.name,criterionDefinition:criterion.definition,...suiteMemberEvaluator(v)!}],trialPlan:null}),bytes=canonicalEvaluatorSuiteManifestBytes(manifest);
 expect(()=>sqliteCommand(f.db,c=>{c.db.prepare('INSERT INTO evaluator_suites VALUES(?,?,?,?)').run(input.suiteId,f.projectId,f.userId,c.timestamp);c.db.prepare('INSERT INTO evaluator_suite_manifests VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(manifest.manifestId,f.projectId,input.suiteId,1,bytes,evaluatorSuiteArtifactDigest(bytes),manifest.manifestDigest,f.userId,input.idempotencyKey,evaluatorSuiteCreateRequestDigest(input),c.timestamp);})).toThrow(/suite publication requires eligible lifecycle/);
 expect(f.db.prepare("SELECT * FROM evaluator_suites WHERE id='direct-suite'").all()).toEqual([]);
});
