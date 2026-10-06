import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RubristRepository } from '../../repository.js';
import { GATE_CHECK_RUN_COLUMNS, rowToGateCheck, rowToGateCheckItem } from '../../repository.pg/mappers.js';
import { evaluationDatabase } from './evaluation-values.js';
import { sqliteLimit } from './query-values.js';
type Args<K extends keyof RubristRepository>=Parameters<RubristRepository[K]>;
export function sqliteHistoricalGateCommands(db:DatabaseSync) {
 const {one,all,run,transaction}=evaluationDatabase(db),query=`SELECT gc.*,${GATE_CHECK_RUN_COLUMNS} FROM gate_checks gc JOIN eval_runs er ON er.id=gc.eval_run_id AND er.project_id=gc.project_id`;
 const commands={
  createGateCheck(input:Args<'createGateCheck'>[0]) {return transaction(now=>{
   const id=`gate_${randomUUID()}`,stamp=new Date(now).toISOString();run('INSERT INTO gate_checks VALUES(?,?,?,?,?,?,?,?,?)',id,input.projectId,input.skillVersionId,input.evalRunId,input.label??null,JSON.stringify(input.metadata??{}),input.maxDisagreements,input.createdByUserId??null,stamp);
   for(const item of input.items)run('INSERT INTO gate_check_items VALUES(?,?,?,?,?,?,?,?,?)',`gati_${randomUUID()}`,id,input.projectId,item.goldenEntryId,item.goldenCaseId,item.candidateCaseId,item.caseKey,item.expectedLabel,stamp);
   return commands.getGateCheckDetail(input.projectId,id)!;
  });},
  getGateCheckDetail(projectId:string,id:string) {
   const row=one(`${query} WHERE gc.project_id=? AND gc.id=?`,projectId,id);if(!row)return null;
   return {...rowToGateCheck(row),items:all(`SELECT g.*,i.status eval_status,i.result_label,i.agreement,i.cached,i.error eval_error FROM gate_check_items g LEFT JOIN eval_run_items i ON i.id=(SELECT id FROM eval_run_items WHERE project_id=g.project_id AND eval_run_id=? AND case_id=g.candidate_case_id ORDER BY created_at,id LIMIT 1) WHERE g.project_id=? AND g.gate_check_id=? ORDER BY g.created_at,g.id`,row.eval_run_id,projectId,id).map(rowToGateCheckItem)};
  },
  listGateChecks(projectId:string,opts:Args<'listGateChecks'>[1]={}) {return all(`${query} WHERE gc.project_id=? ORDER BY gc.created_at DESC,gc.id DESC LIMIT ?`,projectId,sqliteLimit(opts.limit??50)).map(rowToGateCheck);}
 };
 return commands;
}
