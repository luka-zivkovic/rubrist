import { governedDraftFixture } from './sqlite-governed-draft.js';
import { createGovernedSealedIntake } from '../../src/storage/sqlite/governed-sealed-intake-commands.js';
import { CreateGovernedReviewBatchInputSchema } from '../../src/governed-review/contracts.js';
export async function governedSealedDraftFixture(independentCustodian=false){
 const f=await governedDraftFixture(),reviewers:string[]=[];
 for(let i=0;i<2;i++){const {user}=await f.runtime.auth.api.signUpEmail({body:{email:`reviewer${i}@example.test`,password:'synthetic-long-password',name:'Reviewer'}});f.db.prepare('INSERT INTO project_members VALUES(?,?,?,?,?)').run('reviewer-member-'+i,f.projectId,user.id,'member',new Date().toISOString());reviewers.push(user.id);}
 let custodian=f.actor;
 if(independentCustodian){const {user}=await f.runtime.auth.api.signUpEmail({body:{email:'custodian@example.test',password:'synthetic-long-password',name:'Custodian'}});f.db.prepare('INSERT INTO project_members VALUES(?,?,?,?,?)').run('custodian-member',f.projectId,user.id,'owner',new Date().toISOString());custodian={...f.actor,userId:user.id};}
 const intake=createGovernedSealedIntake(f.db,custodian,{populationDefinition:'Protected cohort',timeWindow:{startInclusive:'2026-01-01T01:00:00+01:00',endExclusive:'2026-01-02T00:00:00Z'},items:[{clientItemId:'one',input:'Protected 1',output:'Response 1'},{clientItemId:'two',input:'Protected 2',output:'Response 2'}],idempotencyKey:'sealed'});
 const input=CreateGovernedReviewBatchInputSchema.parse({...f.input,roleIntent:'sealed_validation',source:{kind:'sealed_intake',intakeId:intake.intakeId},reviewerUserIds:reviewers,idempotencyKey:'sealed-draft'});
 return {...f,input,intake,reviewers,custodian};
}
