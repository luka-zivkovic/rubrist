import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RubristRepository } from '../../repository.js';
import { DatasetRevisionConflictError } from '../../repository/errors.js';
import { rowToImportJobRecord } from '../../repository.pg/mappers.js';
import { evaluationDatabase } from './evaluation-values.js';
import { sqliteDefinitionCommands } from './definition-commands.js';
import { sqliteLimit } from './query-values.js';
type Args<K extends keyof RubristRepository>=Parameters<RubristRepository[K]>;
export function sqliteImportJobCommands(db:DatabaseSync) {
 const {one,all,run,transaction}=evaluationDatabase(db),definitions=sqliteDefinitionCommands(db);
 const query='SELECT i.*,u.email actor_email,u.name actor_name FROM import_jobs i LEFT JOIN "user" u ON u.id=i.actor_user_id';
 function load(projectId:string,id:string) {const row=one(`${query} WHERE i.project_id=? AND i.id=?`,projectId,id);if(!row)throw new Error(`Import job not found: ${id}`);return rowToImportJobRecord(row);}
 function changed(changes:number|bigint,id:string) {if(!changes)throw new Error(`Import job not found: ${id}`);}
 return {
  createImportJob(input:Args<'createImportJob'>[0]) {
   const id=`import_${randomUUID()}`,skillVersionId=input.skillVersionId??definitions.getCurrentSkill(input.projectId).currentVersion.id;
   if(!definitions.getSkillVersion(input.projectId,skillVersionId))throw new DatasetRevisionConflictError(`Unknown import skillVersionId for this project: ${skillVersionId}`);
   definitions.authorizeSkillVersionExecution({projectId:input.projectId,skillVersionId,context:input.sourceIntegrationId?'scheduled_import':'manual_import',resourceKind:'import_job',resourceId:id,idempotencyKey:`import-job:${id}:${skillVersionId}`});
   return transaction(now=>{run(`INSERT INTO import_jobs(id,project_id,status,source,source_integration_id,actor_user_id,requested_limit,skill_version_id,created_at) VALUES(?,?,'queued',?,?,?,?,?,?)`,id,input.projectId,input.source,input.sourceIntegrationId??null,input.actorUserId??null,input.requestedLimit??null,skillVersionId,new Date(now).toISOString());return load(input.projectId,id);});
  },
  markImportJobQueued(projectId:string,id:string,queueJobId:string) {return transaction(()=>{changed(run("UPDATE import_jobs SET queue_job_id=?,status='queued',error=NULL WHERE project_id=? AND id=?",queueJobId,projectId,id).changes,id);return load(projectId,id);});},
  markImportJobRunning(projectId:string,id:string) {changed(run("UPDATE import_jobs SET status='running',started_at=?,error=NULL WHERE project_id=? AND id=?",new Date().toISOString(),projectId,id).changes,id);},
  markImportJobCompleted(projectId:string,id:string,result:Args<'markImportJobCompleted'>[2]) {changed(run("UPDATE import_jobs SET status='completed',completed_at=?,imported_count=(SELECT count(*) FROM raw_traces WHERE project_id=? AND import_job_id=?),queued_judge_count=?,error=NULL WHERE project_id=? AND id=?",new Date().toISOString(),projectId,id,result.queuedJudgeCount,projectId,id).changes,id);},
  markImportJobFailed(projectId:string,id:string,error:unknown) {return transaction(()=>{changed(run("UPDATE import_jobs SET status='failed',completed_at=?,error=? WHERE project_id=? AND id=?",new Date().toISOString(),error instanceof Error?error.message:String(error),projectId,id).changes,id);return load(projectId,id);});},
  listImportJobs(input:Args<'listImportJobs'>[0]) {return all(`${query} WHERE i.project_id=? AND(? IS NULL OR i.status=?) ORDER BY i.created_at DESC,i.id DESC LIMIT ?`,input.projectId,input.status??null,input.status??null,sqliteLimit(input.limit)).map(rowToImportJobRecord);},
  findImportedIronsideTraces(input:Args<'findImportedIronsideTraces'>[0]) {
   if(!input.projectIds.length)return [];
   return all(`WITH ranked AS (SELECT rt.project_id,c.id case_id,rt.source_trace_version,c.created_at,row_number() OVER(PARTITION BY rt.project_id,rt.source_trace_version ORDER BY c.created_at,c.id) rank
    FROM raw_traces rt JOIN cases c ON c.raw_trace_id=rt.id AND c.project_id=rt.project_id WHERE rt.project_id IN (SELECT value FROM json_each(?)) AND rt.source_remote_project_id=? AND rt.source_trace_id=? AND c.case_type='ironside')
    SELECT * FROM ranked WHERE rank=1 ORDER BY project_id,source_trace_version IS NULL,source_trace_version LIMIT 500`,JSON.stringify(input.projectIds),input.remoteProjectId,input.traceId).map(row=>({projectId:String(row.project_id),caseId:String(row.case_id),traceVersion:row.source_trace_version as string|null,importedAt:String(row.created_at)}));
  }
 };
}
