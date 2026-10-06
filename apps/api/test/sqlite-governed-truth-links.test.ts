import { expect,it } from 'vitest';
import type { SQLInputValue } from 'node:sqlite';
import { governedFixture } from './helpers/sqlite-governed.js';
import { sqliteGovernedImportedTruthCommands } from '../src/storage/sqlite/governed-imported-truth-commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { CreateImportedTruthInputSchema } from '../src/governed-review/contracts.js';
import { datasetRevisionContentDigest,datasetRevisionDigest,datasetRevisionItemDigest } from '../src/lib/dataset-revision.js';
import { governedContentV1Digest } from '../src/lib/governed-content-digest.js';
async function prepared(attested=true){const f=await governedFixture(),request=CreateImportedTruthInputSchema.parse({criterionVersionId:f.criterionVersionId,issuer:'External team',subject:'Reviewer',sourceArtifact:{claim:'pass'},verificationMethod:attested?'self_attested':'none',transportProvenance:{source:'manual'},instructionsProvenance:{v:1},raterProvenance:{rater:'named'},adjudicationProvenance:{basis:'individual'},blindAttestation:{claimed:true},payloadSnapshot:{input:'Q',output:'A'},label:'pass',rationale:'Supported',failureCodes:[],idempotencyKey:'import'}),imported=sqliteGovernedImportedTruthCommands(f.db).governedImportedTruthCreate(f.actor,request);return {...f,imported};}
function materialize(f:Awaited<ReturnType<typeof prepared>>,fault?:string){return sqliteCommand(f.db,c=>{
 const imported=c.db.prepare('SELECT * FROM governed_imported_truth WHERE id=?').get(f.imported.importedTruthId)!;
 const insert=(table:string,row:Record<string,SQLInputValue>)=>c.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 const provenanceLevel=imported.evidence_class==='imported_self_attested'?'imported_self_attested':'unverified',resolutionKind=provenanceLevel==='unverified'?'imported_unverified':'imported_self_attested';
 const payload=JSON.parse(String(imported.payload_snapshot));if(fault==='payload')payload.output='Unreviewed';
 const provenance={kind:'dataset_claim',sourceId:fault==='pointer'?'wrong':'truth',verdictIds:[],actorUserIds:[],basis:'Authoritative imported evidence'};
 const itemDigest=datasetRevisionItemDigest({inputIdentity:{basis:'input-identity/v1',digest:String(imported.input_digest)},redactedPayload:payload,referenceLabel:'pass',expectedFailStep:null,reviewProvenance:provenance,note:null});
 insert('dataset_revisions',{id:'revision',project_id:f.projectId,series_id:'imported',revision_number:1,role:'iterative_development',source_kind:'collection_snapshot',identity_basis:'input-identity/v1',content_digest:datasetRevisionContentDigest([itemDigest]),revision_digest:datasetRevisionDigest({role:'iterative_development',itemDigests:[itemDigest]}),item_count:1,provenance_level:fault==='class'?'imported_verified_attested':provenanceLevel,criterion_version_id:f.criterionVersionId,created_at:c.timestamp});
 insert('dataset_revision_items',{id:'item',project_id:f.projectId,revision_id:'revision',position:0,input_digest:imported.input_digest!,item_digest:itemDigest,payload_snapshot:JSON.stringify(payload),reference_label:'pass',reference_provenance:JSON.stringify(provenance),created_at:c.timestamp});
 const basis={adjudicationId:null,batchItemId:null,criterionVersionId:f.criterionVersionId,datasetRevisionId:'revision',datasetRevisionItemId:'item',governedLabelIds:[],importedTruthId:f.imported.importedTruthId,resolutionKind,resolvedLabel:'pass',sourceKind:'imported_truth',supportingLabelCount:0};
 if(fault!=='missing-link')insert('governed_dataset_truth_links',{id:'truth',project_id:f.projectId,dataset_revision_id:'revision',dataset_revision_item_id:'item',criterion_version_id:f.criterionVersionId,source_kind:'imported_truth',batch_item_id:null,governed_label_ids:'[]',adjudication_id:null,imported_truth_id:f.imported.importedTruthId,resolution_kind:resolutionKind,resolved_label:'pass',supporting_label_count:0,content_digest:fault==='digest'?'sha256:'+'0'.repeat(64):governedContentV1Digest('governed-dataset-truth-link/v1',basis),idempotency_key:'truth',request_digest:'sha256:'+'0'.repeat(64),created_at:c.timestamp,created_command_token:c.token});
 insert('dataset_exposure_events',{id:'created',project_id:f.projectId,revision_id:'revision',kind:'created',exposure_class:'lineage',activity:'revision_create',subject_kind:'system',details:'{}',idempotency_key:'created',occurred_at:c.timestamp});
 insert('dataset_revision_finalizations',{revision_id:'revision',project_id:f.projectId});
});}
it('retains exact imported truth without upgrading its self-attested evidence class',async()=>{
 const f=await prepared();materialize(f);expect(f.db.prepare('SELECT provenance_level FROM dataset_revisions WHERE id=?').get('revision')?.provenance_level).toBe('imported_self_attested');
 expect(f.db.prepare('SELECT count(*) n FROM governed_dataset_truth_link_labels').get()?.n).toBe(0);expect(f.db.prepare('SELECT count(*) n FROM governed_dataset_truth_finalizations').get()?.n).toBe(1);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('SELECT * FROM governed_dataset_truth_links').all()).toEqual([]);
});
it.each(['payload','pointer','class','digest'])('rejects forged imported truth %s despite recomputed item digests',async fault=>{
 const f=await prepared();expect(()=>materialize(f,fault)).toThrow();expect(f.db.prepare("SELECT id FROM dataset_revisions WHERE id='revision'").get()).toBeUndefined();expect(f.db.prepare('SELECT count(*) n FROM governed_dataset_truth_links').get()?.n).toBe(0);
});

it('preserves unverified imports and requires their exact truth link before committing metadata-free items',async()=>{
 const f=await prepared(false);expect(()=>materialize(f,'missing-link')).toThrow(/metadata-free revision payload/);expect(f.db.prepare("SELECT id FROM dataset_revisions WHERE id='revision'").get()).toBeUndefined();
 materialize(f);expect(f.db.prepare('SELECT provenance_level FROM dataset_revisions WHERE id=?').get('revision')?.provenance_level).toBe('unverified');expect(f.db.prepare('SELECT resolution_kind FROM governed_dataset_truth_links').get()?.resolution_kind).toBe('imported_unverified');
});
