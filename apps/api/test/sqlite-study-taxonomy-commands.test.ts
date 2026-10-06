import { expect,it } from 'vitest';
import { fixture,freeze,draftStudy,studyEvent,itemEvent } from './helpers/sqlite-analysis.js';
import { first } from './helpers/sqlite-taxonomy.js';
import { sqliteStudyTaxonomyCommands } from '../src/storage/sqlite/study-taxonomy-commands.js';
import { sqliteStudyAssignmentCommands } from '../src/storage/sqlite/study-assignment-commands.js';
import { studyCoverage } from '../src/storage/sqlite/study-projections.js';
import { closeStudy } from './helpers/sqlite-closure.js';

it('creates and revises complete taxonomies with stable code identity and historical replay',async()=>{
 const f=await fixture(),actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const},commands=sqliteStudyTaxonomyCommands(f.db);
 const input={name:'Failures',description:'Human authored',reason:'Initial taxonomy',idempotencyKey:'create',codes:[first]};
 const initial=commands.studyTaxonomyCreate(actor,input),taxonomyId=initial.taxonomy.id,code=initial.revision.codes[0]!;
 expect(initial.replayed).toBe(false);expect(()=>commands.studyTaxonomyCreate({...actor,projectRole:'member'},input)).toThrow(/forbidden/);
 expect(()=>commands.studyTaxonomyCreate(actor,{...input,idempotencyKey:'another'})).toThrow(/single/);
 const successor={expectedPredecessorRevisionId:initial.revision.revision.id,expectedPredecessorRevisionDigest:initial.revision.revision.revisionDigest,expectedPredecessorSequence:1,reason:'Retire code',idempotencyKey:'revise',codes:[{kind:'existing' as const,codeId:code.codeId,label:code.label,definition:code.definition,status:'retired' as const}]};
 const revised=commands.studyTaxonomyRevise(actor,taxonomyId,successor);expect(revised.revision.revision.sequence).toBe(2);expect(revised.revision.codes[0]?.codeId).toBe(code.codeId);
 expect(commands.studyTaxonomyCreate(actor,input).revision.revision.id).toBe(revised.revision.revision.id);
 expect(commands.studyTaxonomyRevise(actor,taxonomyId,successor).replayed).toBe(true);
 expect(()=>commands.studyTaxonomyRevise(actor,taxonomyId,{...successor,idempotencyKey:'stale'})).toThrow(/head mismatch/);
 expect(()=>commands.studyTaxonomyRevise(actor,taxonomyId,{...successor,expectedPredecessorRevisionId:revised.revision.revision.id,expectedPredecessorRevisionDigest:revised.revision.revision.revisionDigest,expectedPredecessorSequence:2,idempotencyKey:'unknown',codes:[...successor.codes,{...successor.codes[0]!,codeId:'unknown',label:'Unknown code',status:'active'}]})).toThrow(expect.objectContaining({code:'analysis_taxonomy_conflict'}));
 expect(f.db.prepare('SELECT count(*) n FROM analysis_failure_taxonomy_revisions').get()?.n).toBe(2);
 expect(()=>commands.studyTaxonomyRevise(actor,taxonomyId,{...successor,expectedPredecessorRevisionId:revised.revision.revision.id,expectedPredecessorRevisionDigest:revised.revision.revision.revisionDigest,expectedPredecessorSequence:2,idempotencyKey:'reactivate',codes:[{...successor.codes[0]!,status:'active'}]})).toThrow(/stable codes/);
});
it('pins assignment successors to exact observation and taxonomy history',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);const observation=itemEvent(f,'failure_observed');
 const actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const};const taxonomy=sqliteStudyTaxonomyCommands(f.db).studyTaxonomyCreate(actor,{name:'Failures',description:'Human authored',reason:'Initial taxonomy',idempotencyKey:'create',codes:[first]});
 const commands=sqliteStudyAssignmentCommands(f.db),input={eventType:'assigned' as const,observationEventId:String(observation.id),taxonomyRevisionId:taxonomy.revision.revision.id,codeId:taxonomy.revision.codes[0]!.codeId,expectedVersion:'0',expectedPredecessorEventId:null,expectedPredecessorEventDigest:null,rationale:'Exact code matches failure',idempotencyKey:'assign'};
 const assigned=commands.studyAssignmentAppend(actor,taxonomy.taxonomy.id,input);expect(assigned.replayed).toBe(false);
 expect(studyCoverage(f.db,f.projectId,'study',taxonomy.revision.revision.id)?.categorized).toBe('1');
 expect(()=>commands.studyAssignmentAppend(actor,taxonomy.taxonomy.id,{...input,idempotencyKey:'stale'})).toThrow(expect.objectContaining({code:'analysis_assignment_conflict'}));
 const withdrawn=commands.studyAssignmentAppend(actor,taxonomy.taxonomy.id,{...input,eventType:'withdrawn',codeId:null,expectedVersion:'1',expectedPredecessorEventId:assigned.event.id,expectedPredecessorEventDigest:assigned.event.eventDigest,idempotencyKey:'withdraw'});
 expect(withdrawn.event.version).toBe('2');expect(studyCoverage(f.db,f.projectId,'study',taxonomy.revision.revision.id)?.uncategorized).toBe('1');
 expect(commands.studyAssignmentAppend(actor,taxonomy.taxonomy.id,input).event).toEqual(assigned.event);
 closeStudy(f,{now:f.now+100});
 expect(()=>commands.studyAssignmentAppend(actor,taxonomy.taxonomy.id,{...input,expectedVersion:'2',expectedPredecessorEventId:withdrawn.event.id,expectedPredecessorEventDigest:withdrawn.event.eventDigest,idempotencyKey:'closed'})).toThrow(expect.objectContaining({code:'analysis_assignment_conflict'}));
 expect(()=>commands.studyAssignmentAppend({...actor,projectId:'foreign'},taxonomy.taxonomy.id,input)).toThrow(/forbidden/);
});
it.each(['retired code','old revision','withdrawn observation'])('returns assignment conflict for %s',async fault=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);const observation=itemEvent(f,'failure_observed');
 const actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const},taxonomies=sqliteStudyTaxonomyCommands(f.db);
 const initial=taxonomies.studyTaxonomyCreate(actor,{name:'Failures',description:'Human authored',reason:'Initial taxonomy',idempotencyKey:'create',codes:[first]});
 const code=initial.revision.codes[0]!;let revisionId=initial.revision.revision.id;
 if(fault==='withdrawn observation')itemEvent(f,'failure_withdrawn',{target:observation});
 else{
  const revised=taxonomies.studyTaxonomyRevise(actor,initial.taxonomy.id,{expectedPredecessorRevisionId:revisionId,expectedPredecessorRevisionDigest:initial.revision.revision.revisionDigest,expectedPredecessorSequence:1,reason:'Taxonomy update',idempotencyKey:'revision',codes:[{kind:'existing',codeId:code.codeId,label:code.label,definition:code.definition,status:fault==='retired code'?'retired':'active'}]});
  if(fault==='retired code')revisionId=revised.revision.revision.id;
 }
 expect(()=>sqliteStudyAssignmentCommands(f.db).studyAssignmentAppend(actor,initial.taxonomy.id,{eventType:'assigned',observationEventId:String(observation.id),taxonomyRevisionId:revisionId,codeId:code.codeId,expectedVersion:'0',expectedPredecessorEventId:null,expectedPredecessorEventDigest:null,rationale:'Code assignment',idempotencyKey:'assign'})).toThrow(expect.objectContaining({code:'analysis_assignment_conflict'}));
 expect(f.db.prepare('SELECT * FROM analysis_observation_assignment_events').all()).toEqual([]);
});
