import { expect,it } from 'vitest';
import { fixture,freeze,cleanup } from './helpers/sqlite-analysis.js';
import { createUnseededSqliteRuntime } from './helpers/sqlite.js';
import { first } from './helpers/sqlite-taxonomy.js';
import { AnalysisStudyRepositoryError } from '../src/analysis-study/repository.js';
import { createApp } from '../src/app.js';

it('serializes concurrent worker commands and restores exact study history across restart',async()=>{
 const f=await fixture();freeze(f);const peer=await createUnseededSqliteRuntime(f.path);cleanup.push(()=>peer.close());
 const actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const},input={populationId:'ap',idempotencyKey:'create'};
 const [a,b]=await Promise.all([f.runtime.analysisStudies.createStudy(actor,input),peer.analysisStudies.createStudy(actor,input)]);
 expect(a.study.study.id).toBe(b.study.study.id);expect([a.reused,b.reused].sort()).toEqual([false,true]);const id=a.study.study.id;
 await expect(peer.analysisStudies.createStudy(actor,{...input,idempotencyKey:'other'})).rejects.toBeInstanceOf(AnalysisStudyRepositoryError);
 await expect(peer.analysisStudies.createStudy(actor,{...input,idempotencyKey:'other'})).rejects.toMatchObject({code:'analysis_study_draw_conflict',details:{studyId:id}});
 await f.runtime.analysisStudies.openStudy(actor,id,{expectedVersion:'0',idempotencyKey:'open',stoppingRule:{kind:'explicit_owner_close',closeAt:null}});
 const items=(await peer.analysisStudies.listStudyItems(actor,id,{limit:10,cursor:null}))!.items;
 for(const item of items){
  const content=await peer.analysisStudies.getStudyItemContent(actor,id,item.item.id);expect(content?.payloadSnapshot.output).toBe('Answer');
  await peer.analysisStudies.appendStudyItemEvent(actor,id,item.item.id,{eventType:'no_failure_observed',expectedVersion:'0',idempotencyKey:'observe',rationale:'No observed failures'});
  await peer.analysisStudies.appendStudyItemEvent(actor,id,item.item.id,{eventType:'coding_completed',expectedVersion:'1',idempotencyKey:'complete'});
 }
 const taxonomy=await peer.analysisStudies.createTaxonomy(actor,{name:'Failures',description:'Human authored',reason:'Initial taxonomy',idempotencyKey:'taxonomy',codes:[first]});
 expect((await peer.analysisStudies.getTaxonomyCoverage(actor,id,taxonomy.revision.revision.id))?.noFailureObservedItemCount).toBe(2);
 const closed=await peer.analysisStudies.closeStudy(actor,id,{expectedVersion:'1',idempotencyKey:'close',reason:'Coding completed'});
 const detail=await peer.analysisStudies.getStudy(actor,id);expect(detail?.summary.closure?.representativeOfPopulationId).toBe('ap');
 await peer.close();const restarted=await createUnseededSqliteRuntime(f.path);cleanup.push(()=>restarted.close());
 expect(await restarted.analysisStudies.getStudy(actor,id)).toEqual(detail);
 expect((await restarted.analysisStudies.completeStudy(actor,id,{expectedVersion:'2',idempotencyKey:'finish',expectedClosureDigest:closed.study.closureDigest!})).study.state).toBe('completed');
});
it('serves authenticated study HTTP routes and restores typed conflicts across RPC',async()=>{
 const f=await fixture();freeze(f);
 const app=createApp(f.runtime.repository,{auth:f.runtime.auth,accounts:f.runtime.accounts,runtimeMode:'persistent',analysisPopulationRepository:f.runtime.analysisPopulations,analysisStudyRepository:f.runtime.analysisStudies});
 const login=await app.request('/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'owner@example.test',password:'synthetic-long-password'})});expect(login.status).toBe(200);
 const headers={cookie:login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),'content-type':'application/json'},body=JSON.stringify({populationId:'ap',idempotencyKey:'http'});
 expect((await app.request('/api/analysis-studies',{method:'POST',body,headers:{'content-type':'application/json'}})).status).toBe(401);
 const created=await app.request('/api/analysis-studies',{method:'POST',body,headers});expect(created.status).toBe(201);
 const {result}=await created.json() as {result:{study:{study:{id:string}}}},id=result.study.study.id;
 const conflict=await app.request('/api/analysis-studies',{method:'POST',headers,body:JSON.stringify({populationId:'ap',idempotencyKey:'different'})});expect(conflict.status).toBe(409);expect(await conflict.json()).toMatchObject({code:'analysis_study_draw_conflict',details:{studyId:id}});
 const opened=await app.request('/api/analysis-studies/'+id+'/open',{method:'POST',headers,body:JSON.stringify({expectedVersion:'0',idempotencyKey:'open',stoppingRule:{kind:'explicit_owner_close',closeAt:null}})});expect(opened.status).toBe(200);
 for(const suffix of ['', '/'+id,'/'+id+'/items'])expect((await app.request('/api/analysis-studies'+suffix,{headers})).status).toBe(200);
});
