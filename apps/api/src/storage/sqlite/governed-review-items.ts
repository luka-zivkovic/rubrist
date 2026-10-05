import type { SQLInputValue } from 'node:sqlite';
import type { SqliteCommandContext } from './command-context.js';
import { stableId } from '../../governed-review/storage-values.js';
import { projectGovernedReviewPayload } from '../../governed-review/projection.js';
import { governedReviewRequestDigest } from '../../lib/governed-review.js';
import { governedJsonTextDigest } from './governed-json-text.js';
import { GovernedReviewIdempotencyConflictError,GovernedReviewNotFoundError } from '../../governed-review/errors.js';
export function materializeNonsealedReviewItem(c:SqliteCommandContext,projectId:string,revisionId:string,sourceId:string,creatorSubjectId:string){
 const source=c.db.prepare('SELECT i.* FROM dataset_revision_items i JOIN dataset_revisions r ON r.project_id=i.project_id AND r.id=i.revision_id WHERE i.project_id=? AND i.revision_id=? AND i.id=? AND r.role<>\'sealed_validation\'').get(projectId,revisionId,sourceId);
 if(!source)throw new GovernedReviewNotFoundError();
 const id=stableId('gri',projectId,'dataset-revision-item',sourceId),payload=projectGovernedReviewPayload(JSON.parse(String(source.payload_snapshot)));
 const redactionProvenance={contract:'rubrist/governed-review-projection/v1',source:'immutable_dataset_revision',copiedFields:['input','output','steps'],metadataAccepted:false};
 const content={identityBasis:'input-identity/v1',inputDigest:source.input_digest,redactionProvenance,reviewPayloadProjectionVersion:'governed-review-payload/v1',reviewPayloadSnapshot:payload,sealedFramePosition:null,sealedIntakePopulationId:null,sealedPredecessorRevisionId:null,sealedPredecessorRevisionItemId:null,sourceKind:'dataset_revision_item',sourceItemDigest:source.item_digest,sourceRevisionId:revisionId,sourceRevisionItemId:sourceId};
 const contentDigest=governedJsonTextDigest('governed-review-item/v1',JSON.stringify(content));
 const retained=c.db.prepare('SELECT content_digest FROM governed_review_items WHERE project_id=? AND id=?').get(projectId,id);
 if(retained){if(retained.content_digest!==contentDigest)throw new GovernedReviewIdempotencyConflictError();return {id,digest:contentDigest,sourceId};}
 const row:Record<string,SQLInputValue>={id,project_id:projectId,source_kind:'dataset_revision_item',source_revision_id:revisionId,source_revision_item_id:sourceId,identity_basis:'input-identity/v1',input_digest:source.input_digest!,source_item_digest:source.item_digest!,review_payload_projection_version:'governed-review-payload/v1',review_payload_snapshot:JSON.stringify(payload),redaction_provenance:JSON.stringify(redactionProvenance),content_digest:contentDigest,idempotency_key:'source-revision-item:'+sourceId,request_digest:governedReviewRequestDigest({sourceRevisionId:revisionId,sourceRevisionItemId:sourceId,payload}),created_by_subject_id:creatorSubjectId,created_at:c.timestamp};
 c.db.prepare(`INSERT INTO governed_review_items(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 return {id,digest:contentDigest,sourceId};
}
