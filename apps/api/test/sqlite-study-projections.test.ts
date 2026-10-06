import { expect,it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { fixture,freeze,draftStudy,studyEvent,itemEvent,itemView,assignment } from './helpers/sqlite-analysis.js';
import { closeStudy,completeStudy } from './helpers/sqlite-closure.js';
import { revision,existing } from './helpers/sqlite-taxonomy.js';
import { studyProjection,studyItemProjection,studySummary,studyClosure,studyCoverage,taxonomyRevisionProjection,taxonomyArtifact } from '../src/storage/sqlite/study-projections.js';
import { applyAnalysisStudyItemEvent,initialAnalysisStudyItemProjection } from '../src/lib/analysis-study.js';
import { rowToStudyItemEvent } from '../src/analysis-study/storage-values.js';

it('maps draft, open, closed and completed study summaries without internal fields',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);
 expect(studySummary(f.db,f.projectId,'study')).toMatchObject({study:{state:'draft',currentVersion:'0'},selectedItemCount:2,viewedItemCount:0,completedItemCount:0,closure:null});
 studyEvent(f);itemEvent(f,'no_failure_observed');itemEvent(f,'coding_completed');itemView(f);
 expect(studySummary(f.db,f.projectId,'study')).toMatchObject({study:{state:'coding_open',currentVersion:'1'},viewedItemCount:1,completedItemCount:1});
 closeStudy(f);completeStudy(f);
 const summary=studySummary(f.db,f.projectId,'study')!;
 expect(summary).toMatchObject({study:{state:'completed',currentVersion:'3',closureId:'closure'},closure:{representativeReason:'coding_not_complete'},viewedItemCount:1,completedItemCount:1});
 expect(JSON.stringify(summary)).not.toContain('CommandToken');
 expect(studyClosure(f.db,'foreign','study')).toBeNull();expect(studyProjection(f.db,'foreign','study')).toBeNull();
});
it('projects numeric event order and exact withdrawal history like the shared reducer',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);
 let expected=initialAnalysisStudyItemProjection(studyItemProjection(f.db,f.projectId,'study','study-item-0')!.item);
 for(let i=0;i<6;i++){
  const observed=itemEvent(f,'failure_observed',{now:f.now+10+i*2});
  expected=applyAnalysisStudyItemEvent(expected,rowToStudyItemEvent(observed),'coding_open');
  const withdrawn=itemEvent(f,'failure_withdrawn',{now:f.now+11+i*2,target:observed});
  expected=applyAnalysisStudyItemEvent(expected,rowToStudyItemEvent(withdrawn),'coding_open');
 }
 expect(studyItemProjection(f.db,f.projectId,'study','study-item-0')).toEqual(expected);
 expect(expected.currentVersion).toBe('12');
 const historical=studyItemProjection(f.db,f.projectId,'study','study-item-0',new Date(f.now+20).toISOString())!;
 expect(historical.currentVersion).toBe('11');expect(historical.activeFailureObservationEventIds).toHaveLength(1);
 expect(studyItemProjection(f.db,'foreign','study','study-item-0')).toBeNull();
});
it('projects historical taxonomy coverage and preserves assignment withdrawals',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);revision(f);
 const observed=itemEvent(f,'failure_observed');assignment(f,observed);itemEvent(f,'coding_completed');
 expect(studyCoverage(f.db,f.projectId,'study','revision-1')).toMatchObject({categorized:'1',assignedToRetiredCode:'0',uncategorized:'0',completedItemCount:1});
 const initial=taxonomyRevisionProjection(f.db,f.projectId,'taxonomy','revision-1')!;
 revision(f,[existing('retired')]);
 expect(studyCoverage(f.db,f.projectId,'study','revision-2')).toMatchObject({categorized:'0',assignedToRetiredCode:'1'});
 assignment(f,observed,'withdrawn');
 expect(studyCoverage(f.db,f.projectId,'study','revision-2')).toMatchObject({uncategorized:'1',assignedToRetiredCode:'0'});
 expect(studyCoverage(f.db,f.projectId,'study','revision-1')).toMatchObject({categorized:'1',uncategorized:'0'});
 expect(taxonomyRevisionProjection(f.db,f.projectId,'taxonomy','revision-1')).toEqual(initial);
 expect(taxonomyArtifact(f.db,'foreign')).toBeNull();expect(studyCoverage(f.db,'foreign','study','revision-1')).toBeNull();
});
it('decodes the full signed-bigint version domain without reading a lossy integer',async()=>{
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);
 // Isolate driver decoding from append-only successor validation: reaching this
 // valid contract version through billions of governed inserts is not feasible.
 const db=new DatabaseSync(':memory:');
 try {
  for(const table of ['analysis_studies','analysis_study_events','analysis_study_closures']){
   const columns=f.db.prepare(`PRAGMA table_info(${table})`).all();
   db.exec(`CREATE TABLE ${table}(${columns.map(r=>`${r.name} ${r.type}`).join(',')})`);
   for(const row of f.db.prepare(`SELECT * FROM ${table}`).all()){
    if(table==='analysis_study_events')row.version=9_223_372_036_854_775_807n;
    db.prepare(`INSERT INTO ${table} VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
   }
  }
  expect(studyProjection(db,f.projectId,'study')?.currentVersion).toBe('9223372036854775807');
 }finally{db.close();}
});
