import type { DatabaseSync } from 'node:sqlite';
import { computeKappaSummary, computeJudgeHumanCalibration, computeDisagreementSummary, computeJudgeHumanDisagreement, computeSelfConsistency } from '../../lib/kappa.js';
import { DatasetRevisionConflictError } from '../../repository/errors.js';
import { sqliteDefinitionCommands } from './definition-commands.js';
import { evaluationDatabase, verdict, parse } from './evaluation-values.js';
export function sqliteEvidenceCommands(db:DatabaseSync) {
  const {one,all}=evaluationDatabase(db),definitions=sqliteDefinitionCommands(db);
  function criterion(projectId:string,requested?:string) {
    if(requested) {
      if(!one('SELECT 1 FROM criterion_versions WHERE project_id=? AND id=?',projectId,requested))throw new DatasetRevisionConflictError(`Criterion version does not belong to this project: ${requested}`);
      return requested;
    }
    return definitions.getCriterionVersionForSkillVersion(projectId,definitions.getCurrentSkill(projectId).currentVersion.id)!.id;
  }
  function rows(projectId:string,cv:string,sources:string[],versionId?:string) {
    return all(`SELECT v.* FROM verdicts v JOIN skill_versions s ON s.project_id=v.project_id AND s.id=v.skill_version_id
      WHERE v.project_id=? AND s.criterion_version_id=? AND v.source IN (${sources.map(()=>'?').join(',')})
      AND (? IS NULL OR v.source<>'llm_judge' OR v.skill_version_id=?) ORDER BY v.created_at,v.id LIMIT 50000`,projectId,cv,...sources,versionId??null,versionId??null).map(verdict);
  }
  function names(lists:Array<Array<{actorUserId:string;actorName?:string|null|undefined}>>) {
    const ids=[...new Set(lists.flat().map(label=>label.actorUserId))];
    const names=new Map(ids.map(id=>{const row=one('SELECT name,email FROM "user" WHERE id=?',id);return [id,row?.name||row?.email||null] as const;}));
    for(const labels of lists)for(const label of labels)label.actorName=names.get(label.actorUserId)??null;
  }
  return {
    getProjectKappaSummary(projectId:string,criterionVersionId?:string) { return computeKappaSummary(rows(projectId,criterion(projectId,criterionVersionId),['human'])); },
    getProjectJudgeHumanCalibration(projectId:string,criterionVersionId?:string,versionId?:string) { return computeJudgeHumanCalibration(rows(projectId,criterion(projectId,criterionVersionId),['human','llm_judge'],versionId)); },
    getDisagreementSummary(projectId:string,criterionVersionId?:string) { const summary=computeDisagreementSummary(rows(projectId,criterion(projectId,criterionVersionId),['human','adjudicated']));names(summary.cases.map(value=>value.labels));return summary; },
    getJudgeHumanDisagreementSummary(projectId:string,criterionVersionId?:string) { const summary=computeJudgeHumanDisagreement(rows(projectId,criterion(projectId,criterionVersionId),['human','llm_judge','adjudicated']));names(summary.cases.map(value=>value.humanLabels));return summary; },
    getSelfConsistencyReport(projectId:string,versionId:string) { return computeSelfConsistency(all("SELECT * FROM verdicts WHERE project_id=? AND source='llm_judge' AND skill_version_id=? ORDER BY created_at,id LIMIT 50000",projectId,versionId).map(verdict),versionId); },
    listAuditEntries(projectId:string,targetType:string,targetId:string) { return all('SELECT * FROM audit_logs WHERE project_id=? AND target_type=? AND target_id=? ORDER BY created_at,id',projectId,targetType,targetId).map(row=>({id:String(row.id),action:String(row.action),actorUserId:row.actor_user_id as string|null,createdAt:String(row.created_at),metadata:parse(row.metadata) as Record<string,unknown>|null})); }
  };
}
