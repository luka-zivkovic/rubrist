import type {DatabaseSync} from 'node:sqlite';
import {registerSqliteValidator} from './command-context.js';
import {calibrationEvidence} from './calibration-evidence.js';
import {snapshotRecord} from './calibration-eligibility.js';
import type {RunRow,EligibilityResult} from '../../binary-calibration/storage-values.js';
const initialized=new WeakSet<DatabaseSync>();
/** Rebuild immutable artifact and private ledger from the retained run/attempt facts. */
export function initializeCalibrationMintValidator(db:DatabaseSync){
 if(initialized.has(db))return;
 registerSqliteValidator(db,'analysis_calibration_mint_valid_v1',['binary_calibration_mint_finalize'],(read,runId,projectId)=>{
  const row=read.get('SELECT * FROM binary_calibration_runs WHERE id=? AND project_id=?',runId,projectId);if(!row)return false;const run=row as unknown as RunRow;
  const auth=read.get("SELECT * FROM binary_calibration_exposure_checks WHERE id=? AND run_id=? AND phase='authorization'",String(run.authorization_check_id),runId),completionRow=read.get("SELECT * FROM binary_calibration_exposure_checks WHERE id=? AND run_id=? AND phase='completion'",String(run.completion_check_id),runId);if(!auth||!completionRow)return false;
  const completion:EligibilityResult={exposureState:completionRow.exposure_state as 'protected'|'exposed',eligible:completionRow.eligibility_result==='eligible',reasons:JSON.parse(String(completionRow.eligibility_reasons)),snapshot:JSON.parse(Buffer.from(completionRow.canonical_bytes as Uint8Array).toString('utf8'))};
  const check=snapshotRecord(run,'completion',completion.exposureState,completion.eligible?'eligible':'ineligible',completion.reasons,completion.snapshot,String(completionRow.recorded_at));
  if(check.id!==completionRow.id||check.snapshotDigest!==completionRow.snapshot_digest)return false;
  const attempts:Record<string,unknown>[]=[];
  for(const attempt of read.iterate('SELECT * FROM binary_calibration_attempts WHERE run_id=? ORDER BY trial_index,dataset_revision_item_digest',runId)){if(attempts.length>=run.planned_observations||attempt.accounting_state!=='accounted')return false;attempts.push(attempt);}
  if(attempts.length!==run.planned_observations||run.accounted_observations!==run.planned_observations)return false;
  const evidence=calibrationEvidence(run,attempts,{id:String(auth.id),snapshotDigest:String(auth.snapshot_digest),recordedAt:String(auth.recorded_at)},completion,check,String(run.completed_at));
  const artifact=read.get('SELECT * FROM binary_calibration_artifacts WHERE id=? AND run_id=? AND project_id=?',evidence.artifactId,runId,projectId),ledger=read.get('SELECT * FROM binary_calibration_private_ledgers WHERE id=? AND run_id=? AND project_id=?',evidence.ledgerId,runId,projectId);if(!artifact||!ledger)return false;
  return artifact.artifact_revision===1&&artifact.predecessor_artifact_id===null&&artifact.correction_reason===null&&Buffer.from(artifact.canonical_bytes as Uint8Array).equals(evidence.artifactBytes)&&Buffer.from(ledger.canonical_bytes as Uint8Array).equals(evidence.ledgerBytes)&&artifact.artifact_digest===evidence.artifactDigest&&artifact.evidence_digest===evidence.artifact.evidenceDigest&&ledger.commitment_digest===evidence.ledgerCommitment&&run.artifact_id===evidence.artifactId&&run.artifact_digest===evidence.artifactDigest&&run.evidence_digest===evidence.artifact.evidenceDigest&&run.state===evidence.artifact.status&&artifact.status===run.state;
 });initialized.add(db);
}
