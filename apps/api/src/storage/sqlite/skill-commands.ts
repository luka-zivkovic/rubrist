import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MinimumVerdictOutputSchema } from '@rubrist/shared';
import type { RubristRepository } from '../../repository.js';
import { AgentSetupEligibilityError, DatasetRevisionConflictError, OnboardingCheckConflictError, SkillVersionNotSignableError } from '../../repository/errors.js';
import { executionBindingFromInput } from '../../lib/execution-binding.js';
import { criterionVersionDigest } from '../../lib/criterion-digest.js';
import { governedContentV1Digest } from '../../lib/governed-content-digest.js';
import { encryptJson } from '../../lib/encryption.js';
import { judgeKeyDisplay } from '../../repository/helpers.js';
import { evaluationDatabase, json } from './evaluation-values.js';
import { sqliteSkillVersion } from './definition-commands.js';
import { getOrCreateSqliteRegressionRevision } from './dataset-revision-commands.js';
type Args<K extends keyof RubristRepository> = Parameters<RubristRepository[K]>;
const id=(prefix:string)=>`${prefix}_${randomUUID()}`;
export function sqliteSkillCommands(db:DatabaseSync) {
 const {one,run,transaction}=evaluationDatabase(db);
 function audit(projectId:string,actor:string|undefined,action:string,target:string,metadata:unknown,stamp:string) {
  run('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?,?)',id('audit'),projectId,actor??null,action,'skill_version',target,json(metadata),stamp);
 }
 return {
  signOffSkillVersion(projectId:string,skillId:string,versionId:string,context:Args<'signOffSkillVersion'>[3]) {return transaction(now=>{
   const row=one('SELECT * FROM skill_versions WHERE project_id=? AND skill_id=? AND id=?',projectId,skillId,versionId);if(!row)return null;
   if(row.status!=='draft'||row.approved_at!==null)throw new SkillVersionNotSignableError(versionId,row.status);
   const stamp=new Date(now).toISOString();run("UPDATE skill_versions SET status='approved',approved_at=? WHERE id=?",stamp,versionId);
   run('UPDATE skills SET is_starter=0 WHERE project_id=? AND id=?',projectId,skillId);
   audit(projectId,context.actorUserId,'skill_version.signoff',versionId,{signedOffAsIs:true},stamp);
   return sqliteSkillVersion(one('SELECT * FROM skill_versions WHERE id=?',versionId)!);
  });},
  // Runtime performs strict provider availability validation before this command.
  insertPendingSkillVersion(skillId:string,input:Args<'createSkillVersionPending'>[1],context:Args<'createSkillVersionPending'>[2]) {return transaction(now=>{
   const projectId=context.projectId;
   const latest=one('SELECT created_at,version FROM skill_versions WHERE project_id=? AND skill_id=? ORDER BY rowid DESC LIMIT 1',projectId,skillId);
   const stamp=new Date(Math.max(now,latest?Date.parse(latest.created_at)+1:now)).toISOString();
   const owner=one('SELECT s.*,p.imported_trace_count FROM skills s JOIN projects p ON p.id=s.project_id WHERE s.project_id=? AND s.id=?',projectId,skillId);
   if(!owner)throw new Error(`Skill not found for project: ${skillId}`);
   if(context.onboardingCriterion) {
    const replay=one('SELECT * FROM skill_versions WHERE project_id=? AND skill_id=? AND onboarding_idempotency_key=?',projectId,skillId,context.onboardingCriterion.idempotencyKey);
    if(replay) {if(replay.onboarding_request_digest!==context.onboardingCriterion.requestDigest)throw new OnboardingCheckConflictError('idempotency_conflict','This first-Check request key was already used with different proposal content.');return sqliteSkillVersion(replay);}
   }
   if(context.agentSetup?.pairingId) {
    if(!one('SELECT 1 FROM agent_setup_pairings WHERE id=? AND project_id=? AND claimed_at IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL',context.agentSetup.pairingId,projectId))throw new AgentSetupEligibilityError('pairing_no_longer_active','This setup connection is no longer active.');
    if(!owner.is_starter)throw new AgentSetupEligibilityError('project_already_configured','This project was configured while the connection was outstanding.');
    if(owner.imported_trace_count>0)throw new AgentSetupEligibilityError('project_not_empty','The paired project already has imported cases. Finish setup in the app instead.');
   }
   const criterion=one('SELECT * FROM criteria WHERE project_id=? AND id=?',projectId,owner.criterion_id);if(!criterion)throw new DatasetRevisionConflictError(`Skill ${skillId} has no criterion.`);
   let criterionVersionId:string;
   if(context.onboardingCriterion) {
    if(!owner.is_starter)throw new OnboardingCheckConflictError('project_already_configured',"This project's starter Check has already been configured.");
    if(criterion.source_kind!=='native')throw new OnboardingCheckConflictError('criterion_not_native','Guided onboarding requires a native starter criterion.');
    if(input.criterionVersionId)throw new DatasetRevisionConflictError('Guided onboarding creates and binds its own criterion version.');
    criterionVersionId=id('criterionv');const {name,definition}=context.onboardingCriterion;
    const revision=one('SELECT coalesce(max(revision),0)+1 n FROM criterion_versions WHERE project_id=? AND criterion_id=?',projectId,criterion.id)!.n;
    run('INSERT INTO criterion_versions VALUES(?,?,?,?,?,?,?,?,?,?)',criterionVersionId,projectId,criterion.id,revision,name,definition,criterionVersionDigest({criterionId:criterion.id,criterionVersionId,criterionName:name,criterionDefinition:definition}),'native',context.actorUserId??null,stamp);
   } else {
    if(!input.criterionVersionId&&one('SELECT count(*) n FROM criterion_versions WHERE project_id=? AND criterion_id=?',projectId,criterion.id)!.n>1)throw new DatasetRevisionConflictError('Criteria with multiple immutable definitions require an explicit criterionVersionId when creating an evaluator version.');
    const cv=one('SELECT id FROM criterion_versions WHERE project_id=? AND criterion_id=? AND (? IS NULL OR id=?) ORDER BY revision DESC,id DESC LIMIT 1',projectId,criterion.id,input.criterionVersionId??null,input.criterionVersionId??null);
    if(!cv)throw new DatasetRevisionConflictError(`Skill ${skillId} does not own criterion version ${input.criterionVersionId ?? '(latest)'}.`);criterionVersionId=cv.id;
   }
   const regressionId=getOrCreateSqliteRegressionRevision(db,projectId,criterionVersionId,context.actorUserId);
   let subjectId:string|null=null;
   if(context.actorUserId&&one('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?',projectId,context.actorUserId)) {
    subjectId=one('SELECT id FROM governed_reviewer_subjects WHERE project_id=? AND account_user_id=?',projectId,context.actorUserId)?.id??`grs_${createHash('sha256').update([projectId,context.actorUserId].join('\0')).digest('hex').slice(0,48)}`;
    run('INSERT INTO governed_reviewer_subjects VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',subjectId,projectId,context.actorUserId,governedContentV1Digest('governed-reviewer-subject/v1',{projectId,subjectId}),stamp);
   }
   const previous=latest?.version??'0.0.0';
   const [major='0',minor='0',patch='0']=String(previous).split('.');
   const stored=executionBindingFromInput(input.executionBinding,undefined,{typedQuestion:input.typedQuestion!==undefined});
   const provenance=context.rubricProvenance??input.rubricProvenance??'unspecified';
   const assurance=context.onboardingCriterion||context.agentSetup?'starter_unvalidated':one('SELECT onboarding_assurance FROM skill_versions WHERE project_id=? AND skill_id=? AND onboarding_assurance IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1',projectId,skillId)?.onboarding_assurance??null;
   const row={id:id('skillv'),project_id:projectId,skill_id:skillId,criterion_id:criterion.id,criterion_version_id:criterionVersionId,version:`${major}.${minor}.${Number(patch)+1}`,status:'calibrating',rubric_markdown:input.rubricMarkdown??null,prompt:input.prompt??null,typed_question:json(input.typedQuestion),decision_threshold:input.decisionThreshold??null,output_schema:json(input.outputSchema??MinimumVerdictOutputSchema),execution_binding:json(stored.executionBinding),custom_endpoint_url:stored.customEndpointUrl,verdict_kind:input.verdictKind,scalar_range:input.verdictKind==='scalar'?json(input.scalarRange):null,categorical_choice_scores:input.verdictKind==='categorical'?json(input.categoricalChoiceScores):null,rubric_provenance:provenance,rubric_provenance_declared:Number(provenance!=='unspecified'),regression_dataset_revision_id:regressionId,created_by_user_id:subjectId?context.actorUserId!:null,created_by_subject_id:subjectId,developer_identity_status:subjectId?'recorded':'unknown_legacy',onboarding_assurance:assurance,onboarding_idempotency_key:context.onboardingCriterion?.idempotencyKey??null,onboarding_request_digest:context.onboardingCriterion?.requestDigest??null,created_at:stamp};
   run(`INSERT INTO skill_versions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`,...Object.values(row));
   if(context.agentSetup?.providerCredential) {
    const key=context.agentSetup.providerCredential;
    run('INSERT INTO judge_provider_keys VALUES(?,?,?,?,?) ON CONFLICT(project_id,provider) DO UPDATE SET encrypted_credentials=excluded.encrypted_credentials,key_display=excluded.key_display,created_at=excluded.created_at',projectId,key.provider,encryptJson({apiKey:key.apiKey}),judgeKeyDisplay(key.apiKey),stamp);
    run('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?,?)',id('audit'),projectId,context.actorUserId??null,'project.judge_key.set','judge_provider_key',key.provider,json({provider:key.provider}),stamp);
   }
   run('UPDATE skills SET is_starter=0,name=coalesce(?,name),description=coalesce(?,description) WHERE project_id=? AND id=?',context.onboardingCriterion?.name??context.agentSetup?.skillName??null,context.onboardingCriterion?.definition??context.agentSetup?.skillDescription??null,projectId,skillId);
   if(context.agentSetup?.pairingId)run('UPDATE agent_setup_pairings SET consumed_at=?,claimed_at=NULL WHERE id=? AND project_id=?',stamp,context.agentSetup.pairingId,projectId);
   return sqliteSkillVersion(one('SELECT * FROM skill_versions WHERE id=?',row.id)!);
  });}
 };
}
