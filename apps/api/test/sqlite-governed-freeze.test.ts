import { expect,it } from 'vitest';
import { DatabaseSync,type SQLInputValue } from 'node:sqlite';
import { governedConflictFixture } from './helpers/sqlite-governed-conflict.js';
import { appendNonsealedGovernedAdjudication } from '../src/storage/sqlite/governed-adjudication-commands.js';
import { governedDraftFixture } from './helpers/sqlite-governed-draft.js';
import { cleanup } from './helpers/sqlite-analysis.js';
import { createNonsealedGovernedDraft } from '../src/storage/sqlite/governed-draft-commands.js';
import { transitionNonsealedGovernedBatch as transition,getOrCreateNonsealedBlindView,initializeGovernedViewValidator } from '../src/storage/sqlite/governed-view-commands.js';
import { appendNonsealedGovernedTaskAction as action } from '../src/storage/sqlite/governed-label-commands.js';
import { freezeNonsealedGovernedTruth as freeze } from '../src/storage/sqlite/governed-freeze-commands.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { governedContentV1Digest } from '../src/lib/governed-content-digest.js';
import { datasetRevisionItemDigest } from '../src/lib/dataset-revision.js';
async function prepared(manual=false,numeric=false){const f=await governedDraftFixture(numeric),sourceIds=f.db.prepare('SELECT id FROM dataset_revision_items WHERE revision_id=? ORDER BY position').all(f.revision.id).map(i=>String(i.id)),batchId=createNonsealedGovernedDraft(f.db,f.actor,{...f.input,selection:manual?{method:'manual',selectedSourceItemIds:sourceIds}:{method:'simple_random',fixedBudget:3}});transition(f.db,f.actor,batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});for(const row of f.db.prepare('SELECT id FROM governed_review_tasks WHERE batch_id=? ORDER BY id').all(batchId)){const taskId=String(row.id),view=getOrCreateNonsealedBlindView(f.db,f.actor,taskId);action(f.db,f.actor,taskId,{kind:'submit_label',input:{viewDigest:view.viewDigest,label:'pass',rationale:'Supported',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}});}transition(f.db,f.actor,batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});transition(f.db,f.actor,batchId,'finalize',{expectedStateVersion:2,idempotencyKey:'resolve'});return {...f,batchId};}
const command={expectedStateVersion:3,idempotencyKey:'freeze'};
it.each([false,true])('freezes complete exact truth with honest representative scope (manual=%s)',async manual=>{
 const f=await prepared(manual),peer=new DatabaseSync(f.path);cleanup.push(()=>peer.close());peer.exec('PRAGMA foreign_keys=ON');sqliteCommands(peer);
 const revisionId=freeze(peer,f.actor,f.batchId,command);expect(freeze(peer,f.actor,f.batchId,command)).toBe(revisionId);
 const revision=peer.prepare('SELECT * FROM dataset_revisions WHERE id=?').get(revisionId)!;expect(revision).toMatchObject({provenance_level:'governed_blind',criterion_version_id:f.criterionVersionId,item_count:3});
 const items=peer.prepare('SELECT * FROM dataset_revision_items WHERE revision_id=? ORDER BY position').all(revisionId);expect(items).toHaveLength(3);
 for(const item of items){const payload=JSON.parse(String(item.payload_snapshot));expect(payload).not.toHaveProperty('metadata');expect(item.item_digest).toBe(datasetRevisionItemDigest({inputIdentity:{basis:'input-identity/v1',digest:String(item.input_digest)},redactedPayload:payload,referenceLabel:item.reference_label,expectedFailStep:null,reviewProvenance:JSON.parse(String(item.reference_provenance)),note:null}));const truth=peer.prepare('SELECT * FROM governed_dataset_truth_links WHERE dataset_revision_item_id=?').get(item.id!)!;expect(truth).toMatchObject({source_kind:'governed_labels',resolution_kind:'single_rater',resolved_label:'pass',supporting_label_count:1});expect(JSON.parse(String(item.reference_provenance)).sourceId).toBe(truth.id);expect(peer.prepare('SELECT count(*) n FROM governed_dataset_truth_link_labels WHERE truth_link_id=?').get(truth.id!)?.n).toBe(1);}
 const frozen=peer.prepare("SELECT * FROM governed_review_batch_events WHERE batch_id=? AND event_kind='frozen'").get(f.batchId)!;
 expect(JSON.parse(String(frozen.representative_ineligible_reasons))).toEqual(manual?['draw_not_server_executed','selection_method_not_eligible']:[]);expect(frozen.representative_of_population_id===null).toBe(manual);
 expect(()=>peer.exec("UPDATE governed_dataset_truth_links SET resolved_label='fail'")).toThrow(/immutable/);expect(()=>freeze(peer,f.actor,f.batchId,{...command,idempotencyKey:'stale'})).toThrow(expect.objectContaining({code:'governed_review_stream_conflict'}));
 const plain=new DatabaseSync(f.path);cleanup.push(()=>plain.close());expect(plain.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');expect(plain.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(peer.prepare('SELECT * FROM governed_dataset_truth_links').all()).toEqual([]);
});
it('rejects a provenance claim without authoritative truth links at revision finalization',async()=>{
 const f=await prepared(),source=f.db.prepare('SELECT * FROM dataset_revisions WHERE id=?').get(f.revision.id)!;
 expect(()=>sqliteCommand(f.db,c=>{
  const row:Record<string,SQLInputValue>={...source,id:'forged-revision',series_id:'forged',source_dataset_id:null,provenance_level:'governed_blind',criterion_version_id:f.criterionVersionId,created_at:c.timestamp,idempotency_key:'forged'};
  c.db.prepare(`INSERT INTO dataset_revisions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
  for(const i of c.db.prepare('SELECT * FROM dataset_revision_items WHERE revision_id=?').all(f.revision.id)){const payload=JSON.parse(String(i.payload_snapshot));delete payload.metadata;const copy:Record<string,SQLInputValue>={...i,id:'forged-'+i.id,revision_id:'forged-revision',created_at:c.timestamp,source_case_id:null,source_dataset_item_id:null,payload_snapshot:JSON.stringify(payload),item_digest:datasetRevisionItemDigest({inputIdentity:{basis:'input-identity/v1',digest:String(i.input_digest)},redactedPayload:payload,referenceLabel:i.reference_label,expectedFailStep:null,reviewProvenance:JSON.parse(String(i.reference_provenance)),note:null})};c.db.prepare(`INSERT INTO dataset_revision_items(${Object.keys(copy).join(',')}) VALUES(${Object.keys(copy).map(()=>'?').join(',')})`).run(...Object.values(copy));}
  c.db.prepare("INSERT INTO dataset_exposure_events(id,project_id,revision_id,kind,exposure_class,activity,subject_kind,details,idempotency_key,occurred_at) VALUES('forged-exposure',?,'forged-revision','created','lineage','revision_create','system','{}','forged',?)").run(f.projectId,c.timestamp);
  c.db.prepare('INSERT INTO dataset_revision_finalizations VALUES(?,?)').run('forged-revision',f.projectId);
 })).toThrow(/authoritative truth links|same-command frozen batch|metadata-free revision payload/);expect(f.db.prepare("SELECT id FROM dataset_revisions WHERE id='forged-revision'").get()).toBeUndefined();
});
it.each(['truth','labels','freeze','finalization'])('rolls back the full revision when %s fails',async fault=>{
 const f=await prepared();const tables={truth:'governed_dataset_truth_links',labels:'governed_dataset_truth_link_labels',freeze:'governed_review_batch_events',finalization:'dataset_revision_finalizations'};
 f.db.exec(`CREATE TRIGGER test_fail_freeze BEFORE INSERT ON ${tables[fault as keyof typeof tables]} ${fault==='freeze'?"WHEN NEW.event_kind='frozen'":''} BEGIN SELECT RAISE(ABORT,'injected freeze failure'); END;`);
 expect(()=>freeze(f.db,f.actor,f.batchId,command)).toThrow(/injected freeze failure/);
 expect(f.db.prepare("SELECT count(*) n FROM dataset_revisions WHERE provenance_level='governed_blind'").get()?.n).toBe(0);expect(f.db.prepare('SELECT count(*) n FROM governed_dataset_truth_links').get()?.n).toBe(0);expect(f.db.prepare('SELECT state FROM governed_review_batch_states WHERE batch_id=?').get(f.batchId)?.state).toBe('resolved');
});

it('preserves numeric payload round trips without rebuilding reviewed evidence',async()=>{
 const f=await prepared(false,true),revisionId=freeze(f.db,f.actor,f.batchId,command);
 const rows=f.db.prepare('SELECT i.payload_snapshot,r.review_payload_snapshot FROM dataset_revision_items i JOIN governed_dataset_truth_links t ON t.dataset_revision_item_id=i.id JOIN governed_review_batch_items b ON b.id=t.batch_item_id JOIN governed_review_items r ON r.id=b.review_item_id WHERE i.revision_id=?').all(revisionId);
 expect(rows).toHaveLength(3);for(const row of rows){expect(JSON.parse(String(row.payload_snapshot))).toEqual(JSON.parse(String(row.review_payload_snapshot)));expect(JSON.parse(String(row.payload_snapshot)).input).toMatchObject({large:9007199254740992,fraction:0.12345678901234568,exponent:1e21});}
});

it('freezes adjudicated truth with its exact head and preserves cannot-determine representativeness limits',async()=>{
 const f=await governedConflictFixture(),{user}=await f.runtime.auth.api.signUpEmail({body:{email:'adjudicator@example.test',password:'synthetic-long-password',name:'Adjudicator'}});
 f.db.prepare('INSERT INTO project_members VALUES(?,?,?,?,?)').run('adjudicator',f.projectId,user.id,'owner',new Date().toISOString());
 transition(f.db,f.actor,f.batchId,'start_adjudication',{expectedStateVersion:2,idempotencyKey:'adjudicate'});
 const adjudicator={...f.actor,userId:user.id},adjudication=appendNonsealedGovernedAdjudication(f.db,adjudicator,f.batchId,f.batchItemId,{expectedHeadAdjudicationId:null,decision:'pass',basis:'Independent analysis',rationale:'Supported',idempotencyKey:'adjudication'});
 transition(f.db,f.actor,f.batchId,'finalize',{expectedStateVersion:3,idempotencyKey:'resolve'});
 const revisionId=freeze(f.db,f.actor,f.batchId,{expectedStateVersion:4,idempotencyKey:'freeze'});
 const truth=f.db.prepare('SELECT * FROM governed_dataset_truth_links WHERE dataset_revision_id=?').get(revisionId)!;
 expect(truth).toMatchObject({source_kind:'adjudication',adjudication_id:adjudication.adjudicationId,resolution_kind:'adjudicated',supporting_label_count:1,governed_label_ids:'[]'});
 expect(f.db.prepare('SELECT count(*) n FROM governed_dataset_truth_link_labels WHERE truth_link_id=?').get(truth.id!)?.n).toBe(0);
 const event=f.db.prepare("SELECT representative_ineligible_reasons FROM governed_review_batch_events WHERE batch_id=? AND event_kind='frozen'").get(f.batchId)!;
 expect(JSON.parse(String(event.representative_ineligible_reasons))).toEqual(['cannot_determine_present']);
 expect(()=>sqliteCommand(f.db,c=>{
  const old=c.db.prepare('SELECT * FROM governed_review_adjudications WHERE id=?').get(adjudication.adjudicationId)!,row:Record<string,SQLInputValue>={...old,id:'materialized-correction',chain_version:2,expected_previous_chain_version:1,supersedes_adjudication_id:adjudication.adjudicationId,correction_reason:'Correct decision',decision:'fail',idempotency_key:'materialized-correction',created_at:c.timestamp,created_command_token:c.token};
  row.content_digest=governedContentV1Digest('governed-review-adjudication/v1',{adjudicatorRoleAtReview:row.adjudicator_role_at_review,adjudicatorSubjectId:row.adjudicator_subject_id,basis:row.basis,batchId:row.batch_id,batchItemId:row.batch_item_id,chainVersion:row.chain_version,consideredLabelCount:row.considered_label_count,consideredLabelSetDigest:row.considered_label_set_digest,correctionReason:row.correction_reason,decision:row.decision,rationale:row.rationale,supersedesAdjudicationId:row.supersedes_adjudication_id});
  c.db.prepare(`INSERT INTO governed_review_adjudications(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?')})`).run(...Object.values(row));
 })).toThrow(/materialized truth requires protected successor correction/);
 expect(()=>appendNonsealedGovernedAdjudication(f.db,adjudicator,f.batchId,f.batchItemId,{expectedHeadAdjudicationId:adjudication.adjudicationId,decision:'fail',basis:'Changed',rationale:'Changed',correctionReason:'Changed',idempotencyKey:'late'})).toThrow(expect.objectContaining({code:'governed_review_transition_conflict'}));
});
it('rejects a stale command token even when two commands share the same timestamp',async()=>{
 const f=await governedDraftFixture(),batchId=createNonsealedGovernedDraft(f.db,f.actor,f.input),now=Date.now()+1000;
 initializeGovernedViewValidator(f.db);
 const previous=sqliteCommand(f.db,c=>({token:c.token,timestamp:c.timestamp}),()=>now);
 expect(()=>sqliteCommand(f.db,c=>{
  expect(c.timestamp).toBe(previous.timestamp);expect(c.token).not.toBe(previous.token);
  const subject=String(c.db.prepare('SELECT id FROM governed_reviewer_subjects WHERE project_id=? AND account_user_id=?').get(f.projectId,f.userId)!.id);
  const basis={actorRoleAtReview:'owner',actorSubjectId:subject,batchId,datasetRevisionId:null,details:{},eventKind:'open',previousEventDigest:null,representativeIneligibleReasons:[],representativeOfPopulationId:null,sequence:1,stateVersion:1};
  const row:Record<string,SQLInputValue>={id:'forged-token',project_id:f.projectId,batch_id:batchId,sequence:1,state_version:1,expected_previous_state_version:0,event_kind:'open',actor_subject_id:subject,actor_role_at_review:'owner',representative_ineligible_reasons:'[]',details:'{}',event_digest:governedContentV1Digest('governed-review-batch-event/v1',basis),request_digest:'sha256:'+'0'.repeat(64),created_command_token:previous.token,occurred_at:c.timestamp,idempotency_key:'forged-token'};
  c.db.prepare(`INSERT INTO governed_review_batch_events(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 },()=>now)).toThrow(/owning command token/);
});
import {interceptSqliteInsert} from './helpers/sqlite-insert-intercept.js';
async function twoRaterTruth(){
 const f=await governedDraftFixture(),{user}=await f.runtime.auth.api.signUpEmail({body:{email:'second-rater@example.test',password:'synthetic-long-password',name:'Rater'}});
 f.db.prepare('INSERT INTO project_members VALUES(?,?,?,?,?)').run('second-rater',f.projectId,user.id,'member',new Date().toISOString());
 const batchId=createNonsealedGovernedDraft(f.db,f.actor,{...f.input,reviewerUserIds:[f.userId,user.id]});
 transition(f.db,f.actor,batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});
 for(const task of f.db.prepare('SELECT t.id,s.account_user_id FROM governed_review_tasks t JOIN governed_reviewer_subjects s ON s.id=t.reviewer_subject_id WHERE t.batch_id=?').all(batchId)){
  const actor={...f.actor,userId:String(task.account_user_id),projectRole:task.account_user_id===f.userId?'owner' as const:'member' as const},view=getOrCreateNonsealedBlindView(f.db,actor,String(task.id));
  action(f.db,actor,String(task.id),{kind:'submit_label',input:{viewDigest:view.viewDigest,label:'pass',rationale:'Supported',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}});
 }
 transition(f.db,f.actor,batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});transition(f.db,f.actor,batchId,'finalize',{expectedStateVersion:2,idempotencyKey:'resolve'});
 return {...f,batchId};
}
it.each(['whitespace','reverse','omit','duplicate','foreign'])('validates truth label membership independently of JSON formatting: %s',async mode=>{
 const f=await twoRaterTruth();let transformed:string[]=[];
 const spy=interceptSqliteInsert(f.db,'governed_dataset_truth_links',row=>{
  const labels=JSON.parse(String(row.governed_label_ids)) as string[];expect(labels).toHaveLength(2);
  transformed=mode==='reverse'?[...labels].reverse():mode==='omit'?labels.slice(0,1):mode==='duplicate'?[labels[0]!,labels[0]!]:mode==='foreign'?[labels[0]!,'foreign']:labels;
  row.governed_label_ids=JSON.stringify(transformed,null,mode==='whitespace'?2:undefined);
  row.content_digest=governedContentV1Digest('governed-dataset-truth-link/v1',{adjudicationId:row.adjudication_id,batchItemId:row.batch_item_id,criterionVersionId:row.criterion_version_id,datasetRevisionId:row.dataset_revision_id,datasetRevisionItemId:row.dataset_revision_item_id,governedLabelIds:transformed,importedTruthId:row.imported_truth_id,resolutionKind:row.resolution_kind,resolvedLabel:row.resolved_label,sourceKind:row.source_kind,supportingLabelCount:row.supporting_label_count});return row;
 });
 try{
  if(mode==='whitespace'||mode==='reverse'){
   const revisionId=freeze(f.db,f.actor,f.batchId,command),truth=f.db.prepare('SELECT * FROM governed_dataset_truth_links WHERE dataset_revision_id=?').get(revisionId)!;
   expect(JSON.parse(String(truth.governed_label_ids))).toEqual(transformed);expect(f.db.prepare('SELECT count(*) n FROM governed_dataset_truth_link_labels WHERE truth_link_id=?').get(truth.id!)?.n).toBe(2);
  }else expect(()=>freeze(f.db,f.actor,f.batchId,command)).toThrow(/every exact active independent label/);
 }finally{spy.mockRestore();}
});
