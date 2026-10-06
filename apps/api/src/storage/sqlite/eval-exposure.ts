import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { evaluationDatabase, type Row } from './evaluation-values.js';
export function recordSqliteEvalExposure(db:DatabaseSync,row:Row,now:number) {
  if(!db.isTransaction)throw new Error('Evaluation exposure requires an owned transaction');
  if(!row.dataset_revision_id)return;
  evaluationDatabase(db).run(`INSERT INTO dataset_exposure_events VALUES(?,?,?,NULL,'development_use','development','development_run','evaluator_version',?,?,'eval_run',?,NULL,?,?,?) ON CONFLICT(project_id,idempotency_key) DO NOTHING`,
    `dse_${randomUUID()}`,row.project_id,row.dataset_revision_id,row.skill_version_id,row.created_by_user_id,row.id,JSON.stringify({trigger:row.trigger}),`eval-run:${row.id}`,new Date(now).toISOString());
}
