import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DatasetRevisionSchema, DatasetRevisionItemSchema, DatasetExposureEventSchema, DatasetRevisionPayloadSnapshotSchema, DatasetReferenceProvenanceSchema, verdictLabelFromPayload, type DatasetReferenceProvenance, type DatasetRevision } from '@rubrist/shared';
import type { RubristRepository } from '../../repository.js';
import { DatasetNotFoundError, DatasetRevisionConflictError, DatasetRevisionNotFoundError, SealedValidationUnavailableError } from '../../repository/errors.js';
import { datasetRevisionContentDigest, datasetRevisionDigest, datasetRevisionItemDigest, decidePublicDatasetRevisionCreation } from '../../lib/dataset-revision.js';
import { canonicalJson } from '../../lib/canonical-json.js';
import { evaluationDatabase, camel, json, parse, verdict, type Row } from './evaluation-values.js';
type Args<K extends keyof RubristRepository> = Parameters<RubristRepository[K]>;
function snapshot(raw:unknown) {
  const value=parse(raw);
  if(!value||!('input' in value)||!('output' in value)) throw new DatasetRevisionConflictError('Case has no complete retained normalized payload to freeze');
  return DatasetRevisionPayloadSnapshotSchema.parse({input:value.input,output:value.output,metadata:value.metadata??{},...(Array.isArray(value.steps)?{steps:value.steps}:{})});
}
function revision(row:Row) { return DatasetRevisionSchema.parse({...camel(row),exposureState:row.role==='sealed_validation'?(row.has_development_exposure?'exposed':'protected'):'visible_by_design',semanticLeakageDetection:'unsupported'}); }
function item(row:Row) { return DatasetRevisionItemSchema.parse({...camel(row),payloadSnapshot:snapshot(row.payload_snapshot),referenceProvenance:parse(row.reference_provenance)}); }
function exposure(row:Row) { return DatasetExposureEventSchema.parse({...camel(row),details:parse(row.details)}); }
export function sqliteDatasetRevisionCommands(db:DatabaseSync) {
  const {one,all,run,transaction}=evaluationDatabase(db);
  db.function('sqlite_json_equal',{deterministic:true},(left,right)=>{try{return canonicalJson(parse(left))===canonicalJson(parse(right))?1:0;}catch{return 0;}});
  db.function('sqlite_dataset_payload_equal',{deterministic:true},(left,right)=>{try{return canonicalJson(snapshot(left))===canonicalJson(snapshot(right))?1:0;}catch{return 0;}});
  db.function('sqlite_dataset_item_valid',{deterministic:true},(inputDigest,digest,payload,label,step,provenance,note)=> {
    try {return datasetRevisionItemDigest({inputIdentity:{basis:'input-identity/v1',digest:String(inputDigest)},redactedPayload:snapshot(payload),referenceLabel:label,expectedFailStep:step as number|null,reviewProvenance:DatasetReferenceProvenanceSchema.parse(parse(provenance)),note})===digest?1:0;}catch{return 0;}
  });
  db.function('sqlite_dataset_content_digest',{deterministic:true},digests=>datasetRevisionContentDigest(parse(digests)));
  db.function('sqlite_dataset_revision_digest',{deterministic:true},(role,digests)=>datasetRevisionDigest({role:String(role) as DatasetRevision['role'],itemDigests:parse(digests)}));
  const readRevision=`SELECT r.*,EXISTS(SELECT 1 FROM dataset_exposure_events e WHERE e.revision_id=r.id AND e.exposure_class='development') has_development_exposure FROM dataset_revisions r`;
  const commands={
    createDatasetRevision(input:Args<'createDatasetRevision'>[0]) { return transaction(now=> {
      const allowed=decidePublicDatasetRevisionCreation(input.role);
      if(!allowed.allowed) {
        if(allowed.code==='rejected_public_sealed_creation_unavailable') throw new SealedValidationUnavailableError();
        throw new DatasetRevisionConflictError('Regression/golden revisions require promotion or retirement governance');
      }
      if(!one('SELECT 1 FROM datasets WHERE project_id=? AND id=? AND archived_at IS NULL',input.projectId,input.datasetId)) throw new DatasetNotFoundError(input.datasetId);
      if(input.idempotencyKey) {
        const existing=one('SELECT * FROM dataset_revisions WHERE project_id=? AND idempotency_key=?',input.projectId,input.idempotencyKey);
        if(existing) {
          if(existing.source_dataset_id!==input.datasetId||existing.role!==input.role) throw new DatasetRevisionConflictError('Idempotency key was already used for another revision request');
          return commands.getDatasetRevisionDetail(input.projectId,existing.id)!;
        }
      }
      const members=all(`SELECT d.*,c.normalized_payload FROM dataset_items d JOIN cases c ON c.project_id=d.project_id AND c.id=d.case_id WHERE d.project_id=? AND d.dataset_id=? ORDER BY d.added_at,d.id`,input.projectId,input.datasetId);
      if(!members.length) throw new DatasetRevisionConflictError('Cannot freeze an empty working collection');
      const prepared=members.map(row=> {
        const identity=one('SELECT input_digest FROM case_input_identity_records WHERE project_id=? AND source_case_id=? ORDER BY created_at,id LIMIT 1',input.projectId,row.case_id);
        if(!identity) throw new DatasetRevisionConflictError('Case has no retained pre-redaction input identity');
        const payloadSnapshot=snapshot(row.normalized_payload),referenceLabel=row.expected_label;
        const matching=referenceLabel?all("SELECT * FROM verdicts WHERE project_id=? AND case_id=? AND source IN ('human','adjudicated') ORDER BY created_at,id",input.projectId,row.case_id).map(verdict).filter(value=>verdictLabelFromPayload(value.payload)===referenceLabel):[];
        const adjudicated=matching.filter(value=>value.source==='adjudicated'),supporting=adjudicated.length?adjudicated:matching.filter(value=>value.source==='human');
        const provenance:DatasetReferenceProvenance=referenceLabel===null?{kind:'unlabeled',sourceId:row.id,verdictIds:[],actorUserIds:[],basis:'No reference label was present when the collection was frozen.'}:
          supporting.length?{kind:adjudicated.length?'adjudication':'human_verdict',sourceId:row.id,verdictIds:supporting.map(value=>value.id),actorUserIds:supporting.flatMap(value=>value.actorUserId?[value.actorUserId]:[]),basis:adjudicated.length?'Dataset expectation matched retained adjudicated truth.':'Dataset expectation matched retained human verdict history.'}:
          {kind:'dataset_claim',sourceId:row.id,verdictIds:[],actorUserIds:[],basis:'Mutable collection expectation; not adjudicated human truth.'};
        const itemDigest=datasetRevisionItemDigest({inputIdentity:{basis:'input-identity/v1',digest:identity.input_digest},redactedPayload:payloadSnapshot,referenceLabel,expectedFailStep:row.expected_fail_step,reviewProvenance:provenance,note:row.note});
        return {row,payloadSnapshot,provenance,itemDigest,inputDigest:identity.input_digest};
      });
      const seriesId=`dataset:${input.datasetId}`,parent=one('SELECT * FROM dataset_revisions WHERE project_id=? AND series_id=? ORDER BY revision_number DESC LIMIT 1',input.projectId,seriesId);
      if(input.expectedParentRevisionId!==undefined&&input.expectedParentRevisionId!==(parent?.id??null)) throw new DatasetRevisionConflictError('Dataset revision parent changed');
      const digests=prepared.map(value=>value.itemDigest),contentDigest=datasetRevisionContentDigest(digests);
      if(input.reuseLatestContent&&parent?.role===input.role&&parent.content_digest===contentDigest) return commands.getDatasetRevisionDetail(input.projectId,parent.id)!;
      const id=`dsr_${randomUUID()}`,stamp=new Date(now).toISOString();
      run(`INSERT INTO dataset_revisions(id,project_id,series_id,revision_number,source_dataset_id,parent_revision_id,role,source_kind,identity_basis,content_digest,revision_digest,item_count,provenance_level,created_by_user_id,idempotency_key,created_at)
        VALUES(?,?,?,?,?,?,?,'collection_snapshot','input-identity/v1',?,?,?,'unverified',?,?,?)`,id,input.projectId,seriesId,(parent?.revision_number??0)+1,input.datasetId,parent?.id??null,input.role,contentDigest,datasetRevisionDigest({role:input.role,itemDigests:digests}),prepared.length,input.createdByUserId??null,input.idempotencyKey??null,stamp);
      for(const [position,value] of prepared.entries()) run(`INSERT INTO dataset_revision_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,`dsri_${randomUUID()}`,id,input.projectId,position,value.row.case_id,value.row.trace_id,value.row.id,null,value.inputDigest,value.itemDigest,json(value.payloadSnapshot),value.row.expected_label,value.row.expected_fail_step,json(value.provenance),value.row.note,stamp);
      run(`INSERT INTO dataset_exposure_events VALUES(?,?,?,NULL,'created','lineage','revision_create',?,?,?,'dataset_revision',?,NULL,'{}',?,?)`,`dse_${randomUUID()}`,input.projectId,id,input.createdByUserId?'person':'system',input.createdByUserId??null,input.createdByUserId??null,id,`revision-created:${id}`,stamp);
      run('INSERT INTO dataset_revision_finalizations VALUES(?,?)',id,input.projectId);
      return commands.getDatasetRevisionDetail(input.projectId,id)!;
    }); },
    listDatasetRevisions(projectId:string,sourceDatasetId?:string) { return all(`${readRevision} WHERE r.project_id=? ${sourceDatasetId?'AND r.source_dataset_id=?':''} ORDER BY r.created_at DESC,r.id DESC`,projectId,...(sourceDatasetId?[sourceDatasetId]:[])).map(revision); },
    getDatasetRevisionDetail(projectId:string,revisionId:string) {
      const row=one(`${readRevision} WHERE r.project_id=? AND r.id=?`,projectId,revisionId);if(!row)return null;
      return {...revision(row),items:all('SELECT * FROM dataset_revision_items WHERE project_id=? AND revision_id=? ORDER BY position',projectId,revisionId).map(item),exposures:all('SELECT * FROM dataset_exposure_events WHERE project_id=? AND revision_id=? ORDER BY occurred_at,id',projectId,revisionId).map(exposure)};
    },
    recordDatasetRevisionContentView(input:Args<'recordDatasetRevisionContentView'>[0]) { transaction(now=> {
      if(!one('SELECT 1 FROM dataset_revisions WHERE project_id=? AND id=?',input.projectId,input.revisionId)) throw new DatasetRevisionNotFoundError(input.revisionId);
      run(`INSERT INTO dataset_exposure_events VALUES(?,?,?,NULL,'human_access','development','content_view',?,?,?,'dataset_revision',?,NULL,'{}',?,?)`,`dse_${randomUUID()}`,input.projectId,input.revisionId,input.actorUserId?'person':'system',input.actorUserId??null,input.actorUserId??null,input.revisionId,`content-view:${input.revisionId}:${randomUUID()}`,new Date(now).toISOString());
    }); }
  };
  return commands;
}

/** Atomic with golden promotion/retirement; never opens a nested transaction. */
export function getOrCreateSqliteRegressionRevision(db:DatabaseSync,projectId:string,criterionVersionId:string,actorUserId?:string):string {
  if(!db.isTransaction)throw new Error('Regression snapshot requires an owned transaction');
  const {one,all,run}=evaluationDatabase(db);
  if(!one('SELECT 1 FROM criterion_versions WHERE project_id=? AND id=?',projectId,criterionVersionId))throw new DatasetRevisionConflictError('Criterion version does not belong to this project');
  const rows=all('SELECT g.*,c.normalized_payload FROM golden_set_entries g JOIN cases c ON c.project_id=g.project_id AND c.id=g.case_id WHERE g.project_id=? AND g.criterion_version_id=? AND g.retired_at IS NULL ORDER BY g.promoted_at,g.id',projectId,criterionVersionId);
  const prepared=rows.map(row=> {
    const identity=one('SELECT input_digest FROM case_input_identity_records WHERE project_id=? AND source_case_id=? ORDER BY created_at,id LIMIT 1',projectId,row.case_id);
    if(!identity)throw new DatasetRevisionConflictError('Case has no retained pre-redaction input identity');
    const payloadSnapshot=snapshot(row.normalized_payload),matching=all("SELECT v.* FROM verdicts v JOIN skill_versions s ON s.project_id=v.project_id AND s.id=v.skill_version_id WHERE v.project_id=? AND v.case_id=? AND s.criterion_version_id=? AND v.source IN ('human','adjudicated') ORDER BY v.created_at,v.id",projectId,row.case_id,criterionVersionId).map(verdict).filter(v=>verdictLabelFromPayload(v.payload)===row.agreed_label);
    const provenance:DatasetReferenceProvenance={kind:'golden_promotion',sourceId:row.id,verdictIds:matching.map(v=>v.id),actorUserIds:matching.flatMap(v=>v.actorUserId?[v.actorUserId]:[]),basis:'Visible golden promotion; known-failure governance, not sealed validation.'};
    return {row,payloadSnapshot,provenance,inputDigest:identity.input_digest,itemDigest:datasetRevisionItemDigest({inputIdentity:{basis:'input-identity/v1',digest:identity.input_digest},redactedPayload:payloadSnapshot,referenceLabel:row.agreed_label,expectedFailStep:null,reviewProvenance:provenance,note:row.reason})};
  });
  const digests=prepared.map(value=>value.itemDigest),revisionDigest=datasetRevisionDigest({role:'regression_golden',itemDigests:digests});
  const pointer=one('SELECT r.id,r.revision_digest FROM criterion_regression_revisions p JOIN dataset_revisions r ON r.id=p.revision_id WHERE p.project_id=? AND p.criterion_version_id=?',projectId,criterionVersionId);
  if(pointer?.revision_digest===revisionDigest)return pointer.id;
  const id=`dsr_${randomUUID()}`,series=`golden:${projectId}:${criterionVersionId}`,stamp=new Date().toISOString();
  const parent=one('SELECT id,revision_number FROM dataset_revisions WHERE project_id=? AND series_id=? ORDER BY revision_number DESC LIMIT 1',projectId,series);
  run(`INSERT INTO dataset_revisions(id,project_id,series_id,revision_number,parent_revision_id,role,source_kind,identity_basis,content_digest,revision_digest,item_count,provenance_level,created_by_user_id,created_at,criterion_version_id) VALUES(?,?,?,?,?,'regression_golden','golden_snapshot','input-identity/v1',?,?,?,?,?,?,?)`,id,projectId,series,(parent?.revision_number??0)+1,parent?.id??null,datasetRevisionContentDigest(digests),revisionDigest,prepared.length,prepared.length&&prepared.every(value=>value.provenance.verdictIds.length)?'reviewed_unblinded':'legacy',actorUserId??null,stamp,criterionVersionId);
  for(const [position,value] of prepared.entries())run('INSERT INTO dataset_revision_items VALUES(?,?,?,?,?,?,NULL,?,?,?,?,?,NULL,?,?,?)',`dsri_${randomUUID()}`,id,projectId,position,value.row.case_id,value.row.trace_id,value.row.id,value.inputDigest,value.itemDigest,json(value.payloadSnapshot),value.row.agreed_label,json(value.provenance),value.row.reason,stamp);
  run(`INSERT INTO dataset_exposure_events VALUES(?,?,?,NULL,'created','lineage','revision_create',?,?,?,'dataset_revision',?,NULL,'{}',?,?)`,`dse_${randomUUID()}`,projectId,id,actorUserId?'person':'system',actorUserId??null,actorUserId??null,id,`revision-created:${id}`,stamp);
  run(`INSERT INTO dataset_exposure_events VALUES(?,?,?,NULL,'legacy_pretracking','development','legacy_import','system','golden-registry',?,'golden_registry',NULL,NULL,'{}',?,?)`,`dse_${randomUUID()}`,projectId,id,actorUserId??null,`regression-visible:${id}`,stamp);
  run('INSERT INTO dataset_revision_finalizations VALUES(?,?)',id,projectId);
  run('INSERT INTO criterion_regression_revisions VALUES(?,?,?,?) ON CONFLICT(project_id,criterion_version_id) DO UPDATE SET revision_id=excluded.revision_id,updated_at=excluded.updated_at',projectId,criterionVersionId,id,stamp);
  return id;
}
