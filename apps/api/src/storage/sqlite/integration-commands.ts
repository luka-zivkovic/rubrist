import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { IronsideSyncStateSchema } from '@rubrist/shared';
import type { RubristRepository } from '../../repository.js';
import * as errors from '../../repository/errors.js';
import { encryptJson, decryptJson } from '../../lib/encryption.js';
// These existing mappers are pure value conversion, with no PG connection or SQL.
import { rowToLangSmithIntegration, rowToLangfuseIntegration, rowToIronsideIntegration } from '../../repository.pg/mappers.js';
import { evaluationDatabase, type Row } from './evaluation-values.js';
import { sqliteDefinitionCommands } from './definition-commands.js';
import { sqliteLimit } from './query-values.js';
type Args<K extends keyof RubristRepository>=Parameters<RubristRepository[K]>;
type Provider='langsmith'|'langfuse'|'ironside';
export function sqliteIntegrationCommands(db:DatabaseSync) {
 const {one,all,run,transaction}=evaluationDatabase(db),definitions=sqliteDefinitionCommands(db);
 const missing={langsmith:errors.LangSmithIntegrationNotFoundError,langfuse:errors.LangfuseIntegrationNotFoundError,ironside:errors.IronsideIntegrationNotFoundError};
 const credentialsMissing={langsmith:errors.LangSmithCredentialsMissingError,langfuse:errors.LangfuseCredentialsMissingError,ironside:errors.IronsideCredentialsMissingError};
 const mappers={langsmith:rowToLangSmithIntegration,langfuse:rowToLangfuseIntegration,ironside:rowToIronsideIntegration};
 function map<P extends Provider>(provider:P,row:Row):ReturnType<typeof mappers[P]> {return mappers[provider]({...row,poll_enabled:Boolean(row.poll_enabled)}) as ReturnType<typeof mappers[P]>;}
 function get(provider:Provider,projectId:string,id:string) {const row=one('SELECT * FROM integrations WHERE project_id=? AND id=? AND provider=?',projectId,id,provider);if(!row)throw new missing[provider](id);return row;}
 function resolve(projectId:string,requested?:string,allowEmpty=false) {
  let versionId:string;
  if(requested) {if(!definitions.getSkillVersion(projectId,requested))throw new errors.DatasetRevisionConflictError(`Unknown import skillVersionId for this project: ${requested}`);versionId=requested;}
  else {try{versionId=definitions.getCurrentSkill(projectId).currentVersion.id;}catch(error){if(allowEmpty&&error instanceof errors.NoCurrentSkillError)return null;throw error;}}
  if(!one("SELECT 1 FROM skill_versions v JOIN criteria c ON c.project_id=v.project_id AND c.id=v.criterion_id WHERE v.project_id=? AND v.id=? AND EXISTS(SELECT 1 FROM evaluator_lifecycle_contexts lc WHERE lc.project_id=v.project_id AND lc.skill_version_id=v.id AND lc.implicit_allowed=1)",projectId,versionId))throw new errors.DatasetRevisionConflictError('Evaluator version is not eligible for scheduled import');
  return versionId;
 }
 function create<P extends 'langsmith'|'langfuse'>(provider:P,projectId:string,input:Args<'createLangSmithIntegration'>[1]|Args<'createLangfuseIntegration'>[1]) {return transaction(now=>{
  const config={projectName:'projectName' in input?input.projectName??null:null,endpointUrl:input.endpointUrl??null,redaction:input.redaction??{},skillVersionId:resolve(projectId,input.skillVersionId,true)};
  const credentials='apiKey' in input?{apiKey:input.apiKey}:{publicKey:input.publicKey,secretKey:input.secretKey};
  const row=one(`INSERT INTO integrations(id,project_id,provider,encrypted_credentials,config,created_at,poll_enabled,poll_interval_seconds,poll_limit) VALUES(?,?,?,?,?,?,?,?,?)
   ON CONFLICT(project_id,provider) DO UPDATE SET encrypted_credentials=excluded.encrypted_credentials,config=excluded.config,poll_enabled=excluded.poll_enabled,poll_interval_seconds=excluded.poll_interval_seconds,poll_limit=excluded.poll_limit,last_tested_at=NULL,last_test_result=NULL RETURNING *`,
   `int_${randomUUID()}`,projectId,provider,encryptJson(credentials),JSON.stringify(config),new Date(now).toISOString(),Number(input.pollEnabled??true),input.pollIntervalSeconds??300,input.pollLimit??25)!;
  run("UPDATE projects SET mode='tracing',updated_at=? WHERE id=? AND mode<>'tracing'",new Date(now).toISOString(),projectId);return map(provider,row);
 });}
 function list<P extends Provider>(provider:P,projectId:string) {return all('SELECT * FROM integrations WHERE project_id=? AND provider=? ORDER BY created_at DESC,id DESC',projectId,provider).map(row=>map(provider,row));}
 function update<P extends 'langsmith'|'langfuse'>(provider:P,projectId:string,id:string,input:Args<'updateLangSmithIntegration'>[2]) {return transaction(()=>{
  const row=get(provider,projectId,id),config=JSON.parse(row.config);if(input.skillVersionId!==undefined)config.skillVersionId=resolve(projectId,input.skillVersionId);
  return map(provider,one('UPDATE integrations SET poll_enabled=?,poll_interval_seconds=?,poll_limit=?,config=? WHERE id=? RETURNING *',Number(input.pollEnabled??Boolean(row.poll_enabled)),input.pollIntervalSeconds??row.poll_interval_seconds,input.pollLimit??row.poll_limit,JSON.stringify(config),id)!);
 });}
 function record(provider:Provider,projectId:string,id:string,result:Args<'recordLangSmithConnectionTest'>[2]|Args<'recordLangfuseConnectionTest'>[2]|Args<'recordIronsideConnectionTest'>[2]) {
  if(!run('UPDATE integrations SET last_tested_at=?,last_test_result=? WHERE project_id=? AND id=? AND provider=?',result.checkedAt,JSON.stringify(result),projectId,id,provider).changes)throw new missing[provider](id);
 }
 function remove(provider:Provider,projectId:string,id:string,context:{actorUserId?:string|undefined}) {transaction(now=>{
  const row=get(provider,projectId,id);
  // The import migration supplies the nullable FK; deletion clears only this
  // live connection pointer, preserving the retained remote trace identity.
  run('DELETE FROM integrations WHERE project_id=? AND id=?',projectId,id);
  run('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?,?)',`audit_${randomUUID()}`,projectId,context.actorUserId??null,'integration.delete','integration',id,JSON.stringify({provider,config:JSON.parse(row.config)}),new Date(now).toISOString());
 });}
 function claim(provider:Provider,input:Args<'claimDueLangSmithImportTargets'>[0]) {return transaction(()=>{
  const now=input.now.toISOString(),rows=all(`SELECT * FROM integrations i WHERE provider=? AND poll_enabled=1
   AND (?<>'ironside' OR json_extract(config,'$.revalidationRequired')=0)
   AND EXISTS(SELECT 1 FROM skill_versions v WHERE v.project_id=i.project_id)
   AND(last_polled_at IS NULL OR julianday(last_polled_at)<=julianday(?)-poll_interval_seconds/86400.0)
   ORDER BY last_polled_at,created_at,id LIMIT ?`,provider,provider,now,sqliteLimit(input.batchSize));
  const targets=[];
  for(const row of rows) {
   run('UPDATE integrations SET last_polled_at=? WHERE id=?',now,row.id);
   const limit=Math.max(1,Math.min(row.poll_limit??input.defaultLimit,100));
   try {targets.push({projectId:String(row.project_id),integrationId:String(row.id),skillVersionId:resolve(row.project_id,JSON.parse(row.config).skillVersionId??undefined)!,limit});}
   catch(error) {
    if(!(error instanceof errors.AmbiguousProjectSkillError)&&!(error instanceof errors.DatasetRevisionConflictError)&&!(error instanceof errors.NoCurrentSkillError))throw error;
    run(`INSERT INTO import_jobs(id,project_id,status,source,source_integration_id,requested_limit,created_at,completed_at,error) VALUES(?,?,'failed',?,?,?,?,?,?)`,
     `import_${randomUUID()}`,row.project_id,provider,row.id,limit,now,now,`${error instanceof errors.DatasetRevisionConflictError?'invalid_skill_version':'skill_version_required'}: configure an exact evaluator version before scheduled import`);
   }
  }
  return targets;
 });}
 function load<P extends Provider>(provider:P,job:Args<'loadLangSmithImportContext'>[0]) {
  const row=get(provider,job.projectId,job.integrationId),config=JSON.parse(row.config),credentials=decryptJson<Record<string,string>>(row.encrypted_credentials);
  if(provider==='langfuse'?!credentials.publicKey||!credentials.secretKey:!credentials.apiKey)throw new credentialsMissing[provider](job.integrationId);
  if(job.skillVersionId)definitions.authorizeSkillVersionExecution({projectId:job.projectId,skillVersionId:job.skillVersionId,context:'scheduled_import',resourceKind:`${provider}_import`,resourceId:job.importJobId??job.integrationId,idempotencyKey:`provider-start:${provider}:${job.importJobId??job.integrationId}:${job.skillVersionId}`});
  return {...map(provider,row),skillVersionId:job.skillVersionId??config.skillVersionId??null,...credentials,limit:job.limit,redactionConfig:config.redaction??{},...(provider==='ironside'?{syncState:IronsideSyncStateSchema.parse(config.sync),connectionRevision:config.connectionRevision,revalidationRequired:config.revalidationRequired}:{})};
 }
 return {
  createLangSmithIntegration:(...args:Args<'createLangSmithIntegration'>)=>create('langsmith',...args),
  createLangfuseIntegration:(...args:Args<'createLangfuseIntegration'>)=>create('langfuse',...args),
  listLangSmithIntegrations:(projectId:string)=>list('langsmith',projectId),
  listLangfuseIntegrations:(projectId:string)=>list('langfuse',projectId),
  listIronsideIntegrations:(projectId:string)=>list('ironside',projectId),
  updateLangSmithIntegration:(...args:Args<'updateLangSmithIntegration'>)=>update('langsmith',...args),
  updateLangfuseIntegration:(...args:Args<'updateLangfuseIntegration'>)=>update('langfuse',...args),
  recordLangSmithConnectionTest:(...args:Args<'recordLangSmithConnectionTest'>)=>record('langsmith',...args),
  recordLangfuseConnectionTest:(...args:Args<'recordLangfuseConnectionTest'>)=>record('langfuse',...args),
  recordIronsideConnectionTest:(...args:Args<'recordIronsideConnectionTest'>)=>record('ironside',...args),
  deleteLangSmithIntegration:(...args:Args<'deleteLangSmithIntegration'>)=>remove('langsmith',...args),
  deleteLangfuseIntegration:(...args:Args<'deleteLangfuseIntegration'>)=>remove('langfuse',...args),
  deleteIronsideIntegration:(...args:Args<'deleteIronsideIntegration'>)=>remove('ironside',...args),
  claimDueLangSmithImportTargets:(input:Args<'claimDueLangSmithImportTargets'>[0])=>claim('langsmith',input),
  claimDueLangfuseImportTargets:(input:Args<'claimDueLangfuseImportTargets'>[0])=>claim('langfuse',input),
  claimDueIronsideImportTargets:(input:Args<'claimDueIronsideImportTargets'>[0])=>claim('ironside',input),
  loadLangSmithImportContext:(job:Args<'loadLangSmithImportContext'>[0])=>load('langsmith',job) as Awaited<ReturnType<RubristRepository['loadLangSmithImportContext']>>,
  loadLangfuseImportContext:(job:Args<'loadLangfuseImportContext'>[0])=>load('langfuse',job) as Awaited<ReturnType<RubristRepository['loadLangfuseImportContext']>>,
  loadIronsideImportContext:(job:Args<'loadIronsideImportContext'>[0])=>load('ironside',job) as Awaited<ReturnType<RubristRepository['loadIronsideImportContext']>>,
  createIronsideIntegration(projectId:Args<'createIronsideIntegration'>[0],input:Args<'createIronsideIntegration'>[1],remote:Args<'createIronsideIntegration'>[2]) {return transaction(now=>{
   const stamp=new Date(now).toISOString(),config={url:input.url,...(input.webUrl?{webUrl:input.webUrl}:{}),redaction:input.redaction??{},remoteProjectId:remote.project.id,remoteProjectName:remote.project.name,protocolVersion:remote.protocolVersion,settlementQuietPeriodSeconds:remote.settlement.quietPeriodSeconds,revalidationRequired:false,connectionRevision:1,skillVersionId:input.skillVersionId===undefined?null:resolve(projectId,input.skillVersionId),sync:{cursor:null}};
   const row=one(`INSERT INTO integrations(id,project_id,provider,encrypted_credentials,config,created_at,poll_enabled,poll_interval_seconds,poll_limit) VALUES(?,?,'ironside',?,?,?,?,?,?) ON CONFLICT(project_id,provider) DO NOTHING RETURNING *`,`int_${randomUUID()}`,projectId,encryptJson({apiKey:input.apiKey}),JSON.stringify(config),stamp,Number(input.pollEnabled??true),input.pollIntervalSeconds??300,input.pollLimit??25);
   if(!row)throw new errors.IronsideIntegrationAlreadyExistsError(projectId);
   run("UPDATE projects SET mode='tracing',updated_at=? WHERE id=? AND mode<>'tracing'",stamp,projectId);return map('ironside',row);
  });},
  updateIronsideIntegration(...[projectId,id,input,remote,expected]:Args<'updateIronsideIntegration'>) {return transaction(now=>{
   const row=get('ironside',projectId,id),config=JSON.parse(row.config);
   if(expected&&(config.remoteProjectId!==expected.remoteProjectId||config.revalidationRequired!==expected.revalidationRequired||config.connectionRevision!==expected.connectionRevision))throw new errors.IronsideIntegrationChangedError(id);
   if(input.skillVersionId!==undefined)config.skillVersionId=resolve(projectId,input.skillVersionId);
   if(input.url!==undefined)config.url=input.url;
   if(input.webUrl!==undefined)config.webUrl=input.webUrl;
   if(remote)Object.assign(config,{remoteProjectId:remote.project.id,remoteProjectName:remote.project.name,protocolVersion:remote.protocolVersion,settlementQuietPeriodSeconds:remote.settlement.quietPeriodSeconds,connectionRevision:config.connectionRevision+1,revalidationRequired:false,revalidatedAt:new Date(now).toISOString()});
   return map('ironside',one('UPDATE integrations SET poll_enabled=?,poll_interval_seconds=?,poll_limit=?,encrypted_credentials=?,config=? WHERE id=? RETURNING *',Number(input.pollEnabled??Boolean(row.poll_enabled)),input.pollIntervalSeconds??row.poll_interval_seconds,input.pollLimit??row.poll_limit,input.apiKey===undefined?row.encrypted_credentials:encryptJson({apiKey:input.apiKey}),JSON.stringify(config),id)!);
  });},
  quarantineIronsideIntegration(...[projectId,id,expected,result]:Args<'quarantineIronsideIntegration'>) {return transaction(()=>{
   const row=get('ironside',projectId,id),config=JSON.parse(row.config);
   if(config.remoteProjectId!==expected.remoteProjectId||config.connectionRevision!==expected.connectionRevision)return false;
   Object.assign(config,{connectionRevision:config.connectionRevision+1,revalidationRequired:true,quarantinedAt:result.checkedAt,quarantineReason:result.error??'remote project mismatch'});
   run('UPDATE integrations SET poll_enabled=0,last_tested_at=?,last_test_result=?,config=? WHERE id=?',result.checkedAt,JSON.stringify(result),JSON.stringify(config),id);return true;
  });},
  saveIronsideSyncState(...[projectId,id,state,expectedCursor]:Args<'saveIronsideSyncState'>) {return transaction(()=>{
   const row=one("SELECT * FROM integrations WHERE project_id=? AND id=? AND provider='ironside'",projectId,id);
   if(!row){if(expectedCursor!==undefined)return false;throw new errors.IronsideIntegrationNotFoundError(id);}
   const config=JSON.parse(row.config);
   if(expectedCursor!==undefined&&(config.sync?.cursor??null)!==expectedCursor)return false;
   config.sync=IronsideSyncStateSchema.parse(state);run('UPDATE integrations SET config=? WHERE id=?',JSON.stringify(config),id);return true;
  });}
 };
}
