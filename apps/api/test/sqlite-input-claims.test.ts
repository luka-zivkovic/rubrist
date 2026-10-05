import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, migrateSqlite } from '@rubrist/db/sqlite';
import { createUnseededSqliteRuntime } from './helpers/sqlite.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { sqliteDatasetRevisionCommands } from '../src/storage/sqlite/dataset-revision-commands.js';
import { datasetInputIdentity, datasetRevisionItemDigest, datasetRevisionContentDigest, datasetRevisionDigest } from '../src/lib/dataset-revision.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs();});
it('keeps one durable input class across concurrent imports, restart, retention and tenant erasure',async()=>{
 vi.stubEnv('BETTER_AUTH_SECRET','sqlite-identity-test-secret-at-least-32-characters');
 const dir=mkdtempSync(join(tmpdir(),'rubrist-input-claims-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'db.sqlite'),runtime=await createUnseededSqliteRuntime(path);cleanup.push(()=>runtime.close());
 const {user}=await runtime.auth.api.signUpEmail({body:{email:'owner@example.test',password:'synthetic-long-password',name:'Owner'}});
 const {projectId}=await runtime.accounts.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
 const peer=await createUnseededSqliteRuntime(path);cleanup.push(()=>peer.close());
 const payload={input:{question:'Visible 😀'},output:'Answer',metadata:{}};
 const digest=datasetInputIdentity(payload).digest;
 const [one,two]=await Promise.all([runtime.repository.importTrace(projectId,'manual',payload,{ingestionPurpose:'analysis_eligible_manual'}),peer.repository.importTrace(projectId,'manual',payload,{ingestionPurpose:'analysis_eligible_manual'})]);
 const db=openSqlite(path);cleanup.push(()=>db.close());
 expect(db.prepare('SELECT usage_class FROM governed_input_identity_claims WHERE project_id=? AND input_digest=?').all(projectId,digest)).toEqual([{usage_class:'nonsealed'}]);
 expect(()=>sqliteCommand(db,context=>context.db.prepare('INSERT INTO governed_input_identity_claims VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(projectId,digest,'sealed',context.timestamp))).toThrow(/opposite evidence/);
 expect(()=>db.prepare("UPDATE governed_input_identity_claims SET usage_class='sealed' WHERE project_id=?").run(projectId)).toThrow(/immutable/);
 expect(()=>db.prepare('DELETE FROM governed_input_identity_claims WHERE project_id=?').run(projectId)).toThrow(/project erasure/);
 const protectedPayload={input:{question:'Never shown'},output:'Answer',metadata:{}};
 const protectedDigest=datasetInputIdentity(protectedPayload).digest;
 sqliteCommand(db,context=>context.db.prepare('INSERT INTO governed_input_identity_claims VALUES(?,?,?,?)').run(projectId,protectedDigest,'sealed',context.timestamp));
 const count=db.prepare('SELECT count(*) n FROM cases').get()!.n;
 await expect(runtime.repository.importTrace(projectId,'manual',protectedPayload,{ingestionPurpose:'analysis_eligible_manual'})).rejects.toThrow(/opposite evidence/);
 expect(db.prepare('SELECT count(*) n FROM cases').get()!.n).toBe(count);
 // Retain claims even after raw traffic has gone; this is not a case FK.
 db.prepare('DELETE FROM cases WHERE id IN (?,?)').run(one.caseId,two.caseId);
 const reopened=openSqlite(path);cleanup.push(()=>reopened.close());
 expect(reopened.prepare('SELECT count(*) n FROM governed_input_identity_claims WHERE project_id=?').get(projectId)?.n).toBe(2);
 expect(()=>reopened.prepare('INSERT INTO governed_input_identity_claims VALUES(?,?,?,?)').run(projectId,'sha256:'+'a'.repeat(64),'nonsealed',new Date().toISOString())).toThrow(/function/);
 await runtime.repository.deleteProject(projectId,{confirmProjectName:'Default Project'});
 expect(db.prepare('SELECT count(*) n FROM governed_input_identity_claims').get()?.n).toBe(0);
 expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('creates revision-item claims atomically and rejects an opposite preexisting claim through direct SQL',()=>{
 const db=openSqlite(':memory:');cleanup.push(()=>db.close());migrateSqlite(db);sqliteDatasetRevisionCommands(db);
 const stamp=new Date().toISOString();
 db.prepare('INSERT INTO organizations VALUES(?,?,?)').run('org','Org',stamp);
 db.prepare('INSERT INTO projects(id,organization_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('project','org','Project',stamp,stamp);
 const payload={input:'revision-only',output:'y',metadata:{}},inputDigest=datasetInputIdentity(payload).digest;
 const provenance={kind:'unlabeled' as const,sourceId:'fixture',verdictIds:[],actorUserIds:[],basis:'Fixture'};
 const itemDigest=datasetRevisionItemDigest({inputIdentity:{basis:'input-identity/v1',digest:inputDigest},redactedPayload:payload,referenceLabel:null,expectedFailStep:null,reviewProvenance:provenance,note:null});
 const append=(revisionId:string)=>sqliteCommand(db,context=>{
  context.db.prepare(`INSERT INTO dataset_revisions(id,project_id,series_id,revision_number,role,source_kind,identity_basis,content_digest,revision_digest,item_count,provenance_level,created_at)
   VALUES(?,'project',?,1,'analysis_authoring','collection_snapshot','input-identity/v1',?,?,1,'unverified',?)`).run(revisionId,revisionId,datasetRevisionContentDigest([itemDigest]),datasetRevisionDigest({role:'analysis_authoring',itemDigests:[itemDigest]}),context.timestamp);
  context.db.prepare(`INSERT INTO dataset_revision_items(id,project_id,revision_id,position,input_digest,item_digest,payload_snapshot,reference_provenance,created_at)
   VALUES(?,'project',?,0,?,?,?,?,?)`).run('item-'+revisionId,revisionId,inputDigest,itemDigest,JSON.stringify(payload),JSON.stringify(provenance),context.timestamp);
  expect(context.db.prepare('SELECT usage_class FROM governed_input_identity_claims WHERE input_digest=?').get(inputDigest)?.usage_class).toBe('nonsealed');
  // A late bundle failure must not leave a visible ownership claim behind.
  throw new Error('rollback fixture');
 });
 expect(()=>append('uncommitted')).toThrow('rollback fixture');
 expect(db.prepare('SELECT count(*) n FROM governed_input_identity_claims').get()?.n).toBe(0);
 sqliteCommand(db,context=>context.db.prepare('INSERT INTO governed_input_identity_claims VALUES(?,?,?,?)').run('project',inputDigest,'sealed',context.timestamp));
 expect(()=>append('opposite')).toThrow(/opposite evidence/);
 expect(db.prepare('SELECT count(*) n FROM dataset_revision_items').get()?.n).toBe(0);
 expect(db.prepare('SELECT usage_class FROM governed_input_identity_claims').get()?.usage_class).toBe('sealed');
});
