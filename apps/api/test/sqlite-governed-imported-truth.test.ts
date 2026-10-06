import { openSqlite } from '@rubrist/db/sqlite';
import { cleanup } from './helpers/sqlite-analysis.js';
import { expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { governedFixture } from './helpers/sqlite-governed.js';
import { sqliteGovernedImportedTruthCommands } from '../src/storage/sqlite/governed-imported-truth-commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { canonicalJson } from '../src/lib/canonical-json.js';
import { governedJsonTextDigest } from '../src/storage/sqlite/governed-json-text.js';
import { CreateImportedTruthInputSchema } from '../src/governed-review/contracts.js';
function input(criterionVersionId:string){return CreateImportedTruthInputSchema.parse({criterionVersionId,issuer:'External team',subject:'Named reviewer',sourceArtifact:{z:'😀',a:{raw:'retained\nbytes'}},verificationMethod:'self_attested',transportProvenance:{source:'manual'},instructionsProvenance:{version:1},raterProvenance:{rater:'named'},adjudicationProvenance:{decision:'individual'},blindAttestation:{claimed:true},payloadSnapshot:{input:'Question',output:'Answer'},label:'pass',rationale:'Evidence supports the answer',failureCodes:[],idempotencyKey:'import-one'});}
it('preserves exact source bytes, claims, replay and self-attested classification through restart reads',async()=>{
 const f=await governedFixture(),commands=sqliteGovernedImportedTruthCommands(f.db),request=input(f.criterionVersionId),result=commands.governedImportedTruthCreate(f.actor,request);
 expect(result).toMatchObject({issuer:request.issuer,subject:request.subject,evidenceClass:'imported_self_attested',verificationMethod:'self_attested'});
 const row=f.db.prepare('SELECT * FROM governed_imported_truth WHERE id=?').get(result.importedTruthId)!;
 const bytes=Buffer.from(canonicalJson(request.sourceArtifact),'utf8');expect(Buffer.from(row.source_artifact_bytes as Uint8Array)).toEqual(bytes);
 expect(result.sourceArtifactDigest).toBe('sha256:'+createHash('sha256').update(bytes).digest('hex'));expect(result.sourceArtifactBytes).toBe(bytes.length);
 expect(commands.governedImportedTruthCreate(f.actor,request)).toEqual(result);
 const reopened=openSqlite(f.path);cleanup.push(()=>reopened.close());expect(sqliteGovernedImportedTruthCommands(reopened).governedImportedTruthList(f.actor,{})).toEqual([result]);
 expect(commands.governedImportedTruthList(f.actor,{evidenceClass:'unverified'})).toEqual([]);
 expect(()=>commands.governedImportedTruthCreate(f.actor,{...request,rationale:'changed'})).toThrow(expect.objectContaining({code:'governed_review_idempotency_conflict'}));
 expect(()=>f.db.exec("UPDATE governed_imported_truth SET issuer='rewrite'")).toThrow(/immutable/);
 expect(()=>f.db.exec('DELETE FROM governed_imported_truth')).toThrow(/project erasure/);
 expect(()=>commands.governedImportedTruthList({...f.actor,projectId:'foreign'},{})).toThrow();
 f.db.prepare("UPDATE project_members SET role='member' WHERE user_id=? AND project_id=?").run(f.userId,f.projectId);
 expect(()=>commands.governedImportedTruthCreate(f.actor,request)).toThrow(expect.objectContaining({code:'governed_review_forbidden'}));
 f.db.prepare("UPDATE project_members SET role='owner' WHERE user_id=? AND project_id=?").run(f.userId,f.projectId);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('SELECT * FROM governed_imported_truth').all()).toEqual([]);
});
it('does not turn complete caller proofs into verified evidence and downgrades missing attestations',async()=>{
 const f=await governedFixture(),commands=sqliteGovernedImportedTruthCommands(f.db),request=input(f.criterionVersionId);
 for(const verificationMethod of ['verified_signature','independently_verified_transport'] as const)expect(()=>commands.governedImportedTruthCreate(f.actor,{...request,verificationMethod,verificationEvidence:{signature:'caller-supplied'}})).toThrow(expect.objectContaining({code:'imported_truth_verification_unavailable'}));
 expect(commands.governedImportedTruthCreate(f.actor,{...request,blindAttestation:null}).evidenceClass).toBe('unverified');
 expect(commands.governedImportedTruthCreate(f.actor,{...request,idempotencyKey:'none',verificationMethod:'none'}).evidenceClass).toBe('unverified');
});
it.each(['bytes','provenance','content','verified','attestation','codes','bounds','criterion','clock'])('rejects forged imported truth %s with atomic rollback',async fault=>{
 const f=await governedFixture(),commands=sqliteGovernedImportedTruthCommands(f.db),first=commands.governedImportedTruthCreate(f.actor,input(f.criterionVersionId));
 expect(()=>sqliteCommand(f.db,c=>{
  const row=c.db.prepare('SELECT * FROM governed_imported_truth WHERE id=?').get(first.importedTruthId)!;row.id='forged';row.idempotency_key='forged';row.imported_at=c.timestamp;
  if(fault==='bytes')row.source_artifact_bytes=Buffer.from('altered');
  if(fault==='verified')row.evidence_class='imported_verified_attested';
  if(fault==='attestation')row.blind_attestation='null';
  if(fault==='codes')row.failure_codes='[""]';
  if(fault==='bounds')row.transport_provenance=JSON.stringify('😀'.repeat(65536));
  if(fault==='criterion')row.criterion_version_id='foreign';
  if(fault==='clock')row.imported_at='2000-01-01T00:00:00.000Z';
  const parse=(v:unknown)=>v===null?null:JSON.parse(String(v));
  row.provenance_digest=governedJsonTextDigest('governed-imported-truth-provenance/v1',JSON.stringify({adjudication:parse(row.adjudication_provenance),blindAttestation:parse(row.blind_attestation),instructions:parse(row.instructions_provenance),issuer:row.issuer,raters:parse(row.rater_provenance),sourceArtifactDigest:row.source_artifact_digest,subject:row.subject,transport:parse(row.transport_provenance),verificationEvidence:parse(row.verification_evidence),verificationMethod:row.verification_method}));
  if(fault==='provenance')row.provenance_digest='sha256:'+'0'.repeat(64);
  row.content_digest=governedJsonTextDigest('governed-imported-truth/v1',JSON.stringify({criterionVersionId:row.criterion_version_id,evidenceClass:row.evidence_class,failureCodes:parse(row.failure_codes),identityBasis:row.identity_basis,inputDigest:row.input_digest,label:row.label,payloadSnapshot:parse(row.payload_snapshot),provenanceDigest:row.provenance_digest,rationale:row.rationale}));
  if(fault==='content')row.content_digest='sha256:'+'0'.repeat(64);
  c.db.prepare(`INSERT INTO governed_imported_truth(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 })).toThrow();expect(f.db.prepare('SELECT count(*) n FROM governed_imported_truth').get()?.n).toBe(1);
});
