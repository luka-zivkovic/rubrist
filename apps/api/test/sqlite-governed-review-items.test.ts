import { expect,it } from 'vitest';
import { fixture,freeze } from './helpers/sqlite-analysis.js';
import {governedDraftFixture} from './helpers/sqlite-governed-draft.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { materializeNonsealedReviewItem } from '../src/storage/sqlite/governed-review-items.js';
import { governedJsonTextDigest } from '../src/storage/sqlite/governed-json-text.js';
import { stableId } from '../src/governed-review/storage-values.js';
async function prepared(){const f=await governedDraftFixture(),revisionId=f.revision.id,sourceId=String(f.db.prepare("SELECT id FROM dataset_revision_items WHERE revision_id=? AND json_extract(payload_snapshot,'$.output')='Answer 0'").get(revisionId)!.id);const item=sqliteCommand(f.db,c=>materializeNonsealedReviewItem(c,f.projectId,revisionId,sourceId,'subject'));return {...f,item,revisionId,sourceId};}
it('pins safe immutable review payloads to exact source evidence and preserves replay',async()=>{
 const f=await prepared();expect(f.item.id).toBe(stableId('gri',f.projectId,'dataset-revision-item',f.sourceId));
 const row=f.db.prepare('SELECT * FROM governed_review_items WHERE id=?').get(f.item.id)!;
 expect(JSON.parse(String(row.review_payload_snapshot))).toEqual({input:expect.anything(),output:'Answer 0'});
 expect(JSON.parse(String(row.redaction_provenance))).toMatchObject({metadataAccepted:false,source:'immutable_dataset_revision'});
 expect(sqliteCommand(f.db,c=>materializeNonsealedReviewItem(c,f.projectId,f.revisionId,f.sourceId,'subject'))).toEqual(f.item);
 expect(()=>sqliteCommand(f.db,c=>materializeNonsealedReviewItem(c,'foreign',f.revisionId,f.sourceId,'subject'))).toThrow();
 expect(()=>f.db.exec("UPDATE governed_review_items SET input_digest='rewrite'")).toThrow(/immutable/);
 expect(()=>f.db.exec('DELETE FROM governed_review_items')).toThrow(/project erasure/);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('SELECT * FROM governed_review_items').all()).toEqual([]);
});
it.each(['payload','metadata','digest','source','identity','subject','sealed','bounds'])('rejects review item %s forgery in SQL',async fault=>{
 const f=await prepared();expect(()=>sqliteCommand(f.db,c=>{
  const row=c.db.prepare('SELECT * FROM governed_review_items WHERE id=?').get(f.item.id)!;row.id='forged';row.idempotency_key='forged';row.created_at=c.timestamp;
  if(fault==='payload')row.review_payload_snapshot='{"input":"Other question","output":"Changed answer"}';
  if(fault==='metadata')row.review_payload_snapshot='{"input":"Question","output":"Answer","metadata":{"expectedLabel":"pass"}}';
  if(fault==='source')row.source_revision_id='foreign';
  if(fault==='identity')row.input_digest='sha256:'+'0'.repeat(64);
  if(fault==='subject')row.created_by_subject_id='foreign';
  if(fault==='bounds')row.redaction_provenance=JSON.stringify('😀'.repeat(32769));
  if(fault==='sealed'){row.source_kind='sealed_intake';row.source_revision_id=null;row.source_revision_item_id=null;row.source_item_digest=null;row.sealed_intake_population_id='not-yet-supported';row.sealed_frame_position=0;}
  row.content_digest=governedJsonTextDigest('governed-review-item/v1',JSON.stringify({identityBasis:row.identity_basis,inputDigest:row.input_digest,redactionProvenance:JSON.parse(String(row.redaction_provenance)),reviewPayloadProjectionVersion:row.review_payload_projection_version,reviewPayloadSnapshot:JSON.parse(String(row.review_payload_snapshot)),sealedFramePosition:row.sealed_frame_position,sealedIntakePopulationId:row.sealed_intake_population_id,sealedPredecessorRevisionId:row.sealed_predecessor_revision_id,sealedPredecessorRevisionItemId:row.sealed_predecessor_revision_item_id,sourceKind:row.source_kind,sourceItemDigest:row.source_item_digest,sourceRevisionId:row.source_revision_id,sourceRevisionItemId:row.source_revision_item_id}));
  if(fault==='digest')row.content_digest='sha256:'+'0'.repeat(64);
  c.db.prepare(`INSERT INTO governed_review_items(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 })).toThrow();expect(f.db.prepare('SELECT count(*) n FROM governed_review_items').get()?.n).toBe(1);
});

it('requires a completed promotion before materializing any analysis-population review item',async()=>{const f=await fixture();freeze(f);expect(()=>sqliteCommand(f.db,c=>materializeNonsealedReviewItem(c,f.projectId,'rev','item-0','subject'))).toThrow(/completed criterion promotion/);expect(f.db.prepare('SELECT * FROM governed_review_items').all()).toEqual([]);});
