import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { defaultJudgePromptTemplate, MinimumVerdictOutputSchema, SEEDED_DEFAULT_EXECUTION_BINDING, STARTER_RUBRIC_MARKER } from '@rubrist/shared';
import { criterionVersionDigest } from '../../lib/criterion-digest.js';
// Native starter parity with PostgreSQL. Never seed synthetic verdicts or a
// mock provider. The unresolved real binding refuses execution without a key.
export function seedSqliteStarterEvaluator(db:DatabaseSync,projectId:string,userId:string,mode:string,stamp:string) {
 if(!db.isTransaction)throw new Error('Starter creation requires project transaction');
 if(db.prepare('SELECT 1 FROM skills WHERE project_id=? LIMIT 1').get(projectId))return;
 const criterionId=`criterion_${randomUUID()}`,cv=`criterionv_${randomUUID()}`,skillId=`skill_${randomUUID()}`,versionId=`skillv_${randomUUID()}`;
 const name='Default Review Skill',bench=mode==='bench',definition=bench?'Starter criterion for judging supplied examples.':'Starter criterion for judging imported traces.';
 const stableKey=db.prepare("SELECT 1 FROM criteria WHERE project_id=? AND stable_key='default-review'").get(projectId)?`default-review-${randomUUID()}`:'default-review';
 db.prepare('INSERT INTO criteria VALUES(?,?,?,?,?,?)').run(criterionId,projectId,stableKey,'native',userId,stamp);
 db.prepare('INSERT INTO criterion_versions VALUES(?,?,?,?,?,?,?,?,?,?)').run(cv,projectId,criterionId,1,name,definition,criterionVersionDigest({criterionId,criterionVersionId:cv,criterionName:name,criterionDefinition:definition}),'native',userId,stamp);
 db.prepare('INSERT INTO skills VALUES(?,?,?,?,?,?,?,?,?)').run(skillId,projectId,criterionId,name,bench?'Starter skill for judging supplied examples.':'Starter skill for judging imported traces.',userId,'draft',1,stamp);
 db.prepare(`INSERT INTO skill_versions(id,project_id,skill_id,criterion_id,criterion_version_id,version,status,rubric_markdown,prompt,output_schema,execution_binding,verdict_kind,rubric_provenance,rubric_provenance_declared,developer_identity_status,created_at)
 VALUES(?,?,?,?,?,'0.1.0','draft',?,?,?,?,'binary','unspecified',0,'unknown_legacy',?)`).run(versionId,projectId,skillId,criterionId,cv,`# Default Review Skill\n\n${STARTER_RUBRIC_MARKER}.`,defaultJudgePromptTemplate(bench?'case':'trace'),JSON.stringify(MinimumVerdictOutputSchema),JSON.stringify(SEEDED_DEFAULT_EXECUTION_BINDING),stamp);
}

// Upgrade already initialized installations before accepting requests. Preserve
// any authored evaluator and select a retained owner for starter attribution.
export function seedExistingSqliteStarterEvaluators(db:DatabaseSync) {
 db.exec('BEGIN IMMEDIATE');
 try {
  const rows=db.prepare(`SELECT p.id,p.mode,(SELECT pm.user_id FROM project_members pm
   WHERE pm.project_id=p.id AND pm.role='owner' ORDER BY pm.created_at,pm.id LIMIT 1) owner_id
   FROM projects p WHERE NOT EXISTS(SELECT 1 FROM skills s WHERE s.project_id=p.id)`).all();
  for(const row of rows)if(row.owner_id)seedSqliteStarterEvaluator(db,String(row.id),String(row.owner_id),String(row.mode),new Date().toISOString());
  db.exec('COMMIT');
 } catch(error) {if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
