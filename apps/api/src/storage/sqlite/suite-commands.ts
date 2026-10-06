import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CreateEvaluatorSuiteManifestInputSchema, EvaluatorSuiteSchema, RunComparisonSchema } from '@rubrist/shared';
import type { RubristRepository } from '../../repository.js';
import { EvaluatorSuiteBindingError, EvaluatorSuiteIdempotencyConflictError } from '../../repository/errors.js';
import { buildEvaluatorSuiteManifest, canonicalEvaluatorSuiteManifestBytes, parseCanonicalEvaluatorSuiteManifestBytes, evaluatorSuiteArtifactDigest, evaluatorSuiteCreateRequestDigest, suiteMemberEvaluator } from '../../lib/evaluator-suite-manifest.js';
import { canonicalJson } from '../../lib/canonical-json.js';
import { evaluationDatabase, camel, type Row } from './evaluation-values.js';
import { sqliteDefinitionCommands } from './definition-commands.js';
import { sqliteLimit } from './query-values.js';
type Args<K extends keyof RubristRepository> = Parameters<RubristRepository[K]>;
export function sqliteSuiteCommands(db:DatabaseSync) {
  const {one,all,run,transaction}=evaluationDatabase(db),definitions=sqliteDefinitionCommands(db);
  function member(projectId:string,criterionVersionId:string,skillVersionId:string) {
    const row=one(`SELECT cv.* FROM criterion_versions cv JOIN criteria c ON c.project_id=cv.project_id AND c.id=cv.criterion_id JOIN skills s ON s.project_id=c.project_id AND s.criterion_id=c.id JOIN skill_versions v ON v.project_id=s.project_id AND v.skill_id=s.id AND v.criterion_version_id=cv.id WHERE cv.project_id=? AND cv.id=? AND v.id=? AND EXISTS(SELECT 1 FROM evaluator_lifecycle_contexts lc WHERE lc.project_id=v.project_id AND lc.skill_version_id=v.id AND lc.implicit_allowed=1)`,projectId,criterionVersionId,skillVersionId);
    const version=definitions.getSkillVersion(projectId,skillVersionId),evaluator=version?suiteMemberEvaluator(version):null;
    if(!row||!evaluator) throw new EvaluatorSuiteBindingError('Suite member must bind the exact criterion/evaluator version and authorized lifecycle');
    return {criterionId:String(row.criterion_id),criterionVersionId:String(row.id),criterionName:String(row.name),criterionDefinition:String(row.definition),...evaluator};
  }
  db.function('sqlite_suite_manifest_valid',(bytes,id,projectId,suiteId,revision,digest,manifestDigest)=> {
    try {
      const value=Buffer.from(bytes as Uint8Array),manifest=parseCanonicalEvaluatorSuiteManifestBytes(value);
      if(manifest.manifestId!==id||manifest.projectId!==projectId||manifest.suiteId!==suiteId||manifest.revision!==revision||manifest.manifestDigest!==manifestDigest||evaluatorSuiteArtifactDigest(value)!==digest)return 0;
      const expected=buildEvaluatorSuiteManifest({...manifest,members:manifest.members.map(value=>member(String(projectId),value.criterionVersionId,value.skillVersionId))});
      return canonicalJson(expected)===canonicalJson(manifest)?1:0;
    }catch{return 0;}
  });
  function readManifest(row:Row) {
    const bytes=Buffer.from(row.canonical_bytes),manifest=parseCanonicalEvaluatorSuiteManifestBytes(bytes);
    if(evaluatorSuiteArtifactDigest(bytes)!==row.artifact_digest||manifest.manifestId!==row.id||manifest.projectId!==row.project_id||manifest.suiteId!==row.suite_id||manifest.revision!==row.revision||manifest.manifestDigest!==row.manifest_digest) throw new Error('Stored suite manifest identity mismatch');
    return manifest;
  }
  return {
    listEvaluatorSuites(projectId:string) {return all('SELECT * FROM evaluator_suites WHERE project_id=? ORDER BY created_at DESC,id DESC',projectId).map(row=>EvaluatorSuiteSchema.parse(camel(row)));},
    getEvaluatorSuite(projectId:string,suiteId:string) {const row=one('SELECT * FROM evaluator_suites WHERE project_id=? AND id=?',projectId,suiteId);return row?EvaluatorSuiteSchema.parse(camel(row)):null;},
    createEvaluatorSuiteManifest(projectId:string,raw:Args<'createEvaluatorSuiteManifest'>[1],context:Args<'createEvaluatorSuiteManifest'>[2]) {return transaction(now=> {
      const input=CreateEvaluatorSuiteManifestInputSchema.parse(raw),requestDigest=evaluatorSuiteCreateRequestDigest(input);
      const prior=one('SELECT * FROM evaluator_suite_manifests WHERE project_id=? AND idempotency_key=?',projectId,input.idempotencyKey);
      if(prior) {if(prior.request_digest!==requestDigest)throw new EvaluatorSuiteIdempotencyConflictError(input.idempotencyKey);return readManifest(prior);}
      const suiteId=input.suiteId??`suite_${randomUUID()}`,stamp=new Date(now).toISOString();
      if(input.suiteId) {if(!one('SELECT 1 FROM evaluator_suites WHERE project_id=? AND id=?',projectId,suiteId))throw new EvaluatorSuiteBindingError('Suite not found in this project');}
      else run('INSERT INTO evaluator_suites VALUES(?,?,?,?)',suiteId,projectId,context.actorUserId??null,stamp);
      const members=input.members.map(value=>member(projectId,value.criterionVersionId,value.skillVersionId));
      if(new Set(members.map(value=>value.criterionId)).size!==members.length)throw new EvaluatorSuiteBindingError('Suite requires distinct stable criteria');
      const revision=Number(one('SELECT coalesce(max(revision),0)+1 n FROM evaluator_suite_manifests WHERE project_id=? AND suite_id=?',projectId,suiteId)!.n);
      const manifest=buildEvaluatorSuiteManifest({manifestId:`manifest_${randomUUID()}`,projectId,suiteId,revision,members,trialPlan:input.trialPlan}),bytes=canonicalEvaluatorSuiteManifestBytes(manifest);
      run('INSERT INTO evaluator_suite_manifests VALUES(?,?,?,?,?,?,?,?,?,?,?)',manifest.manifestId,projectId,suiteId,revision,bytes,evaluatorSuiteArtifactDigest(bytes),manifest.manifestDigest,context.actorUserId??null,input.idempotencyKey,requestDigest,stamp);
      return manifest;
    });},
    listEvaluatorSuiteManifests(projectId:string,suiteId?:string) {return all(`SELECT * FROM evaluator_suite_manifests WHERE project_id=? ${suiteId?'AND suite_id=?':''} ORDER BY suite_id,revision DESC,id DESC`,projectId,...(suiteId?[suiteId]:[])).map(readManifest);},
    getEvaluatorSuiteManifest(projectId:string,manifestId:string) {const row=one('SELECT * FROM evaluator_suite_manifests WHERE project_id=? AND id=?',projectId,manifestId);return row?readManifest(row):null;},
    createRunComparison(input:Args<'createRunComparison'>[0]) {return transaction(now=>RunComparisonSchema.parse(camel(one('INSERT INTO run_comparisons VALUES(?,?,?,?,?,?,?,?,?) RETURNING *',`rcmp_${randomUUID()}`,input.projectId,input.datasetId,input.datasetRevisionId??null,input.versionAId,input.versionBId,input.runAId,input.runBId,new Date(now).toISOString())!)));},
    getRunComparison(projectId:string,id:string) {const row=one('SELECT * FROM run_comparisons WHERE project_id=? AND id=?',projectId,id);return row?RunComparisonSchema.parse(camel(row)):null;},
    listRunComparisons(projectId:string,opts:Args<'listRunComparisons'>[1]={}) {return all('SELECT * FROM run_comparisons WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ?',projectId,sqliteLimit(opts.limit??50)).map(row=>RunComparisonSchema.parse(camel(row)));}
  };
}
