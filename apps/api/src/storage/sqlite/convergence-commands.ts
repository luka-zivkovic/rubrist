import type { DatabaseSync } from 'node:sqlite';
import type { ConvergenceAuditPage, ConvergenceCaseChange } from '@rubrist/shared';
import type { ConvergenceAuditPageInput } from '../../repository.js';
import { InvalidConvergenceCursorError } from '../../repository/errors.js';
import { convergencePageLimit, decodeConvergenceCursor, encodeConvergenceCursor } from '../../repository/helpers.js';
import { computeConvergenceAudit } from '../../lib/kappa.js';
import { evaluationDatabase } from './evaluation-values.js';
export function sqliteConvergenceCommands(db:DatabaseSync) {
  const {one,transaction}=evaluationDatabase(db);
  return {
    getConvergenceAudit(projectId:string,skillId:string,versionId:string,input:ConvergenceAuditPageInput={}):ConvergenceAuditPage { return transaction(()=> {
      const target=one('SELECT criterion_version_id,created_at FROM skill_versions WHERE project_id=? AND skill_id=? AND id=?',projectId,skillId,versionId);
      if(!target)return {audit:computeConvergenceAudit([],{beforeVersionId:null,afterVersionId:versionId}),nextCursor:null,nextUncoveredCaseId:null};
      const criterionVersionId=String(target.criterion_version_id);
      const beforeVersionId=one('SELECT id FROM skill_versions WHERE project_id=? AND skill_id=? AND criterion_version_id=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT 1',projectId,skillId,criterionVersionId,target.created_at,versionId)?.id??null;
      const cursor=decodeConvergenceCursor(input.cursor??null),limit=convergencePageLimit(input.limit);
      if(cursor&&(cursor.versionId!==versionId||cursor.criterionVersionId!==criterionVersionId||cursor.beforeVersionId!==beforeVersionId))throw new InvalidConvergenceCursorError();
      const watermark=cursor?Number(cursor.snapshotId.replace(/^sqlite-sequence:/,'')):Number(one('SELECT coalesce(max(sequence),0) n FROM verdicts WHERE project_id=?',projectId)!.n);
      if(!Number.isSafeInteger(watermark)||watermark<0||cursor&&!cursor.snapshotId.startsWith('sqlite-sequence:'))throw new InvalidConvergenceCursorError();
      const snapshotCreatedAt=cursor?.snapshotCreatedAt??new Date().toISOString(),snapshotId=`sqlite-sequence:${watermark}`;
      // Exact latest heads and all headline totals stay inside SQLite. Only
      // the keyset page crosses the worker boundary; no arbitrary verdict cap.
      const result=db.prepare(`WITH relevant AS (
        SELECT v.*,s.criterion_version_id,
          CASE WHEN json_extract(v.payload,'$.kind')='binary' THEN coalesce(json_extract(v.payload,'$.label'),CASE WHEN json_extract(v.payload,'$.pass') THEN 'pass' ELSE 'fail' END) ELSE json_extract(v.payload,'$.choice') END label
        FROM verdicts v LEFT JOIN skill_versions s ON s.id=v.skill_version_id AND s.project_id=v.project_id
        WHERE v.project_id=$project AND json_extract(v.payload,'$.kind') IN ('binary','categorical') AND v.sequence<=$watermark
      ), truth_ranked AS (
        SELECT *,row_number() OVER(PARTITION BY case_id ORDER BY created_at DESC,id DESC) rank FROM relevant WHERE source='adjudicated' AND criterion_version_id=$criterion
      ), after_ranked AS (
        SELECT *,row_number() OVER(PARTITION BY case_id ORDER BY created_at DESC,id DESC) rank FROM relevant WHERE source='llm_judge' AND skill_version_id=$after
      ), before_ranked AS (
        SELECT *,row_number() OVER(PARTITION BY case_id ORDER BY created_at DESC,id DESC) rank FROM relevant WHERE source='llm_judge' AND skill_version_id=$before
      ), truth AS (SELECT * FROM truth_ranked WHERE rank=1), current AS (SELECT * FROM after_ranked WHERE rank=1), prior AS(SELECT * FROM before_ranked WHERE rank=1),
      labels AS (
        SELECT t.case_id,t.label adjudicated_label,a.label after_label,b.label before_label FROM truth t JOIN current a ON a.case_id=t.case_id LEFT JOIN prior b ON b.case_id=t.case_id
      ), classified AS (
        SELECT *,CASE WHEN after_label<>adjudicated_label AND before_label=adjudicated_label THEN 0 WHEN after_label=adjudicated_label AND before_label IS NOT NULL AND before_label<>adjudicated_label THEN 1 WHEN after_label<>adjudicated_label THEN 2 ELSE 3 END change_rank FROM labels
      ), summary AS (
        SELECT (SELECT count(*) FROM truth) adjudicated_total,count(*) compared_cases,
          coalesce(sum(after_label=adjudicated_label),0) after_agreed,coalesce(sum(before_label IS NOT NULL),0) before_known,
          coalesce(sum(before_label=adjudicated_label),0) before_agreed,coalesce(sum(change_rank=1),0) improved,coalesce(sum(change_rank=0),0) regressed FROM classified
      ), page AS (
        SELECT * FROM classified WHERE $rank IS NULL OR(change_rank,case_id)>($rank,$case) ORDER BY change_rank,case_id LIMIT $limit
      ) SELECT summary.*,page.*,(SELECT t.case_id FROM truth t LEFT JOIN current a ON a.case_id=t.case_id WHERE a.case_id IS NULL ORDER BY t.case_id LIMIT 1) next_uncovered_case_id
      FROM summary LEFT JOIN page ON 1 ORDER BY page.change_rank,page.case_id`).all({$project:projectId,$criterion:criterionVersionId,$after:versionId,$before:beforeVersionId,$watermark:watermark,$rank:cursor?.rank??null,$case:cursor?.caseId??null,$limit:limit+1});
      const summary=result[0]!,pages=result.filter(row=>row.case_id!==null),visible=pages.slice(0,limit),last=visible.at(-1);
      const changes:ConvergenceCaseChange[]=['regressed','improved','still_disagree','still_agree'];
      return {audit:{afterVersionId:versionId,beforeVersionId,adjudicatedTotal:Number(summary.adjudicated_total),comparedCases:Number(summary.compared_cases),afterAgreed:Number(summary.after_agreed),beforeKnown:Number(summary.before_known),beforeAgreed:Number(summary.before_agreed),improved:Number(summary.improved),regressed:Number(summary.regressed),cases:visible.map(row=>({caseId:String(row.case_id),adjudicatedLabel:String(row.adjudicated_label),beforeLabel:row.before_label==null?null:String(row.before_label),afterLabel:String(row.after_label),change:changes[Number(row.change_rank)]!}))},
        nextCursor:pages.length>limit&&last&&snapshotCreatedAt&&snapshotId?encodeConvergenceCursor({versionId,criterionVersionId,beforeVersionId,snapshotCreatedAt,snapshotId,rank:Number(last.change_rank),caseId:String(last.case_id)}):null,
        nextUncoveredCaseId:summary.next_uncovered_case_id==null?null:String(summary.next_uncovered_case_id)};
    }); }
  };
}
