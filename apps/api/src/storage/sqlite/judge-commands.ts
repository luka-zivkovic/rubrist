import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { JudgeRunSchema, VerdictRecordSchema, type EvaluatorExecutionContext } from '@rubrist/shared';
import type { RubristRepository } from '../../repository.js';
import { redactNormalizedTracePayload } from '../../lib/redaction.js';
import { sqliteDefinitionCommands } from './definition-commands.js';
import { camel, evaluationDatabase, json, parse, verdict } from './evaluation-values.js';
import { sqliteLimit } from './query-values.js';
type Args<K extends keyof RubristRepository> = Parameters<RubristRepository[K]>;
export function sqliteJudgeCommands(db:DatabaseSync) {
  const {one,all,run,transaction}=evaluationDatabase(db),definitions=sqliteDefinitionCommands(db);
  return {
    loadJudgeRunContext(job:Args<'loadJudgeRunContext'>[0]) {
      const row=one('SELECT * FROM cases WHERE project_id=? AND id=?',job.projectId,job.caseId);
      if(!row) throw new Error('Case not found for judge job');
      const skillVersion=job.skillVersionId?definitions.getSkillVersion(job.projectId,job.skillVersionId):definitions.getCurrentSkill(job.projectId).currentVersion;
      if(!skillVersion) throw new Error('Skill version not found for judge job');
      let context:EvaluatorExecutionContext,resourceKind:string,resourceId:string;
      if(job.evalRunId) {
        const owner=one('SELECT * FROM eval_runs WHERE project_id=? AND id=? AND skill_version_id=?',job.projectId,job.evalRunId,skillVersion.id);
        if(!owner || (job.evalRunItemId&&!one('SELECT 1 FROM eval_run_items WHERE project_id=? AND eval_run_id=? AND id=? AND case_id=?',job.projectId,job.evalRunId,job.evalRunItemId,job.caseId))) throw new Error('Eval run item does not match judge job');
        context=owner.trigger==='release_evidence'?'release_gate':owner.trigger==='manual'?'explicit_nonproduction_dataset':'manual_import';resourceKind='eval_run_item';resourceId=job.evalRunItemId??job.evalRunId;
      } else {
        context=row.ingestion_purpose==='release_evidence'?'release_gate':row.ingestion_purpose==='judge_api'?'implicit_production':row.ingestion_purpose==='trace_test_synthetic'?'trace_test':'manual_import';resourceKind='case';resourceId=job.caseId;
      }
      definitions.authorizeSkillVersionExecution({projectId:job.projectId,skillVersionId:skillVersion.id,context,resourceKind,resourceId,idempotencyKey:`provider-start:${context}:${resourceKind}:${resourceId}:${skillVersion.id}`});
      const payload=redactNormalizedTracePayload(parse(row.normalized_payload));
      return {projectId:job.projectId,caseId:job.caseId,skillVersion,trace:{id:job.caseId,input:payload.input??payload,output:payload.output??payload,metadata:payload.metadata??{},...(payload.steps?{steps:payload.steps}:{})}};
    },
    recordJudgeRun(input:Args<'recordJudgeRun'>[0]) { return transaction(now=> {
      let row=one('SELECT * FROM judge_runs WHERE project_id=? AND case_id=? AND skill_version_id=?',input.projectId,input.caseId,input.skillVersionId);
      if(!row) {
        row=one(`INSERT INTO judge_runs(id,project_id,case_id,skill_version_id,verdict,score,reasoning,raw_request,raw_response,created_at,latency_ms,input_tokens,output_tokens,provider_metadata)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,`judge_${randomUUID()}`,input.projectId,input.caseId,input.skillVersionId,input.verdict.label,input.verdict.score,input.verdict.reason??null,json(input.rawRequest??{}),json(input.rawResponse??input.verdict),new Date(now).toISOString(),input.latencyMs??null,input.inputTokens??null,input.outputTokens??null,json(input.providerMetadata))!;
        run(`UPDATE projects SET auto_judged_trace_count=auto_judged_trace_count+1,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM cases WHERE id=? AND case_type<>'release_evidence') AND NOT EXISTS(SELECT 1 FROM judge_runs WHERE project_id=? AND case_id=? AND id<>?)`,new Date(now).toISOString(),input.projectId,input.caseId,input.projectId,input.caseId,row.id);
      }
      return JudgeRunSchema.parse({...camel(row),latencyMs:row.latency_ms??undefined,providerMetadata:parse(row.provider_metadata)??undefined});
    }); },
    recordVerdict(input:Args<'recordVerdict'>[0]) { return transaction(now=> {
      if(input.source!=='llm_judge'||input.actorUserId||input.externalRunId||input.reviewContext) throw new Error('SQLite non-evaluator verdict workflow unavailable at this stage');
      const value=VerdictRecordSchema.parse({...input,id:`verdict_${randomUUID()}`,actorUserId:null,actorName:null,externalRunId:null,observed:input.observed??null,evaluatorScore:input.evaluatorScore??null,createdAt:new Date(now).toISOString()});
      const row=one(`INSERT INTO verdicts(id,project_id,case_id,skill_version_id,source,verdict_kind,payload,created_at,observed,evaluator_score) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING *`,value.id,value.projectId,value.caseId,value.skillVersionId,'llm_judge',value.payload.kind,json(value.payload),value.createdAt,json(value.observed),json(value.evaluatorScore))!;
      return verdict(row);
    }); },
    listVerdicts(input:Args<'listVerdicts'>[0]) {
      const filters=['v.project_id=?'];const params=[input.projectId];
      for(const [column,value] of [['v.case_id',input.caseId],['v.source',input.source],['v.skill_version_id',input.skillVersionId],['s.criterion_id',input.criterionId]]) if(value) { filters.push(`${column}=?`);params.push(value); }
      if(input.evidenceScope==='customer') filters.push("c.case_type<>'release_evidence'");
      return all(`SELECT v.* FROM verdicts v JOIN cases c ON c.id=v.case_id AND c.project_id=v.project_id JOIN skill_versions sv ON sv.id=v.skill_version_id JOIN skills s ON s.id=sv.skill_id WHERE ${filters.join(' AND ')} ORDER BY v.created_at DESC,v.id DESC LIMIT ?`,...params,sqliteLimit(input.limit)).map(verdict);
    },
    createFeedbackSyncJob(_input:Args<'createFeedbackSyncJob'>[0]) {
      // No integration-backed trace can exist under the current migration's
      // source_integration_id IS NULL constraint. There is no upstream target.
      return null;
    }
  };
}
