import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  CreateCriterionInputSchema, CreateCriterionVersionInputSchema, SkillVersionSchema,
  CriterionSchema, CriterionVersionSchema, EVALUATOR_EXECUTION_AUTHORIZATION_VERSION,
  type Skill, type SkillVersion, type EvaluatorExecutionContext
} from '@rubrist/shared';
import type { RubristRepository } from '../../repository.js';
import { NoCurrentSkillError, AmbiguousProjectSkillError, CriterionStableKeyConflictError } from '../../repository/errors.js';
import { criterionVersionDigest } from '../../lib/criterion-digest.js';
import { executionBindingFromInput } from '../../lib/execution-binding.js';
import { evaluatorExecutionAuthorizationDigest } from '../../lib/evaluator-lifecycle.js';
import { endpointBaseUrlDigest } from '../../lib/evaluator-identity.js';
import { governedContentV1Digest } from '../../lib/governed-content-digest.js';

type Args<K extends keyof RubristRepository> = Parameters<RubristRepository[K]>;
type Row = Record<string, any>;
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const json = (value: unknown) => value == null ? null : JSON.stringify(value);
const parse = (value: unknown) => value == null ? null : JSON.parse(String(value));
function version(row: Row): SkillVersion {
  return SkillVersionSchema.parse({id:row.id,skillId:row.skill_id,criterionVersionId:row.criterion_version_id,version:row.version,status:row.status,
    rubricMarkdown:row.rubric_markdown,prompt:row.prompt,typedQuestion:parse(row.typed_question),decisionThreshold:row.decision_threshold,
    outputSchema:parse(row.output_schema),executionBinding:parse(row.execution_binding),customEndpointUrl:row.custom_endpoint_url,
    goldenSetAgreement:row.golden_set_agreement,tooStrictCount:row.too_strict_count,tooLenientCount:row.too_lenient_count,
    ambiguousCount:row.ambiguous_count,knownLimitations:parse(row.known_limitations),verdictKind:row.verdict_kind,
    scalarRange:parse(row.scalar_range),categoricalChoiceScores:parse(row.categorical_choice_scores),rubricProvenance:row.rubric_provenance,
    rubricProvenanceDeclared:Boolean(row.rubric_provenance_declared),regressionDatasetRevisionId:row.regression_dataset_revision_id,
    onboardingAssurance:row.onboarding_assurance,createdAt:row.created_at,approvedAt:row.approved_at});
}
function criterion(row: Row) {
  return CriterionSchema.parse({id:row.id,projectId:row.project_id,stableKey:row.stable_key,sourceKind:row.source_kind,
    createdByUserId:row.created_by_user_id,createdAt:row.created_at});
}
function definition(row: Row) {
  return CriterionVersionSchema.parse({id:row.id,projectId:row.project_id,criterionId:row.criterion_id,revision:row.revision,
    name:row.name,definition:row.definition,criterionDigest:row.criterion_digest,sourceKind:row.source_kind,
    createdByUserId:row.created_by_user_id,createdAt:row.created_at});
}

export function sqliteDefinitionCommands(db: DatabaseSync) {
  const one = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).get(...args) as Row | undefined;
  const all = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as Row[];
  const run = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args);
  function transaction<T>(work: (now: string) => T): T {
    if (db.isTransaction) throw new Error('Nested SQLite definition command');
    db.exec('BEGIN IMMEDIATE');
    try { const result=work(new Date().toISOString()); db.exec('COMMIT'); return result; }
    catch(error) { if(db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  db.function('sqlite_subject_digest',{deterministic:true},(projectId,subjectId)=>
    governedContentV1Digest('governed-reviewer-subject/v1',{projectId:String(projectId),subjectId:String(subjectId)}));
  db.function('sqlite_criterion_digest',{deterministic:true},(criterionId,criterionVersionId,criterionName,criterionDefinition)=>
    criterionVersionDigest({criterionId:String(criterionId),criterionVersionId:String(criterionVersionId),criterionName:String(criterionName),criterionDefinition:String(criterionDefinition)}));
  db.function('sqlite_execution_authorization_digest',{deterministic:true},(projectId,skillVersionId,context,resourceKind,resourceId)=>
    evaluatorExecutionAuthorizationDigest({projectId:String(projectId),skillVersionId:String(skillVersionId),context:String(context) as EvaluatorExecutionContext,
      resourceKind:String(resourceKind),resourceId:String(resourceId),lifecycleEventId:null,calibrationArtifactId:null}));
  db.function('sqlite_skill_version_valid',{deterministic:true},(id,skillId,criterionVersionId,revision,status,rubric,prompt,typed,threshold,output,binding,url,kind,range,scores)=> {
    try {
      const result=SkillVersionSchema.safeParse({id,skillId,criterionVersionId,version:revision,status,rubricMarkdown:rubric,prompt,
        typedQuestion:parse(typed),decisionThreshold:threshold,outputSchema:parse(output),executionBinding:parse(binding),customEndpointUrl:url,
        verdictKind:kind,scalarRange:parse(range),categoricalChoiceScores:parse(scores),goldenSetAgreement:null,tooStrictCount:0,
        tooLenientCount:0,ambiguousCount:0,knownLimitations:[],rubricProvenance:'unspecified',rubricProvenanceDeclared:false,
        regressionDatasetRevisionId:null,createdAt:'2000-01-01T00:00:00.000Z',approvedAt:null});
      if(!result.success) return 0;
      const value=result.data;
      if(value.executionBinding.provider==='custom') return value.customEndpointUrl!==null && value.executionBinding.endpoint.kind==='custom' &&
        endpointBaseUrlDigest(value.customEndpointUrl)===value.executionBinding.endpoint.baseUrlDigest ? 1 : 0;
      return value.customEndpointUrl===null ? 1 : 0;
    } catch { return 0; }
  });
  function subject(projectId: string, actor: string | undefined, now: string): string | null {
    if(!actor || !one('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?',projectId,actor)) return null;
    const existing=one('SELECT id FROM governed_reviewer_subjects WHERE project_id=? AND account_user_id=?',projectId,actor);
    if(existing) return String(existing.id);
    const subjectId=`grs_${createHash('sha256').update([projectId,actor].join('\0'),'utf8').digest('hex').slice(0,48)}`;
    run('INSERT INTO governed_reviewer_subjects VALUES(?,?,?,?,?)',subjectId,projectId,actor,
      governedContentV1Digest('governed-reviewer-subject/v1',{projectId,subjectId}),now);
    return subjectId;
  }
  function insertDefinition(projectId: string, criterionId: string, revision: number, name: string, text: string, actor: string | undefined, now: string) {
    const versionId=id('criterionv');
    run('INSERT INTO criterion_versions VALUES(?,?,?,?,?,?,?,?,?,?)',versionId,projectId,criterionId,revision,name,text,
      criterionVersionDigest({criterionId,criterionVersionId:versionId,criterionName:name,criterionDefinition:text}),'native',actor??null,now);
    return definition(one('SELECT * FROM criterion_versions WHERE id=?',versionId)!);
  }
  function skill(projectId: string, criterionId?: string, latest=false): Skill {
    if(!criterionId) {
      const count=Number(one('SELECT count(*) n FROM criteria WHERE project_id=?',projectId)!.n);
      if(count>1) throw new AmbiguousProjectSkillError(projectId,count);
    }
    const row=one(`SELECT s.*,u.name owner_name,sv.id version_id FROM skills s
      JOIN skill_versions sv ON sv.skill_id=s.id AND sv.project_id=s.project_id
      JOIN criteria c ON c.id=s.criterion_id AND c.project_id=s.project_id
      LEFT JOIN "user" u ON u.id=s.owner_user_id
      WHERE s.project_id=? ${criterionId?'AND s.criterion_id=?':''} ${latest?'':"AND c.source_kind='native'"}
      ORDER BY ${latest?'':"CASE WHEN sv.status IN ('approved','production') THEN 0 WHEN sv.status IN ('regressing','failed','deprecated') THEN 2 ELSE 1 END,"}
      sv.created_at DESC,sv.id DESC LIMIT 1`,projectId,...(criterionId?[criterionId]:[]));
    if(!row) throw new NoCurrentSkillError(projectId);
    return {id:row.id,projectId,criterionId:row.criterion_id,name:row.name,description:row.description,
      ownerName:row.owner_name??'API key',status:row.status,isStarter:Boolean(row.is_starter),currentVersion:commands.getSkillVersion(projectId,row.version_id)!};
  }
  const commands = {
    listCriteria(projectId: string) { return all('SELECT * FROM criteria WHERE project_id=? ORDER BY created_at,id',projectId).map(criterion); },
    getCriterion(projectId: string, criterionId: string) {
      const row=one('SELECT * FROM criteria WHERE project_id=? AND id=?',projectId,criterionId);
      return row ? {criterion:criterion(row),versions:all('SELECT * FROM criterion_versions WHERE project_id=? AND criterion_id=? ORDER BY revision DESC,id',projectId,criterionId).map(definition)} : null;
    },
    createCriterion(projectId: string, raw: Args<'createCriterion'>[1], context: Args<'createCriterion'>[2]) {
      const input=CreateCriterionInputSchema.parse(raw);
      return transaction(now=>{
        if(one('SELECT 1 FROM criteria WHERE project_id=? AND stable_key=?',projectId,input.stableKey)) throw new CriterionStableKeyConflictError(input.stableKey);
        const criterionId=id('criterion'),skillId=id('skill'),versionId=id('skillv');
        run('INSERT INTO criteria VALUES(?,?,?,?,?,?)',criterionId,projectId,input.stableKey,'native',context.actorUserId??null,now);
        const defined=insertDefinition(projectId,criterionId,1,input.name,input.definition,context.actorUserId,now);
        run('INSERT INTO skills VALUES(?,?,?,?,?,?,?,?,?)',skillId,projectId,criterionId,input.name,input.definition,context.actorUserId??null,'draft',0,now);
        const binding=executionBindingFromInput(input.evaluator.executionBinding);
        const author=subject(projectId,context.actorUserId,now);
        run(`INSERT INTO skill_versions(id,project_id,skill_id,criterion_id,criterion_version_id,version,status,rubric_markdown,prompt,
          output_schema,execution_binding,custom_endpoint_url,verdict_kind,scalar_range,categorical_choice_scores,rubric_provenance,
          rubric_provenance_declared,created_by_user_id,created_by_subject_id,developer_identity_status,created_at)
          VALUES(?,?,?,?,?,'0.1.0','draft',?,?,?,?,?,?,?,?, 'unspecified',0,?,?,?,?)`,versionId,projectId,skillId,criterionId,defined.id,
          input.evaluator.rubricMarkdown,input.evaluator.prompt,JSON.stringify(input.evaluator.outputSchema),JSON.stringify(binding.executionBinding),binding.customEndpointUrl,
          input.evaluator.verdictKind,json(input.evaluator.scalarRange),json(input.evaluator.categoricalChoiceScores),author?context.actorUserId!:null,author,author?'recorded':'unknown_legacy',now);
        return {...commands.getCriterion(projectId,criterionId)!,evaluator:skill(projectId,criterionId)};
      });
    },
    createCriterionVersion(projectId: string, criterionId: string, raw: Args<'createCriterionVersion'>[2], context: Args<'createCriterionVersion'>[3]) {
      const input=CreateCriterionVersionInputSchema.parse(raw);
      return transaction(now=>{
        if(!one('SELECT 1 FROM criteria WHERE project_id=? AND id=?',projectId,criterionId)) return null;
        const revision=Number(one('SELECT coalesce(max(revision),0)+1 n FROM criterion_versions WHERE project_id=? AND criterion_id=?',projectId,criterionId)!.n);
        return insertDefinition(projectId,criterionId,revision,input.name,input.definition,context.actorUserId,now);
      });
    },
    getSkillVersion(projectId: string, versionId: string): SkillVersion | null {
      const row=one('SELECT * FROM skill_versions WHERE project_id=? AND id=?',projectId,versionId);return row?version(row):null;
    },
    getCriterionVersionForSkillVersion(projectId: string, versionId: string) {
      const row=one('SELECT cv.* FROM criterion_versions cv JOIN skill_versions sv ON sv.criterion_version_id=cv.id AND sv.project_id=cv.project_id WHERE sv.project_id=? AND sv.id=?',projectId,versionId);
      return row?definition(row):null;
    },
    getCurrentSkill: (projectId: string) => skill(projectId),
    getCurrentSkillForCriterion: (projectId: string, criterionId: string) => skill(projectId,criterionId),
    getLatestSkill: (projectId: string) => skill(projectId,undefined,true),
    getLatestSkillForCriterion: (projectId: string, criterionId: string) => skill(projectId,criterionId,true),
    listSkillVersions: (projectId: string, skillId: string, limit=50) => all('SELECT * FROM skill_versions WHERE project_id=? AND skill_id=? ORDER BY created_at DESC,id DESC LIMIT ?',projectId,skillId,limit).map(version),
    authorizeSkillVersionExecution(input: Args<'authorizeSkillVersionExecution'>[0]): void {
      transaction(now=>{
        const digest=evaluatorExecutionAuthorizationDigest({...input,lifecycleEventId:null,calibrationArtifactId:null});
        run(`INSERT INTO evaluator_execution_authorizations VALUES(?,?,?,?,?,NULL,NULL,?,?,?,?,?)
          ON CONFLICT(project_id,idempotency_key) DO NOTHING`,id('eauth'),EVALUATOR_EXECUTION_AUTHORIZATION_VERSION,input.projectId,input.skillVersionId,input.context,
          input.resourceKind,input.resourceId,input.idempotencyKey,digest,now);
        if(one('SELECT content_digest FROM evaluator_execution_authorizations WHERE project_id=? AND idempotency_key=?',input.projectId,input.idempotencyKey)?.content_digest!==digest) throw new Error('Execution authorization idempotency key was reused');
      });
    }
  };
  return commands;
}
