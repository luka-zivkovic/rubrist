import { expect,it } from 'vitest';
import { DatabaseSync,type SQLInputValue } from 'node:sqlite';
import { governedFixture } from './helpers/sqlite-governed.js';
import { cleanup } from './helpers/sqlite-analysis.js';
import { createGovernedSealedIntake as create } from '../src/storage/sqlite/governed-sealed-intake-commands.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { governedContentV1Digest } from '../src/lib/governed-content-digest.js';
const input={populationDefinition:'Protected external samples',items:[{clientItemId:'one',input:'Secret question one',output:'Secret answer one'},{clientItemId:'two',input:{question:'Secret question two'},output:'Secret answer two'}],idempotencyKey:'intake'};
it('atomically protects the exact sealed frame and returns a payload-free receipt through peer replay',async()=>{
 const f=await governedFixture(),result=create(f.db,f.actor,input);expect(result).toMatchObject({protection:'sealed',itemCount:2,predecessorRevisionId:null});expect(JSON.stringify(result)).not.toContain('Secret');
 const items=f.db.prepare('SELECT * FROM governed_review_items WHERE sealed_intake_population_id=? ORDER BY sealed_frame_position').all(result.intakeId);
 expect(result.frameDigest).toBe(governedContentV1Digest('governed-sealed-intake-frame/v1',items.map(i=>({framePosition:i.sealed_frame_position,inputDigest:i.input_digest,reviewItemId:i.id}))));
 expect(f.db.prepare("SELECT count(*) n FROM governed_input_identity_claims WHERE usage_class='sealed'").get()?.n).toBe(2);
 const peer=new DatabaseSync(f.path);cleanup.push(()=>peer.close());peer.exec('PRAGMA foreign_keys=ON');sqliteCommands(peer);expect(create(peer,f.actor,input)).toEqual(result);
 expect(()=>create(peer,f.actor,{...input,populationDefinition:'Changed'})).toThrow(expect.objectContaining({code:'governed_review_idempotency_conflict'}));
 expect(()=>create(peer,f.actor,{...input,idempotencyKey:'overlap'})).toThrow(/overlap/);
 await expect(f.runtime.repository.importTrace(f.projectId,'manual',{input:input.items[0]!.input,output:'Different',metadata:{}},{ingestionPurpose:'analysis_eligible_manual'})).rejects.toThrow();
 expect(()=>peer.exec("UPDATE governed_review_items SET review_payload_snapshot='{}'")).toThrow(/immutable/);
 expect(peer.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');expect(peer.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 f.db.prepare("UPDATE project_members SET role='member' WHERE project_id=? AND user_id=?").run(f.projectId,f.userId);expect(()=>create(peer,f.actor,input)).toThrow(expect.objectContaining({code:'governed_review_forbidden'}));
 f.db.prepare("UPDATE project_members SET role='owner' WHERE project_id=? AND user_id=?").run(f.projectId,f.userId);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(peer.prepare('SELECT * FROM governed_sealed_intake_populations').all()).toEqual([]);expect(peer.prepare('SELECT * FROM governed_input_identity_claims').all()).toEqual([]);
});
it('rejects previously visible and duplicate inputs and rolls back all claims after a frame failure',async()=>{
 const f=await governedFixture();expect(()=>create(f.db,f.actor,{...input,items:[{clientItemId:'old',input:{question:'Population 0'},output:'Already visible'}]})).toThrow(/nonsealed/);
 expect(()=>create(f.db,f.actor,{...input,items:[input.items[0]!,{...input.items[0]!,clientItemId:'duplicate'}]})).toThrow(expect.objectContaining({code:'sealed_overlap'}));
 f.db.exec("CREATE TRIGGER test_sealed_frame_failure BEFORE INSERT ON governed_review_items WHEN NEW.source_kind='sealed_intake' AND NEW.sealed_frame_position=1 BEGIN SELECT RAISE(ABORT,'injected frame failure'); END;");
 expect(()=>create(f.db,f.actor,input)).toThrow(/injected frame failure/);expect(f.db.prepare('SELECT count(*) n FROM governed_sealed_intake_populations').get()?.n).toBe(0);expect(f.db.prepare("SELECT count(*) n FROM governed_input_identity_claims WHERE usage_class='sealed'").get()?.n).toBe(0);
});
it.each(['digest','frame','owner','orphan','window'])('rejects forged sealed population %s without leaving intake evidence',async fault=>{
 const f=await governedFixture(),result=create(f.db,f.actor,input),original=f.db.prepare('SELECT * FROM governed_sealed_intake_populations WHERE id=?').get(result.intakeId)!;
 expect(()=>sqliteCommand(f.db,c=>{
  const row:Record<string,SQLInputValue>={...original,id:'forged',idempotency_key:'forged',created_at:c.timestamp,created_command_token:c.token};
  if(fault==='digest')row.content_digest='sha256:'+'0'.repeat(64);if(fault==='frame')row.frame_count=0;if(fault==='owner')row.custodian_subject_id='foreign';if(fault==='window'){row.window_start='2026-01-01T00:00:00.000Z';row.window_end='2025-01-01T00:00:00.000Z';}
  c.db.prepare(`INSERT INTO governed_sealed_intake_populations(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 })).toThrow();expect(f.db.prepare('SELECT count(*) n FROM governed_sealed_intake_populations').get()?.n).toBe(1);
});
it('rejects frame extension after finalization even within another valid managed command',async()=>{
 const f=await governedFixture(),result=create(f.db,f.actor,input),original=f.db.prepare('SELECT * FROM governed_review_items WHERE sealed_intake_population_id=? LIMIT 1').get(result.intakeId)!;
 expect(()=>sqliteCommand(f.db,c=>{const row:Record<string,SQLInputValue>={...original,id:'late',idempotency_key:'late',created_at:c.timestamp,sealed_frame_position:2};c.db.prepare(`INSERT INTO governed_review_items(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));})).toThrow();
});
import {interceptSqliteInsert} from './helpers/sqlite-insert-intercept.js';
it.each(['missing-member','wrong-frame'])('rejects an incomplete or forged positive-count sealed frame: %s',async fault=>{
 const f=await governedFixture(),spy=fault==='missing-member'?interceptSqliteInsert(f.db,'governed_review_items',row=>row.sealed_frame_position===1?null:row):interceptSqliteInsert(f.db,'governed_sealed_intake_populations',row=>{
  row.frame_digest='sha256:'+'0'.repeat(64);
  row.content_digest=governedContentV1Digest('governed-sealed-intake-population/v1',{collectionProvenance:JSON.parse(String(row.collection_provenance)),custodianRoleAtReview:row.custodian_role_at_review,custodianSubjectId:row.custodian_subject_id,frameCount:row.frame_count,frameDigest:row.frame_digest,populationDefinition:JSON.parse(String(row.population_definition)),predecessorRevisionId:row.predecessor_revision_id,windowEnd:row.window_end,windowStart:row.window_start});return row;
 });
 try{expect(()=>create(f.db,f.actor,input)).toThrow(/complete exact frame/);}finally{spy.mockRestore();}
 expect(f.db.prepare('SELECT * FROM governed_sealed_intake_populations').all()).toEqual([]);expect(f.db.prepare("SELECT * FROM governed_input_identity_claims WHERE usage_class='sealed'").all()).toEqual([]);
});
