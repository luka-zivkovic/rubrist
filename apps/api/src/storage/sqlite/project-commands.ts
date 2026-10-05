import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RubristRepository } from '../../repository.js';
import { capabilityGapsFromExceptions } from '../../lib/capability-gaps.js';
import { EXCEPTION_LIST_LIMIT } from '../../lib/exception-rows.js';
import { rowToProject, rowToExceptionCase } from '../../repository.pg/mappers.js';
import { sqliteDefinitionCommands } from './definition-commands.js';
import { sqliteGoldenCommands } from './golden-commands.js';
import { evaluationDatabase } from './evaluation-values.js';
type Args<K extends keyof RubristRepository>=Parameters<RubristRepository[K]>;
export function sqliteProjectCommands(db:DatabaseSync) {
 const {one,all,run,transaction}=evaluationDatabase(db),definitions=sqliteDefinitionCommands(db),golden=sqliteGoldenCommands(db);
 function exceptions(projectId:string,criterionVersionId:string) {
  const rows=all(`WITH resolved AS (
   SELECT v.case_id,s.criterion_version_id,max(v.created_at) resolved_at FROM verdicts v JOIN skill_versions s ON s.id=v.skill_version_id AND s.project_id=v.project_id
   WHERE v.project_id=? AND v.source IN ('human','adjudicated') GROUP BY v.case_id,s.criterion_version_id
  ), ranked AS (
   SELECT j.*,s.criterion_version_id,row_number() OVER(PARTITION BY j.case_id,s.criterion_version_id ORDER BY j.created_at,j.id) rank
   FROM judge_runs j JOIN skill_versions s ON s.id=j.skill_version_id AND s.project_id=j.project_id JOIN cases c ON c.id=j.case_id AND c.project_id=j.project_id
   LEFT JOIN resolved r ON r.case_id=j.case_id AND r.criterion_version_id=s.criterion_version_id
   WHERE j.project_id=? AND s.criterion_version_id=? AND j.verdict<>'pass' AND c.case_type NOT IN ('gate_candidate','release_evidence')
   AND(r.resolved_at IS NULL OR j.created_at>r.resolved_at)
   AND NOT EXISTS(SELECT 1 FROM golden_set_entries g WHERE g.project_id=j.project_id AND g.case_id=j.case_id AND g.criterion_version_id=s.criterion_version_id AND g.retired_at IS NULL)
  ), capped AS (SELECT *,count(*) OVER() exception_total FROM ranked WHERE rank=1 ORDER BY created_at DESC,id DESC LIMIT ?),
  latest AS (SELECT j.*,s.criterion_version_id,row_number() OVER(PARTITION BY j.case_id,s.criterion_version_id ORDER BY j.created_at DESC,j.id DESC) rank
   FROM judge_runs j JOIN skill_versions s ON s.id=j.skill_version_id AND s.project_id=j.project_id WHERE j.project_id=? AND EXISTS(SELECT 1 FROM capped p WHERE p.case_id=j.case_id AND p.criterion_version_id=s.criterion_version_id))
  SELECT p.*,p.id judge_run_id,l.id latest_judge_run_id,l.verdict latest_verdict,l.reasoning latest_reasoning,l.created_at latest_created_at,c.normalized_payload,r.source_trace_id
  FROM capped p JOIN latest l ON l.case_id=p.case_id AND l.criterion_version_id=p.criterion_version_id AND l.rank=1 JOIN cases c ON c.id=p.case_id LEFT JOIN raw_traces r ON r.id=c.raw_trace_id ORDER BY p.created_at DESC,p.id DESC`,projectId,projectId,criterionVersionId,EXCEPTION_LIST_LIMIT,projectId);
  return {exceptions:rows.map(rowToExceptionCase),total:Number(rows[0]?.exception_total??0)};
 }
 return {
  getDashboardSummary(projectId:string,criterionId?:string) {
   const project=one('SELECT * FROM projects WHERE id=?',projectId);if(!project)throw new Error(`Project not found: ${projectId}`);
   const skill=criterionId?definitions.getCurrentSkillForCriterion(projectId,criterionId):definitions.getCurrentSkill(projectId),criterionVersionId=skill.currentVersion.criterionVersionId;
   const {exceptions:cases,total}=exceptions(projectId,criterionVersionId),verdictDistribution={pass:0,fail:0,ambiguous:0};
   for(const row of all(`WITH ranked AS(SELECT j.verdict,row_number() OVER(PARTITION BY j.case_id ORDER BY j.created_at DESC,j.id DESC) rank FROM judge_runs j
    JOIN cases c ON c.id=j.case_id AND c.project_id=j.project_id JOIN skill_versions s ON s.id=j.skill_version_id AND s.project_id=j.project_id WHERE j.project_id=? AND s.criterion_version_id=? AND c.case_type NOT IN ('gate_candidate','release_evidence'))
    SELECT verdict,count(*) n FROM ranked WHERE rank=1 GROUP BY verdict`,projectId,criterionVersionId)) {
    if(row.verdict==='pass'||row.verdict==='fail'||row.verdict==='ambiguous')verdictDistribution[row.verdict as keyof typeof verdictDistribution]=Number(row.n);
   }
   return {project:rowToProject(project),skill,currentVersionResultCount:Number(one(`SELECT count(DISTINCT j.case_id) n FROM judge_runs j JOIN cases c ON c.id=j.case_id AND c.project_id=j.project_id WHERE j.project_id=? AND j.skill_version_id=? AND c.case_type NOT IN ('gate_candidate','release_evidence')`,projectId,skill.currentVersion.id)!.n),verdictDistribution,exceptions:cases,exceptionsTotal:total,topCapabilityGaps:capabilityGapsFromExceptions(cases),goldenSetSize:golden.listGoldenSet(projectId,criterionVersionId).length,viewerRole:'owner' as const};
  },
  getOnboardingEvidenceInventory(projectId:string) {
   const row=one(`SELECT count(*) run_count,
    coalesce(sum(json_type(normalized_payload,'$.input') IS NOT NULL AND json_type(normalized_payload,'$.input')<>'null'),0) input_count,
    coalesce(sum(json_type(normalized_payload,'$.output') IS NOT NULL AND json_type(normalized_payload,'$.output')<>'null'),0) output_count,
    coalesce(sum(json_type(normalized_payload,'$.steps')='array' AND json_array_length(normalized_payload,'$.steps')>0),0) steps_count,
    coalesce(sum(json_type(normalized_payload,'$.metadata')='object' AND EXISTS(SELECT 1 FROM json_each(json_extract(normalized_payload,'$.metadata')))),0) metadata_count
    FROM cases WHERE project_id=? AND case_type NOT IN ('gate_candidate','release_evidence')`,projectId)!;
   return {runCount:Number(row.run_count),inputCount:Number(row.input_count),outputCount:Number(row.output_count),stepsCount:Number(row.steps_count),metadataCount:Number(row.metadata_count)};
  },
  pruneExpiredTraces(projectId:string,context:Args<'pruneExpiredTraces'>[1]) {return transaction(clock=>{
   const now=context.now??new Date(clock),stamp=now.toISOString(),project=one('SELECT * FROM projects WHERE id=?',projectId);if(!project)throw new Error(`Project not found: ${projectId}`);
   const days=project.trace_retention_days as number|null,cutoff=days?new Date(now.getTime()-days*86400000).toISOString():null;
   const result={projectId,traceRetentionDays:days,cutoff,deletedCases:0,deletedRawTraces:0,skippedActiveGoldenCases:0,skippedImmutableRevisionCases:0,skippedReviewCases:0};
   if(!days||project.last_retention_pruned_at&&now.getTime()-Date.parse(project.last_retention_pruned_at)<60000)return result;
   const flags=`SELECT c.id,c.case_type,
    EXISTS(SELECT 1 FROM golden_set_entries g WHERE g.project_id=c.project_id AND g.case_id=c.id AND g.retired_at IS NULL) golden,
    EXISTS(SELECT 1 FROM dataset_revision_items d WHERE d.project_id=c.project_id AND d.source_case_id=c.id) revision,
    (EXISTS(SELECT 1 FROM review_queue_items i WHERE i.project_id=c.project_id AND i.case_id=c.id AND i.judge_run_id IS NOT NULL) OR EXISTS(SELECT 1 FROM verdicts v WHERE v.project_id=c.project_id AND v.case_id=c.id AND v.review_queue_item_id IS NOT NULL)) review
    FROM cases c JOIN raw_traces r ON r.id=c.raw_trace_id AND r.project_id=c.project_id WHERE c.project_id=? AND r.created_at<?`;
   const counts=one(`WITH flags AS(${flags}) SELECT coalesce(sum(golden),0) golden,coalesce(sum(revision AND NOT golden),0) revision,coalesce(sum(review AND NOT revision AND NOT golden AND case_type<>'release_evidence'),0) review FROM flags`,projectId,cutoff)!;
   result.skippedActiveGoldenCases=Number(counts.golden);result.skippedImmutableRevisionCases=Number(counts.revision);result.skippedReviewCases=Number(counts.review);
   result.deletedCases=Number(run(`WITH flags AS(${flags}) DELETE FROM cases WHERE id IN(SELECT id FROM flags WHERE NOT golden AND NOT revision AND NOT review AND case_type<>'release_evidence')`,projectId,cutoff).changes);
   result.deletedRawTraces=Number(run('DELETE FROM raw_traces WHERE project_id=? AND created_at<? AND NOT EXISTS(SELECT 1 FROM cases c WHERE c.raw_trace_id=raw_traces.id)',projectId,cutoff).changes);
   run(`UPDATE projects SET imported_trace_count=(SELECT count(*) FROM raw_traces r WHERE r.project_id=projects.id AND NOT EXISTS(SELECT 1 FROM cases c WHERE c.raw_trace_id=r.id AND c.case_type IN ('gate_candidate','release_evidence'))),
    auto_judged_trace_count=(SELECT count(DISTINCT j.case_id) FROM judge_runs j JOIN cases c ON c.id=j.case_id WHERE j.project_id=projects.id AND c.case_type NOT IN ('gate_candidate','release_evidence')),
    sync_back_coverage=coalesce((SELECT sum(status='synced')*1.0/nullif(count(*),0) FROM feedback_sync_jobs WHERE project_id=projects.id),0),updated_at=?,last_retention_pruned_at=? WHERE id=?`,stamp,stamp,projectId);
   if(Object.entries(result).some(([key,value])=>(key.startsWith('deleted')||key.startsWith('skipped'))&&Number(value)>0))run('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?,?)',`audit_${randomUUID()}`,projectId,context.actorUserId??null,'project.retention.prune','project',projectId,JSON.stringify(result),stamp);
   return result;
  });}
 };
}
