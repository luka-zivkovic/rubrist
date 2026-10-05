import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { CreateImportedTruthInputSchema, ImportedTruthListQuerySchema, type ImportedTruthProjection } from '../../governed-review/contracts.js';
import { GovernedImportedTruthVerificationUnavailableError, GovernedReviewConflictError, GovernedReviewIdempotencyConflictError, GovernedReviewNotFoundError } from '../../governed-review/errors.js';
import type { GovernedReviewRepository } from '../../governed-review/repository.js';
import { stableId } from '../../governed-review/storage-values.js';
import { projectGovernedReviewPayload } from '../../governed-review/projection.js';
import { canonicalJson } from '../../lib/canonical-json.js';
import { datasetInputIdentity } from '../../lib/dataset-revision.js';
import { governedReviewRequestDigest } from '../../lib/governed-review.js';
import { governedJsonTextDigest } from './governed-json-text.js';
import { governedReviewAccess } from './governed-subject-commands.js';
import { sqliteCommand } from './command-context.js';
type Args<K extends keyof GovernedReviewRepository>=Parameters<GovernedReviewRepository[K]>;
function projection(row:Record<string,unknown>):ImportedTruthProjection {
 return {importedTruthId:String(row.id),criterionVersionId:String(row.criterion_version_id),issuer:String(row.issuer),subject:String(row.subject),sourceArtifactDigest:String(row.source_artifact_digest),sourceArtifactBytes:(row.source_artifact_bytes as Uint8Array).byteLength,verificationMethod:row.verification_method as ImportedTruthProjection['verificationMethod'],evidenceClass:row.evidence_class as ImportedTruthProjection['evidenceClass'],inputDigest:String(row.input_digest),label:row.label as ImportedTruthProjection['label'],rationale:String(row.rationale),failureCodes:JSON.parse(String(row.failure_codes)),provenanceDigest:String(row.provenance_digest),contentDigest:String(row.content_digest),importedAt:String(row.imported_at)};
}
const digest=(kind:string,value:unknown)=>governedJsonTextDigest(kind,JSON.stringify(value));
const json=(value:unknown):string|null=>value===null?null:JSON.stringify(value);
export function sqliteGovernedImportedTruthCommands(db:DatabaseSync,clock=Date.now){
 return {
  governedImportedTruthList(...[actor,raw]:Args<'listImportedTruth'>){const query=ImportedTruthListQuerySchema.parse(raw);return sqliteCommand(db,()=>{
   governedReviewAccess(db,actor,true);
   return db.prepare('SELECT * FROM governed_imported_truth WHERE project_id=? AND (? IS NULL OR criterion_version_id=?) AND (? IS NULL OR evidence_class=?) ORDER BY imported_at DESC,governed_utf16_sort_key_v1(id)').all(actor.projectId,query.criterionVersionId??null,query.criterionVersionId??null,query.evidenceClass??null,query.evidenceClass??null).map(projection);
  },clock);},
  governedImportedTruthCreate(...[actor,raw]:Args<'createImportedTruth'>){const input=CreateImportedTruthInputSchema.parse(raw);
   try{return sqliteCommand(db,c=>{
    governedReviewAccess(db,actor,true);
    if(input.verificationMethod==='verified_signature'||input.verificationMethod==='independently_verified_transport')throw new GovernedImportedTruthVerificationUnavailableError();
    const requestDigest=governedReviewRequestDigest(input),existing=db.prepare('SELECT * FROM governed_imported_truth WHERE project_id=? AND idempotency_key=?').get(actor.projectId,input.idempotencyKey);
    if(existing){if(existing.request_digest!==requestDigest)throw new GovernedReviewIdempotencyConflictError();return projection(existing);}
    if(!db.prepare('SELECT 1 FROM criterion_versions WHERE project_id=? AND id=?').get(actor.projectId,input.criterionVersionId))throw new GovernedReviewNotFoundError();
    const payloadSnapshot=projectGovernedReviewPayload(input.payloadSnapshot),sourceBytes=Buffer.from(canonicalJson(input.sourceArtifact),'utf8');
    if(sourceBytes.byteLength>10*1024*1024)throw new GovernedReviewConflictError('governed_review_transition_conflict','Imported source artifacts cannot exceed 10 MiB');
    const sourceDigest='sha256:'+createHash('sha256').update(sourceBytes).digest('hex');
    const transport=input.transportProvenance??null,verificationEvidence=input.verificationEvidence??null,instructions=input.instructionsProvenance??null,raters=input.raterProvenance??null,adjudication=input.adjudicationProvenance??null,blindAttestation=input.blindAttestation??null;
    const complete=transport!==null&&instructions!==null&&raters!==null&&adjudication!==null&&blindAttestation!==null;
    const evidenceClass=input.verificationMethod==='self_attested'&&complete?'imported_self_attested':'unverified';
    const inputDigest=datasetInputIdentity({input:input.payloadSnapshot.input}).digest;
    const provenanceDigest=digest('governed-imported-truth-provenance/v1',{adjudication,blindAttestation,instructions,issuer:input.issuer,raters,sourceArtifactDigest:sourceDigest,subject:input.subject,transport,verificationEvidence,verificationMethod:input.verificationMethod});
    const contentDigest=digest('governed-imported-truth/v1',{criterionVersionId:input.criterionVersionId,evidenceClass,failureCodes:input.failureCodes,identityBasis:'input-identity/v1',inputDigest,label:input.label,payloadSnapshot,provenanceDigest,rationale:input.rationale});
    const id=stableId('git',actor.projectId,input.idempotencyKey);
    const row:Record<string,SQLInputValue>={id,project_id:actor.projectId,criterion_version_id:input.criterionVersionId,issuer:input.issuer,subject:input.subject,source_artifact_bytes:sourceBytes,source_artifact_digest:sourceDigest,transport_provenance:json(transport),verification_method:input.verificationMethod,verification_evidence:json(verificationEvidence),instructions_provenance:json(instructions),rater_provenance:json(raters),adjudication_provenance:json(adjudication),blind_attestation:json(blindAttestation),identity_basis:'input-identity/v1',input_digest:inputDigest,payload_snapshot:JSON.stringify(payloadSnapshot),label:input.label,rationale:input.rationale,failure_codes:JSON.stringify(input.failureCodes),evidence_class:evidenceClass,provenance_digest:provenanceDigest,content_digest:contentDigest,idempotency_key:input.idempotencyKey,request_digest:requestDigest,imported_at:c.timestamp};
    c.db.prepare(`INSERT INTO governed_imported_truth(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
    return projection(row);
   },clock);}catch(error){if((error as {code?:unknown})?.code==='ERR_SQLITE_ERROR'){
    if(error instanceof Error&&/UNIQUE constraint/i.test(error.message))throw new GovernedReviewIdempotencyConflictError();
    throw new GovernedReviewConflictError('governed_review_transition_conflict','Imported truth conflicts with retained evidence');
   }throw error;}
  }
 };
}
