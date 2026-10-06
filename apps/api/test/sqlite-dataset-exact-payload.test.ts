import { expect,it } from 'vitest';
import type { SQLInputValue } from 'node:sqlite';
import { governedDraftFixture } from './helpers/sqlite-governed-draft.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { datasetRevisionContentDigest,datasetRevisionDigest,datasetRevisionItemDigest } from '../src/lib/dataset-revision.js';
const normal={input:'Q',output:'A',metadata:{}};
const provenance={kind:'unlabeled',sourceId:'synthetic',verdictIds:[],actorUserIds:[],basis:'No truth'};
it.each(['ordinary-missing-metadata','governed-metadata','trimmed-step','extra-step-key','normalized-digest','unsafe-blind'])('rejects %s without normalizing stored digest inputs',async fault=>{
 const f=await governedDraftFixture(),source=f.db.prepare('SELECT * FROM dataset_revisions WHERE id=?').get(f.revision.id)!;
 const governed=fault.startsWith('governed')||fault==='unsafe-blind';
 let payload:Record<string,unknown>={...normal},hashed:unknown;
 if(fault==='ordinary-missing-metadata')delete payload.metadata;
 if(fault==='trimmed-step')payload.steps=[{name:' step ',input:'Q',output:'A'}];
 if(fault==='extra-step-key')payload.steps=[{name:'step',input:'Q',output:'A',hidden:'discarded'}];
 if(fault==='normalized-digest'){delete payload.metadata;hashed=normal;}
 if(fault==='unsafe-blind'){delete payload.metadata;payload.referenceLabel='pass';}
 const digest=datasetRevisionItemDigest({inputIdentity:{basis:'input-identity/v1',digest:'sha256:'+'a'.repeat(64)},redactedPayload:hashed??payload,referenceLabel:null,expectedFailStep:null,reviewProvenance:provenance,note:null});
 expect(()=>sqliteCommand(f.db,c=>{
  const revision:Record<string,SQLInputValue>={...source,id:'attempt',series_id:'attempt',source_dataset_id:null,criterion_version_id:f.criterionVersionId,provenance_level:governed?'governed_blind':'unverified',item_count:1,content_digest:datasetRevisionContentDigest([digest]),revision_digest:datasetRevisionDigest({role:'iterative_development',itemDigests:[digest]}),idempotency_key:'attempt',created_at:c.timestamp};
  c.db.prepare(`INSERT INTO dataset_revisions(${Object.keys(revision).join(',')}) VALUES(${Object.keys(revision).map(()=>'?').join(',')})`).run(...Object.values(revision));
  c.db.prepare('INSERT INTO dataset_revision_items(id,revision_id,project_id,position,input_digest,item_digest,payload_snapshot,reference_provenance,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('attempt-item','attempt',f.projectId,0,'sha256:'+'a'.repeat(64),digest,JSON.stringify(payload),JSON.stringify(provenance),c.timestamp);
  c.db.prepare("INSERT INTO dataset_exposure_events(id,project_id,revision_id,kind,exposure_class,activity,subject_kind,details,idempotency_key,occurred_at) VALUES('attempt-exposure',?,'attempt','created','lineage','revision_create','system','{}','attempt',?)").run(f.projectId,c.timestamp);
  c.db.prepare('INSERT INTO dataset_revision_finalizations VALUES(?,?)').run('attempt',f.projectId);
 })).toThrow(/dataset item digest mismatch|metadata-free revision payload|authoritative truth links|same-command frozen batch/);
 expect(f.db.prepare("SELECT id FROM dataset_revisions WHERE id='attempt'").get()).toBeUndefined();
});
