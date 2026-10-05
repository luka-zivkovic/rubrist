import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RubristRepository } from '../../repository.js';
import type { AssessmentReceiptArtifact, AssessmentReceiptComparison } from '../../repository/contracts.js';
import { AssessmentReceiptIntegrityError, AssessmentReceiptUnavailableError } from '../../repository/errors.js';
import { buildAssessmentReceipt, canonicalReceiptBytes, parseCanonicalReceiptBytes, receiptArtifactDigest, receiptSourceSnapshotDigest } from '../../lib/assessment-receipt.js';
import { computeEvalRunSpend } from '../../repository/helpers.js';
import { camel, evalRun, evalItem, verdict, evaluationDatabase, type Row } from './evaluation-values.js';
import { sqliteDefinitionCommands } from './definition-commands.js';
type Args<K extends keyof RubristRepository> = Parameters<RubristRepository[K]>;
function checkedReceipt(bytes:Uint8Array) {
  try { return parseCanonicalReceiptBytes(bytes); }
  catch(error) { throw new AssessmentReceiptIntegrityError(error instanceof Error?error.message:String(error)); }
}
function artifact(row:Row):AssessmentReceiptArtifact {
  const canonicalBytes=Buffer.from(row.canonical_bytes);
  const receipt=checkedReceipt(canonicalBytes);
  if(receiptArtifactDigest(canonicalBytes)!==row.artifact_digest || receipt.projectId!==row.project_id || receipt.evalRunId!==row.eval_run_id ||
    receipt.receiptId!==row.receipt_id || receipt.schemaVersion!==row.contract_version || receipt.evidenceDigest!==row.evidence_digest)
    throw new AssessmentReceiptIntegrityError('Persisted assessment receipt columns do not match canonical bytes');
  return {...camel(row),canonicalBytes} as AssessmentReceiptArtifact;
}
const initializedConnections=new WeakSet<DatabaseSync>();
export function sqliteReceiptCommands(db:DatabaseSync) {
  const {one,all,run,transaction}=evaluationDatabase(db);
  const definitions=sqliteDefinitionCommands(db);
  if(!initializedConnections.has(db)) {
    db.function('sqlite_correction_reason_valid',{deterministic:true},reason=>typeof reason==='string'&&reason.trim().length>0?1:0);
    db.function('sqlite_receipt_valid',{deterministic:true},(bytes,projectId,evalRunId,receiptId,contractVersion,digest,evidenceDigest)=> {
      try { artifact({canonical_bytes:bytes,project_id:projectId,eval_run_id:evalRunId,receipt_id:receiptId,contract_version:contractVersion,artifact_digest:digest,evidence_digest:evidenceDigest}); return 1; }
      catch { return 0; }
    });
    db.function('sqlite_comparison_valid',{deterministic:true},(bytes,rootBytes,projectId,evalRunId,receiptId,digest,status)=> {
      try {
        const value=Buffer.from(bytes as Uint8Array),root=Buffer.from(rootBytes as Uint8Array),receipt=parseCanonicalReceiptBytes(value);
        return receipt.projectId===projectId && receipt.evalRunId===evalRunId && receipt.receiptId===receiptId &&
          receipt.receiptId===parseCanonicalReceiptBytes(root).receiptId && receiptArtifactDigest(value)===digest &&
          status===(value.equals(root)?'match':'diverged') ? 1 : 0;
      } catch { return 0; }
    });
    initializedConnections.add(db);
  }
  function insert(projectId:string,evalRunId:string,receipt:ReturnType<typeof buildAssessmentReceipt>,sourceKind:AssessmentReceiptArtifact['sourceKind'],sourceDigest:string,now:number,predecessor?:AssessmentReceiptArtifact,reason?:string,actor?:string) {
    const bytes=canonicalReceiptBytes(receipt),revision=(predecessor?.artifactRevision??0)+1;
    const row=one(`INSERT INTO assessment_receipt_artifacts(id,project_id,eval_run_id,receipt_id,contract_version,artifact_revision,canonical_bytes,artifact_digest,evidence_digest,source_snapshot_digest,source_kind,predecessor_artifact_id,correction_reason,created_by_user_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,`rart_${evalRunId}_v1_r${revision}`,projectId,evalRunId,receipt.receiptId,1,revision,bytes,receiptArtifactDigest(bytes),receipt.evidenceDigest,sourceDigest,sourceKind,predecessor?.id??null,reason??null,actor??null,new Date(now).toISOString())!;
    return artifact(row);
  }
  // Called by the owning run transaction before its terminal state can commit.
  function mint(projectId:string,evalRunId:string,now:number,sourceKind:'terminal_mint'|'historical_freeze'='terminal_mint') {
    const row=one('SELECT * FROM eval_runs WHERE project_id=? AND id=?',projectId,evalRunId);
    if(!row) return null;
    const existing=one('SELECT * FROM assessment_receipt_artifacts WHERE project_id=? AND eval_run_id=? AND artifact_revision=1',projectId,evalRunId);
    if(existing) return artifact(existing);
    const value=evalRun(row);
    if(value.trigger!=='release_evidence') throw new AssessmentReceiptUnavailableError('not_release_evidence','Assessment receipts require release_evidence');
    if(value.status==='pending'||value.status==='running') throw new AssessmentReceiptUnavailableError('not_terminal','Assessment is not terminal');
    const items=all('SELECT * FROM eval_run_items WHERE project_id=? AND eval_run_id=? ORDER BY created_at,id',projectId,evalRunId).map(evalItem);
    const skillVersion=definitions.getSkillVersion(projectId,value.skillVersionId);
    if(!skillVersion) throw new AssessmentReceiptUnavailableError('missing_source','Evaluator version missing');
    const verdicts=new Map(all(`SELECT v.* FROM verdicts v JOIN eval_run_items i ON i.verdict_id=v.id AND i.project_id=v.project_id WHERE i.project_id=? AND i.eval_run_id=?`,projectId,evalRunId).map(row=>{const value=verdict(row);return [value.id,value] as const;}));
    const source={run:{...value,items,spend:computeEvalRunSpend(items)},skillVersion,verdicts};
    return insert(projectId,evalRunId,buildAssessmentReceipt(source),sourceKind,receiptSourceSnapshotDigest(source),now);
  }
  const commands={
    getOrFreezeAssessmentReceipt(projectId:string,evalRunId:string) { return transaction(now=>mint(projectId,evalRunId,now,'historical_freeze')); },
    getAssessmentReceiptArtifactByReceiptId(projectId:string,receiptId:string) { const row=one('SELECT * FROM assessment_receipt_artifacts WHERE project_id=? AND receipt_id=?',projectId,receiptId);return row?artifact(row):null; },
    listAssessmentReceiptArtifacts(projectId:string,evalRunId:string) { return all('SELECT * FROM assessment_receipt_artifacts WHERE project_id=? AND eval_run_id=? ORDER BY artifact_revision',projectId,evalRunId).map(artifact); },
    compareAssessmentReceiptCopy(input:Args<'compareAssessmentReceiptCopy'>[0]):AssessmentReceiptComparison {
      return transaction(now=> {
        const bytes=Buffer.from(input.consumerCanonicalBytes),receipt=checkedReceipt(bytes);
        const root=mint(input.projectId,input.evalRunId,now,'historical_freeze');
        if(!root) throw new AssessmentReceiptUnavailableError('missing_source','Eval run not found');
        if(receipt.projectId!==input.projectId||receipt.evalRunId!==input.evalRunId||receipt.receiptId!==root.receiptId) throw new AssessmentReceiptIntegrityError('Consumer receipt identity mismatch');
        const digest=receiptArtifactDigest(bytes),status=bytes.equals(root.canonicalBytes)?'match':'diverged';
        run(`INSERT INTO assessment_receipt_comparisons VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(artifact_id,consumer_artifact_digest) DO NOTHING`,
          `rcomp_${randomUUID()}`,input.projectId,input.evalRunId,root.id,receipt.receiptId,bytes,digest,status,new Date(now).toISOString());
        const row=one('SELECT * FROM assessment_receipt_comparisons WHERE artifact_id=? AND consumer_artifact_digest=?',root.id,digest)!;
        if(!Buffer.from(row.consumer_canonical_bytes).equals(bytes)||row.comparison_status!==status) throw new AssessmentReceiptIntegrityError('Persisted comparison mismatch');
        return {...camel(row),consumerCanonicalBytes:Buffer.from(row.consumer_canonical_bytes)} as AssessmentReceiptComparison;
      });
    },
    createAssessmentReceiptCorrection(input:Args<'createAssessmentReceiptCorrection'>[0]) {
      return transaction(now=> {
        const reason=input.reason.trim();
        if(!reason) throw new AssessmentReceiptIntegrityError('Correction reason required');
        let bytes:Buffer;
        try { bytes=canonicalReceiptBytes(input.receipt); }
        catch(error) { throw new AssessmentReceiptIntegrityError(error instanceof Error?error.message:String(error)); }
        const receipt=checkedReceipt(bytes);
        if(receipt.projectId!==input.projectId||receipt.evalRunId!==input.evalRunId) throw new AssessmentReceiptIntegrityError('Correction identity mismatch');
        const root=mint(input.projectId,input.evalRunId,now,'historical_freeze');
        if(!root) throw new AssessmentReceiptUnavailableError('missing_source','Eval run not found');
        const existing=commands.getAssessmentReceiptArtifactByReceiptId(input.projectId,receipt.receiptId);
        if(existing) {
          if(existing.sourceKind==='correction'&&existing.evalRunId===input.evalRunId&&existing.canonicalBytes.equals(bytes)) return existing;
          throw new AssessmentReceiptIntegrityError('Correction receiptId already in use');
        }
        const original=parseCanonicalReceiptBytes(root.canonicalBytes);
        if(receipt.schemaVersion!==original.schemaVersion||receipt.skillId!==original.skillId||receipt.skillVersionId!==original.skillVersionId||receipt.skillDigest!==original.skillDigest)
          throw new AssessmentReceiptIntegrityError('Correction cannot change evaluator identity');
        const predecessor=artifact(one('SELECT * FROM assessment_receipt_artifacts WHERE project_id=? AND eval_run_id=? ORDER BY artifact_revision DESC LIMIT 1',input.projectId,input.evalRunId)!);
        return insert(input.projectId,input.evalRunId,receipt,'correction',receiptArtifactDigest(bytes),now,predecessor,reason,input.createdByUserId);
      });
    }
  };
  return {commands,mint};
}
