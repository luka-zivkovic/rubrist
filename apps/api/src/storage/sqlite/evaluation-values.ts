import { EvalRunSchema, EvalRunItemSchema, VerdictRecordSchema } from '@rubrist/shared';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
export type Row = Record<string, any>;
export const json = (value: unknown) => value == null ? null : JSON.stringify(value);
export const parse = (value: unknown) => value == null ? null : JSON.parse(String(value));
export function camel(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()),value]));
}
export function evalRun(row: Row) { return EvalRunSchema.parse({...camel(row),blocking:Boolean(row.blocking)}); }
export function evalItem(row: Row) {
  return EvalRunItemSchema.parse({...camel(row),cached:Boolean(row.cached),notAttempted:Boolean(row.not_attempted),
    agreement:row.agreement == null ? null : Boolean(row.agreement),
    stepAgreement:row.expected_fail_step == null || row.failing_step == null ? null : row.expected_fail_step===row.failing_step,
    providerMetadata:parse(row.provider_metadata),observed:parse(row.observed)});
}
export function verdict(row: Row) {
  return VerdictRecordSchema.parse({...camel(row),actorName:row.actor_name??null,reviewContext:row.review_queue_item_id?{queueItemId:row.review_queue_item_id,judgeRunId:row.reviewed_judge_run_id,submissionId:row.review_submission_id}:null,payload:parse(row.payload),observed:parse(row.observed),evaluatorScore:parse(row.evaluator_score)});
}
export function evaluationDatabase(db: DatabaseSync) {
  return {
    one:(sql:string,...args:SQLInputValue[])=>db.prepare(sql).get(...args) as Row|undefined,
    all:(sql:string,...args:SQLInputValue[])=>db.prepare(sql).all(...args) as Row[],
    run:(sql:string,...args:SQLInputValue[])=>db.prepare(sql).run(...args),
    transaction<T>(work:(now:number)=>T):T {
      if(db.isTransaction) throw new Error('Nested SQLite evaluation command');
      db.exec('BEGIN IMMEDIATE');
      try { const result=work(Date.now()); db.exec('COMMIT'); return result; }
      catch(error) { if(db.isTransaction) db.exec('ROLLBACK'); throw error; }
    }
  };
}
