import { InvalidProductionTimestampError, productionTimestamp } from './production-time.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PRODUCTION_DECISION_RECORD_CONTRACT, ProductionDecisionLedgerRecordSchema, ProductionCalibrationArtifactSchema } from '@rubrist/shared';
import { canonicalJson } from '../../lib/canonical-json.js';
import { governedContentV1Digest } from '../../lib/governed-content-digest.js';
import { prepareRecords, textDigest, deletionCounts, bytesDigest, snapshotSummary, snapshotTooLarge } from '../../production-calibration/storage-values.js';
import { PRODUCTION_RECORD_APPEND_MAX_RECORDS, PRODUCTION_SNAPSHOT_MAX_BYTES, ProductionRecordRepositoryError, type ProductionDecisionRecordRepository } from '../../production-calibration/repository.js';
import { evaluationDatabase, json, parse, type Row } from './evaluation-values.js';
import { sqliteLimit } from './query-values.js';
type Args<K extends keyof ProductionDecisionRecordRepository>=Parameters<ProductionDecisionRecordRepository[K]>;
export function sqliteProductionCommands(db:DatabaseSync) {
 const {one,all,run,transaction}=evaluationDatabase(db);let deletionAllowed=false;
 db.function('sqlite_production_deletion_allowed',()=>Number(deletionAllowed&&db.isTransaction));
 db.function('sqlite_production_timestamp',{deterministic:true},value=>productionTimestamp(String(value)));
 db.function('sqlite_production_text_digest',{deterministic:true},value=>textDigest(String(value)));
 db.function('sqlite_production_record_valid',{deterministic:true},(kind,decisionId,at,content,digest)=>{
  try {const value=ProductionDecisionLedgerRecordSchema.parse(parse(content));return Number(value.kind===kind&&(value.kind==='decision'?value.id:value.decisionId)===decisionId&&productionTimestamp(value.at)===at&&governedContentV1Digest(PRODUCTION_DECISION_RECORD_CONTRACT,value)===digest);}catch{return 0;}
 });
 db.function('sqlite_production_snapshot_valid',{deterministic:true},(data,digest,contract,from,to,built)=>{
  try {if(!(data instanceof Uint8Array))return 0;const bytes=Buffer.from(data),value=ProductionCalibrationArtifactSchema.parse(JSON.parse(bytes.toString('utf8')));
   const same=(a:unknown,b:unknown)=>a===null&&b===null||a!==null&&b!==null&&productionTimestamp(String(a))===productionTimestamp(String(b));
   return Number(bytesDigest(bytes)===digest&&canonicalJson(value)===bytes.toString('utf8')&&value.contract===contract&&same(value.window.from,from)&&same(value.window.to,to)&&same(value.generatedAt,built));
  }catch{return 0;}
 });
 function audit(projectId:string|null,userId:string|null,action:string,targetType:string,targetId:string,metadata:unknown,now:number) {run('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?,?)',`audit_${randomUUID()}`,projectId,userId,action,targetType,targetId,json(metadata),new Date(now).toISOString());}
 function transact<T>(work:(now:number)=>T,deleting=false):T {
  try {return transaction(now=>{deletionAllowed=deleting;try{return work(now);}finally{deletionAllowed=false;}});}catch(error){
   if(error instanceof Error&&/database is locked|database is busy/i.test(error.message))throw new ProductionRecordRepositoryError('write_contention','The batch collided with a concurrent write; retrying identical records is safe');throw error;
  }
 }
 function project(projectId:string) {const value=one('SELECT * FROM projects WHERE id=?',projectId);if(!value)throw new ProductionRecordRepositoryError('project_not_found','The project no longer exists');return value;}
 const summary=(row:Row)=>snapshotSummary({...row,parameters:parse(row.parameters)});
 // Repository input is typed at this boundary; database guards remain the backstop.
 function recordTimes(rows:ReturnType<typeof prepareRecords>) {
  const times=new Map<(typeof rows)[number],string>();
  for(const row of [...rows].sort((a,b)=>a.line-b.line)) {
   try {times.set(row,productionTimestamp(row.record_at));}
   catch(error) {if(error instanceof InvalidProductionTimestampError)throw new ProductionRecordRepositoryError('invalid_record',`Record ${row.line} is invalid`,{line:row.line});throw error;}
  }
  return times;
 }
 function windowBound(value:Date|string|null,bound:'from'|'to') {
  if(value===null)return null;
  try {return productionTimestamp(value instanceof Date?value.toISOString():value);}
  catch(error) {if(error instanceof InvalidProductionTimestampError||error instanceof RangeError)throw new ProductionRecordRepositoryError('invalid_window',`The window's ${bound} is not a valid time`,{bound});throw error;}
 }
 const commands={
  productionAppendRecords(input:Args<'appendRecords'>[0]) {
   if(!input.records.length)throw new ProductionRecordRepositoryError('empty_batch','The batch contains no records');
   if(input.records.length>PRODUCTION_RECORD_APPEND_MAX_RECORDS)throw new ProductionRecordRepositoryError('batch_too_large',`A batch may contain at most ${PRODUCTION_RECORD_APPEND_MAX_RECORDS} records`,{records:input.records.length,maximum:PRODUCTION_RECORD_APPEND_MAX_RECORDS});
   const rows=prepareRecords(input.records),times=recordTimes(rows);
   return transact(now=>{
    project(input.projectId);
    if(input.submitter.kind==='api_key'&&!one('SELECT 1 FROM api_keys WHERE project_id=? AND id=? AND revoked_at IS NULL',input.projectId,input.submitter.apiKeyId))throw new ProductionRecordRepositoryError('api_key_revoked','The API key was revoked while the request was in flight');
    const future=rows.filter(r=>times.get(r)!>productionTimestamp(new Date(now+5*60_000).toISOString())).sort((a,b)=>a.line-b.line)[0];
    if(future)throw new ProductionRecordRepositoryError('future_dated_record',`Record ${future.line} is dated more than five minutes after it was received`,{line:future.line});
    const erased=rows.filter(r=>one('SELECT 1 FROM production_decision_tombstones WHERE project_id=? AND decision_id_digest=?',input.projectId,textDigest(r.decision_id))).sort((a,b)=>a.line-b.line)[0];
    if(erased)throw new ProductionRecordRepositoryError('erased_decision',`Record ${erased.line} belongs to an erased decision`,{line:erased.line,decisionId:erased.decision_id});
    const inserted:Row[]=[];
    for(const row of rows) {
     const content=ProductionDecisionLedgerRecordSchema.safeParse(row.content);if(!content.success)throw new ProductionRecordRepositoryError('invalid_record',`Record ${row.line} is invalid`,{line:row.line});
     const existing=row.kind==='decision'?one("SELECT content_digest FROM production_decision_records WHERE project_id=? AND kind='decision' AND decision_id=?",input.projectId,row.decision_id):null;
     if(existing&&existing.content_digest!==row.content_digest)throw new ProductionRecordRepositoryError('conflicting_decision',`Record ${row.line} gives decision ${row.decision_id} different content`,{line:row.line,decisionId:row.decision_id});
     if(run(`INSERT INTO production_decision_records(id,project_id,kind,decision_id,record_at,content,content_digest,submitted_by_api_key_id,submitted_by_user_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,row.id,input.projectId,row.kind,row.decision_id,times.get(row)!,json(row.content),row.content_digest,input.submitter.kind==='api_key'?input.submitter.apiKeyId:null,input.submitter.kind==='user'?input.submitter.userId:null).changes)inserted.push(row);
    }
    return {inserted:deletionCounts(inserted as {kind:string}[]),duplicates:input.records.length-inserted.length,awaitingDecision:rows.filter(row=>row.kind!=='decision'&&!one("SELECT 1 FROM production_decision_records WHERE project_id=? AND kind='decision' AND decision_id=?",input.projectId,row.decision_id)).length};
   });
  },
  productionLoadRecords(input:Args<'loadRecords'>[0]) {
   const lower=windowBound(input.window.from,'from'),upper=windowBound(input.window.to,'to');
   const max=sqliteLimit(input.maxRecords),from=input.window.from?.toISOString()??null,to=input.window.to?.toISOString()??null;
   const rows=all(`WITH window_decisions AS(SELECT decision_id FROM production_decision_records WHERE project_id=? AND kind='decision' AND (? IS NULL OR record_at>=?) AND (? IS NULL OR record_at<?))
    SELECT * FROM production_decision_records r WHERE r.project_id=? AND (r.decision_id IN (SELECT decision_id FROM window_decisions) OR
    (r.kind<>'decision' AND (? IS NULL OR r.record_at>=?) AND (? IS NULL OR r.record_at<?) AND NOT EXISTS(SELECT 1 FROM production_decision_records d WHERE d.project_id=r.project_id AND d.kind='decision' AND d.decision_id=r.decision_id))) ORDER BY record_at,received_at,content_digest LIMIT ?`,input.projectId,lower,lower,upper,upper,input.projectId,lower,lower,upper,upper,max+1);
   if(rows.length>max)throw new ProductionRecordRepositoryError('record_ceiling_exceeded',`The window holds more than ${max} records; choose a narrower window`,{maximum:max,from,to});
   return {records:rows.map(row=>ProductionDecisionLedgerRecordSchema.parse(parse(row.content))),recordSetDigest:governedContentV1Digest('rubrist/production-record-set/v1',rows.map(row=>row.content_digest).sort())};
  },
  productionSaveSnapshot(input:Args<'saveSnapshot'>[0]) {return transact(now=>{
   windowBound(input.artifact.window.from,'from');windowBound(input.artifact.window.to,'to');
   project(input.projectId);const bytes=Buffer.from(canonicalJson(input.artifact),'utf8');if(bytes.length>PRODUCTION_SNAPSHOT_MAX_BYTES)throw snapshotTooLarge(bytes.length);
   const id=`pcs_${randomUUID()}`;run('INSERT INTO production_calibration_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',id,input.projectId,input.artifact.contract,bytes,bytesDigest(bytes),input.artifact.window.from,input.artifact.window.to,json(input.parameters),input.recordCount,input.recordSetDigest,input.artifact.generatedAt,input.userId,new Date(now).toISOString());
   return summary(one('SELECT * FROM production_calibration_snapshots WHERE id=?',id)!);
  });},
  productionListSnapshots(projectId:string) {return all('SELECT * FROM production_calibration_snapshots WHERE project_id=? ORDER BY created_at DESC,id DESC',projectId).map(summary);},
  productionGetSnapshot(projectId:string,snapshotId:string) {
   const row=one('SELECT * FROM production_calibration_snapshots WHERE project_id=? AND id=?',projectId,snapshotId);if(!row)return null;
   const bytes=Buffer.from(row.canonical_bytes);if(bytesDigest(bytes)!==row.artifact_digest)throw new Error(`Production calibration snapshot ${snapshotId} no longer matches its digest`);
   return {snapshot:summary(row),artifact:ProductionCalibrationArtifactSchema.parse(JSON.parse(bytes.toString('utf8')))};
  },
  productionGetRetentionDays(projectId:string) {return Number(project(projectId).production_record_retention_days);},
  productionSetRetentionDays(input:Args<'setRetentionDays'>[0]) {return transact(now=>{
   project(input.projectId);run('UPDATE projects SET production_record_retention_days=?,updated_at=? WHERE id=?',input.retentionDays,new Date(now).toISOString(),input.projectId);
   audit(input.projectId,input.userId,'production.retention.update','project',input.projectId,{retentionDays:input.retentionDays},now);return input.retentionDays;
  });},
  productionApplyRetention(at:Date) {return transact(now=>{
   const projects=[];
   for(const p of all('SELECT id,production_record_retention_days FROM projects ORDER BY id')) {
    const cutoff=new Date(at.getTime()-p.production_record_retention_days*86400000).toISOString();
    // Freeze candidate IDs before deleting decisions, so their children cannot
    // change from attached rows into independently retained orphans mid-delete.
    const expired=all(`SELECT r.id FROM production_decision_records r WHERE r.project_id=? AND (EXISTS(SELECT 1 FROM production_decision_records d WHERE d.project_id=r.project_id AND d.decision_id=r.decision_id AND d.kind='decision' AND julianday(d.received_at)<julianday(?)) OR (r.kind<>'decision' AND julianday(r.received_at)<julianday(?) AND NOT EXISTS(SELECT 1 FROM production_decision_records d WHERE d.project_id=r.project_id AND d.decision_id=r.decision_id AND d.kind='decision')))`,p.id,cutoff,cutoff).map(r=>r.id);
    if(!expired.length)continue;
    const deleted=deletionCounts(all('DELETE FROM production_decision_records WHERE project_id=? AND id IN (SELECT value FROM json_each(?)) RETURNING kind',p.id,json(expired)) as {kind:string}[]);
    projects.push({projectId:String(p.id),cutoff,deleted});audit(p.id,null,'production.retention.apply','project',p.id,{cutoff,deleted},now);
   }
   const deleted=projects.reduce((sum,p)=>({decisions:sum.decisions+p.deleted.decisions,actions:sum.actions+p.deleted.actions,outcomes:sum.outcomes+p.deleted.outcomes}),{decisions:0,actions:0,outcomes:0});
   audit(null,null,'production.retention.run','production_retention_run',at.toISOString(),{at:at.toISOString(),projectsWithDeletions:projects.length,deleted},now);return {skipped:false,projects};
  },true);},
  productionEraseDecision(input:Args<'eraseDecision'>[0]) {return transact(now=>{
   project(input.projectId);const digest=textDigest(input.decisionId),rows=all('DELETE FROM production_decision_records WHERE project_id=? AND decision_id=? RETURNING kind,content_digest',input.projectId,input.decisionId);
   run('INSERT INTO production_decision_tombstones VALUES(?,?,?,?) ON CONFLICT DO NOTHING',input.projectId,digest,input.userId,new Date(now).toISOString());
   const deleted=deletionCounts(rows as {kind:string}[]);audit(input.projectId,input.userId,'production.decision.erase','production_decision',digest,{decisionIdDigest:digest,erasedRecordDigests:rows.map(row=>row.content_digest).sort(),deleted},now);return deleted;
  },true);},
  productionPurgeApiKeyRecords(input:Args<'purgeApiKeyRecords'>[0]) {return transact(now=>{
   const key=one('SELECT revoked_at FROM api_keys WHERE project_id=? AND id=?',input.projectId,input.apiKeyId);
   if(!key)throw new ProductionRecordRepositoryError('api_key_not_found','No such API key in this project');if(!key.revoked_at)throw new ProductionRecordRepositoryError('api_key_not_revoked','Revoke the API key before purging what it sent');
   const deleted=deletionCounts(all('DELETE FROM production_decision_records WHERE project_id=? AND submitted_by_api_key_id=? RETURNING kind',input.projectId,input.apiKeyId) as {kind:string}[]);
   audit(input.projectId,input.userId,'production.api_key.purge','api_key',input.apiKeyId,{deleted},now);return deleted;
  },true);},
  productionDeleteSnapshot(input:Args<'deleteSnapshot'>[0]) {return transact(now=>{
   const row=one('DELETE FROM production_calibration_snapshots WHERE project_id=? AND id=? RETURNING artifact_digest',input.projectId,input.snapshotId);if(!row)return false;
   audit(input.projectId,input.userId,'production.snapshot.delete','production_snapshot',input.snapshotId,{artifactDigest:row.artifact_digest},now);return true;
  },true);}
 };
 return commands;
}
