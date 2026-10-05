import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { effectiveHumanLabel, GoldenSetEntrySchema, JudgeRunSchema, type ExceptionDetail, type VerdictRecord, type SkillFormatExample } from '@rubrist/shared';
import type { RubristRepository } from '../../repository.js';
import { CaseNotFoundError, DatasetRevisionConflictError, GoldenSetLabelConflictError, GoldenSetEntryNotFoundError, GoldenSetEntryAlreadyRetiredError } from '../../repository/errors.js';
import { buildGoldenSetHealthSummary } from '../../repository/golden-helpers.js';
import { redactNormalizedTracePayload } from '../../lib/redaction.js';
import { sqliteDefinitionCommands } from './definition-commands.js';
import { sqliteDatasetRevisionCommands, getOrCreateSqliteRegressionRevision } from './dataset-revision-commands.js';
import { evaluationDatabase, camel, parse, verdict, type Row } from './evaluation-values.js';
type Args<K extends keyof RubristRepository>=Parameters<RubristRepository[K]>;
const golden=(row:Row)=>GoldenSetEntrySchema.parse(camel(row));
export function sqliteGoldenCommands(db:DatabaseSync) {
  const {one,all,run,transaction}=evaluationDatabase(db),definitions=sqliteDefinitionCommands(db),revisions=sqliteDatasetRevisionCommands(db);
  function criterion(projectId:string,requested?:string) {
    if(requested) {
      if(!one('SELECT 1 FROM criterion_versions WHERE project_id=? AND id=?',projectId,requested))throw new DatasetRevisionConflictError('Criterion version does not belong to this project');
      return requested;
    }
    return definitions.getCriterionVersionForSkillVersion(projectId,definitions.getCurrentSkill(projectId).currentVersion.id)!.id;
  }
  function payload(projectId:string,caseId:string) {
    const row=one('SELECT normalized_payload FROM cases WHERE project_id=? AND id=?',projectId,caseId);return row?redactNormalizedTracePayload(parse(row.normalized_payload)):null;
  }
  function detail(projectId:string,caseId:string,opts:{exceptionsOnly?:boolean;skillVersionId?:string|undefined;criterionVersionId?:string|undefined;judgeRunId?:string|undefined}):ExceptionDetail|null {
    if(!opts.skillVersionId&&!opts.criterionVersionId&&!opts.judgeRunId)definitions.getCurrentSkill(projectId);
    const row=one(`SELECT r.*,v.criterion_version_id,c.normalized_payload,t.source_trace_id FROM judge_runs r JOIN skill_versions v ON v.id=r.skill_version_id AND v.project_id=r.project_id JOIN cases c ON c.id=r.case_id AND c.project_id=r.project_id LEFT JOIN raw_traces t ON t.id=c.raw_trace_id WHERE r.project_id=? AND r.case_id=? AND(? IS NULL OR r.skill_version_id=?) AND(? IS NULL OR v.criterion_version_id=?) AND(? IS NULL OR r.id=?) ${opts.exceptionsOnly?"AND r.verdict<>'pass'":''} ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,projectId,caseId,opts.skillVersionId??null,opts.skillVersionId??null,opts.criterionVersionId??null,opts.criterionVersionId??null,opts.judgeRunId??null,opts.judgeRunId??null);
    if(!row)return null;
    const trace=redactNormalizedTracePayload(parse(row.normalized_payload)),historySelect=`SELECT v.*,coalesce(u.name,u.email) actor_name FROM verdicts v JOIN skill_versions s ON s.id=v.skill_version_id AND s.project_id=v.project_id LEFT JOIN "user" u ON u.id=v.actor_user_id WHERE v.project_id=? AND v.case_id=? AND s.criterion_version_id=?`;
    const history=all(`${historySelect} AND v.source IN ('llm_judge','human','adjudicated') ORDER BY v.created_at DESC,v.id DESC LIMIT 200`,projectId,caseId,row.criterion_version_id);
    const ruling=all(`${historySelect} AND v.source IN ('human','adjudicated') ORDER BY CASE WHEN v.source='adjudicated' THEN 0 ELSE 1 END,v.created_at DESC,v.id DESC LIMIT 1`,projectId,caseId,row.criterion_version_id);
    const byId=new Map<string,VerdictRecord>();for(const r of [...history,...ruling])try {const v=verdict(r);byId.set(v.id,v);}catch{/* Keep the rest of malformed historical evidence viewable. */}
    const verdictHistory=[...byId.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
    const entry=one('SELECT * FROM golden_set_entries WHERE project_id=? AND case_id=? AND criterion_version_id=? AND retired_at IS NULL ORDER BY promoted_at DESC,id DESC LIMIT 1',projectId,caseId,row.criterion_version_id),rawResponse=parse(row.raw_response),sourceTraceId=row.source_trace_id??caseId;
    return {exception:{id:caseId,traceId:sourceTraceId,title:typeof trace.metadata?.name==='string'&&trace.metadata.name?trace.metadata.name:`Trace ${sourceTraceId}`,judgeRunId:row.id,skillVersionId:row.skill_version_id,criterionVersionId:row.criterion_version_id,verdict:row.verdict,reason:row.reasoning??'',capabilityGap:typeof rawResponse?.failureCategory==='string'?rawResponse.failureCategory:undefined,reviewerState:'needs_review',createdAt:row.created_at},
      trace:{id:sourceTraceId,input:trace.input??trace,output:trace.output??trace,metadata:trace.metadata??{},...(trace.steps?{steps:trace.steps}:{})},
      judgeRun:JudgeRunSchema.parse({...camel(row),latencyMs:row.latency_ms??undefined,providerMetadata:parse(row.provider_metadata)??undefined}),
      datasetExpectations:all('SELECT d.name,i.expected_label,i.expected_fail_step FROM dataset_items i JOIN datasets d ON d.id=i.dataset_id WHERE i.project_id=? AND i.case_id=? AND d.archived_at IS NULL ORDER BY i.added_at,i.id',projectId,caseId).map(r=>({datasetName:r.name,expectedLabel:r.expected_label,expectedFailStep:r.expected_fail_step})),
      latestHumanLabel:effectiveHumanLabel(verdictHistory),verdictHistory,goldenSetEntry:entry?golden(entry):null,rawRequest:parse(row.raw_request)??undefined,rawResponse:rawResponse??undefined};
  }
  const commands={
    listGoldenSet(projectId:string,criterionVersionId?:string) { return all('SELECT * FROM golden_set_entries WHERE project_id=? AND criterion_version_id=? AND retired_at IS NULL ORDER BY promoted_at DESC,id DESC',projectId,criterion(projectId,criterionVersionId)).map(golden); },
    getSkillFormatExamples(projectId:string,cap:number,criterionVersionId?:string):SkillFormatExample[] { return commands.listGoldenSet(projectId,criterionVersionId).slice(0,cap).map(entry=> {
      const p=payload(projectId,entry.caseId);return {id:entry.id,label:entry.agreedLabel,input:(p?.input??null) as SkillFormatExample['input'],output:(p?.output??null) as SkillFormatExample['output'],reason:entry.reason,metadata:p?.metadata&&Object.keys(p.metadata).length?p.metadata as SkillFormatExample['metadata']:null};
    }); },
    getGoldenSetHealth(projectId:string,criterionVersionId?:string) { return buildGoldenSetHealthSummary(projectId,commands.listGoldenSet(projectId,criterionVersionId)); },
    getGoldenSetTraces(projectId:string,criterionVersionId?:string) { return new Map(commands.listGoldenSet(projectId,criterionVersionId).flatMap(entry=> {
      const p=payload(projectId,entry.caseId);return p?[[entry.caseId,{id:entry.caseId,input:p.input??p,output:p.output??p,metadata:p.metadata??{},...(p.steps?{steps:p.steps}:{})}] as const]:[];
    })); },
    getExceptionDetail(projectId:string,caseId:string,skillVersionId?:string) { const value=detail(projectId,caseId,{exceptionsOnly:true,skillVersionId});if(!value)throw new Error(`Exception not found: ${caseId}`);return value; },
    getCaseDetail(projectId:string,caseId:string,skillVersionId?:string,criterionVersionId?:string,judgeRunId?:string) { return detail(projectId,caseId,{skillVersionId,criterionVersionId,judgeRunId}); },
    getOrCreateRegressionDatasetRevision(projectId:string,actorUserId?:string,criterionVersionId?:string) { return transaction(()=> {
      let resolved=criterionVersionId;
      if(!resolved) {
        const criteria=all('SELECT id FROM criteria WHERE project_id=?',projectId);
        if(criteria.length!==1)throw new DatasetRevisionConflictError(`Project ${projectId} requires an explicit criterionVersionId for regression evidence.`);
        resolved=one('SELECT id FROM criterion_versions WHERE project_id=? AND criterion_id=? ORDER BY revision DESC,id DESC LIMIT 1',projectId,criteria[0]!.id)!.id;
      }
      return revisions.getDatasetRevisionDetail(projectId,getOrCreateSqliteRegressionRevision(db,projectId,resolved!,actorUserId))!;
    }); },
    promoteExceptionToGoldenSet(input:Args<'promoteExceptionToGoldenSet'>[0]) { return transaction(now=> {
      if(one('SELECT case_type FROM cases WHERE project_id=? AND id=?',input.projectId,input.caseId)?.case_type==='release_evidence')throw new CaseNotFoundError(input.caseId);
      const value=detail(input.projectId,input.caseId,{skillVersionId:input.skillVersionId});if(!value)throw new CaseNotFoundError(input.caseId);
      if(value.latestHumanLabel&&value.latestHumanLabel!=='ambiguous'&&value.latestHumanLabel!==input.agreedLabel)throw new GoldenSetLabelConflictError(input.caseId,input.agreedLabel,value.latestHumanLabel);
      const cv=one('SELECT criterion_version_id FROM skill_versions WHERE project_id=? AND id=?',input.projectId,value.judgeRun.skillVersionId)!.criterion_version_id,stamp=new Date(now).toISOString();
      // Promotion records human truth, but does not complete review tasks.
      run(`INSERT INTO verdicts(id,project_id,case_id,skill_version_id,source,actor_user_id,verdict_kind,payload,created_at) VALUES(?,?,?,?,'human',?,'categorical',?,?)`,`verdict_${randomUUID()}`,input.projectId,input.caseId,value.judgeRun.skillVersionId,input.actorUserId??null,JSON.stringify({kind:'categorical',choice:input.agreedLabel,choiceScores:{pass:1,fail:0,ambiguous:0.5},rationale:input.reason}),stamp);
      const row=one(`INSERT INTO golden_set_entries(id,project_id,case_id,trace_id,agreed_label,reason,promoted_by_user_id,promoted_by,source_skill_version_id,criterion_version_id,promoted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,criterion_version_id,case_id) WHERE retired_at IS NULL DO UPDATE SET agreed_label=excluded.agreed_label,reason=excluded.reason,promoted_by_user_id=excluded.promoted_by_user_id,promoted_by=excluded.promoted_by,source_skill_version_id=excluded.source_skill_version_id,promoted_at=excluded.promoted_at RETURNING *`,`gold_${randomUUID()}`,input.projectId,input.caseId,value.trace.id,input.agreedLabel,input.reason,input.actorUserId??null,input.actorName??'Reviewer',value.judgeRun.skillVersionId,cv,stamp)!;
      getOrCreateSqliteRegressionRevision(db,input.projectId,cv,input.actorUserId);return golden(row);
    }); },
    retireGoldenSetEntry(input:Args<'retireGoldenSetEntry'>[0]) { transaction(now=> {
      const row=one('SELECT * FROM golden_set_entries WHERE project_id=? AND id=?',input.projectId,input.entryId);
      if(!row)throw new GoldenSetEntryNotFoundError(input.entryId);
      if(row.retired_at) {
        const audit=one(`SELECT a.actor_user_id,a.metadata,u.name,u.email FROM audit_logs a LEFT JOIN "user" u ON u.id=a.actor_user_id WHERE a.project_id=? AND a.action='golden_set.retire' AND a.target_type='golden_set_entry' AND a.target_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT 1`,input.projectId,input.entryId);
        throw new GoldenSetEntryAlreadyRetiredError(input.entryId,{retiredAt:row.retired_at,retiredByUserId:audit?.actor_user_id??null,retiredBy:audit?.name&&audit.email?`${audit.name} <${audit.email}>`:audit?.email??audit?.name??audit?.actor_user_id??null,reason:parse(audit?.metadata)?.reason??null});
      }
      const stamp=new Date(now).toISOString();run('UPDATE golden_set_entries SET retired_at=? WHERE project_id=? AND id=?',stamp,input.projectId,input.entryId);
      run('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?,?)',`audit_${randomUUID()}`,input.projectId,input.actorUserId??null,'golden_set.retire','golden_set_entry',input.entryId,JSON.stringify({caseId:row.case_id,...(input.reason?{reason:input.reason}:{})}),stamp);
      getOrCreateSqliteRegressionRevision(db,input.projectId,row.criterion_version_id,input.actorUserId);
    }); }
  };
  return commands;
}
