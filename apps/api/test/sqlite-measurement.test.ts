import {expect,it,vi} from 'vitest';
import {activationFixture} from './helpers/sqlite-lifecycle-activation.js';
import {lifecycleFixture} from './helpers/sqlite-lifecycle.js';
import {measurementReport} from '../src/storage/sqlite/measurement-commands.js';
import {verifyAnalysisWorkflowMeasurementReport} from '../src/lib/analysis-measurement.js';
import {AnalysisMeasurementRepositoryError} from '../src/analysis-measurement/repository.js';
import {sqliteCommand} from '../src/storage/sqlite/command-context.js';
import {createAnalysisMeasurementRouter} from '../src/analysis-measurement/routes.js';
const empty={taxonomyRevisionId:null,skillVersionId:null,calibrationArtifactId:null};
it('projects coding and taxonomy evidence without an evaluator and preserves typed RPC errors',async()=>{
 const f=await lifecycleFixture(),query={...empty,taxonomyRevisionId:f.input.taxonomyRevisionId};
 const local=measurementReport(f.db,f.actor,'study',query)!;
 expect(verifyAnalysisWorkflowMeasurementReport(local)).toEqual(local);
 expect(local.coding).toMatchObject({selectedItemCount:2,completedItemCount:0,inProgressItemCount:1,missingItemCount:1});
 expect(local.taxonomy).toMatchObject({state:'available',coverage:{categorized:'1',uncategorized:'0'}});
 expect(local.evaluatorOptions).toEqual([]);expect(local.evaluator).toBeNull();
 const rpc=await f.runtime.analysisMeasurement.getReport(f.actor,'study',query);expect(rpc?.reportDigest).toBe(local.reportDigest);
 expect(await f.runtime.analysisMeasurement.getReport({...f.actor,projectId:'foreign'},'study',query)).toBeNull();
 await expect(f.runtime.analysisMeasurement.getReport(f.actor,'study',{...empty,calibrationArtifactId:'unbound'})).rejects.toBeInstanceOf(AnalysisMeasurementRepositoryError);
 await expect(f.runtime.analysisMeasurement.getReport(f.actor,'study',{...empty,skillVersionId:'missing'})).rejects.toMatchObject({code:'not_found'});
 await expect(f.runtime.analysisMeasurement.getReport(f.actor,'study',{...empty,taxonomyRevisionId:'missing'})).rejects.toMatchObject({code:'not_found'});
});
it('reads retained aggregate bytes and current admissibility without leaking private evidence',async()=>{
 const f=await activationFixture(),query={taxonomyRevisionId:f.input.taxonomyRevisionId,skillVersionId:f.candidate.skill.currentVersion.id,calibrationArtifactId:f.calibration.artifact.artifactId};
 const report=measurementReport(f.db,f.actor,'study',query)!;
 expect(report.evaluatorOptions).toHaveLength(1);expect(report.evaluator?.calibration).toMatchObject({state:'complete',artifactDigest:f.calibration.artifactCopy.artifactDigest,currentAdmissibility:'admissible'});
 expect(report.evaluator?.timeToFirstCompletedCalibrationArtifact.state).toBe('defined');
 expect(report.evaluator?.timeToFirstCurrentlyAdmissibleCalibrationArtifact.state).toBe('defined');
 expect(JSON.stringify(report)).not.toContain('Independent answer');expect(JSON.stringify(report)).not.toContain('Sealed one');
 sqliteCommand(f.db,c=>c.db.prepare('INSERT INTO binary_calibration_revocation_events VALUES(?,?,?,?,?,?,?,?)').run('measurement-revocation',f.calibration.artifact.artifactId,f.calibration.run.runId,f.projectId,'provider_policy_invalidated','fixture','policy',c.timestamp));
 const current=await f.runtime.analysisMeasurement.getReport(f.actor,'study',query);
 expect(current?.evaluator?.calibration).toMatchObject({state:'complete',currentAdmissibility:'revoked',currentAdmissibilityReasons:['provider_policy_invalidated']});
 expect(current?.evaluator?.timeToFirstCompletedCalibrationArtifact).toEqual(report.evaluator?.timeToFirstCompletedCalibrationArtifact);
 expect(current?.evaluator?.timeToFirstCurrentlyAdmissibleCalibrationArtifact.state).toBe('missing');
 expect(current?.reportDigest).not.toBe(report.reportDigest);
 await expect(f.runtime.analysisMeasurement.getReport(f.actor,'study',{...query,calibrationArtifactId:'foreign'})).rejects.toMatchObject({code:'not_found'});
});
it('fails closed when read artifact bytes do not match retained digest',async()=>{
 const f=await activationFixture(),prepare=f.db.prepare.bind(f.db),spy=vi.spyOn(f.db,'prepare').mockImplementation(sql=>{
  const statement=prepare(sql);if(!sql.includes('artifact.canonical_bytes'))return statement;
  return new Proxy(statement,{get(target,key){if(key==='all')return (...args:any[])=>target.all(...args).map(row=>({...row,canonical_bytes:Buffer.from('{}')}));const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 });
 try{expect(()=>measurementReport(f.db,f.actor,'study',{...empty,skillVersionId:f.candidate.skill.currentVersion.id})).toThrow(/bytes do not match/);}finally{spy.mockRestore();}
 expect(f.db.isTransaction).toBe(false);
});
it('serves session-only measurement HTTP using the SQLite repository',async()=>{
 const f=await lifecycleFixture(),router=createAnalysisMeasurementRouter({repository:f.runtime.analysisMeasurement,databaseMode:true,requestIdentity:()=>({userId:f.userId,projectId:f.projectId}),resolveProjectRole:async()=> 'member'});
 const response=await router.request('/study');expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
 const api=createAnalysisMeasurementRouter({repository:f.runtime.analysisMeasurement,databaseMode:true,requestIdentity:()=>({userId:null,projectId:f.projectId,apiKeyId:'key'}),resolveProjectRole:async()=> 'owner'});
 expect((await api.request('/study')).status).toBe(401);
});
