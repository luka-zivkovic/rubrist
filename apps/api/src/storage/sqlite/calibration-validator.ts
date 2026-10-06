import type {DatabaseSync} from 'node:sqlite';
import {registerSqliteValidator} from './command-context.js';
import {evaluateCalibrationCapability} from './calibration-eligibility.js';
import {canonicalGovernedJsonV1} from '../../lib/governed-content-digest.js';
import {COVERED_CAPABILITIES} from '../../binary-calibration/storage-values.js';
const initialized=new WeakSet<DatabaseSync>();
export function initializeCalibrationValidator(db:DatabaseSync){
 if(initialized.has(db))return;
 registerSqliteValidator(db,'analysis_calibration_capability_valid_v1',['governed_capability_insert'],(read,projectId,criterionVersionId,subjectId,result,excluded,unknown,storedEvidence)=>{
  const evaluated=evaluateCalibrationCapability(read,String(projectId),String(criterionVersionId),String(subjectId));
  const evidence={contract:'rubrist/sealed-separation-evidence/v1',criterionVersionId,evaluatedCapabilities:[...COVERED_CAPABILITIES],findings:evaluated.findings};
  return evaluated.result===result&&canonicalGovernedJsonV1(evaluated.excluded)===String(excluded)&&canonicalGovernedJsonV1(evaluated.unknown)===String(unknown)&&canonicalGovernedJsonV1(evidence)===String(storedEvidence);
 });initialized.add(db);
}
