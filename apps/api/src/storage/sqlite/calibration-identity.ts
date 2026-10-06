import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {MUTABLE_MODEL_ALIAS_RULE_VERSION,mutableModelAlias,type EvaluatorIdentity} from '@rubrist/shared';
import {canonicalJson,sha256Digest} from '../../lib/canonical-json.js';
import {evaluatorIdentityFor,evaluatorOutputContractDigest,skillDigestInput,skillDigestOf} from '../../lib/evaluator-identity.js';
import {governedGateRefusal} from '../../lib/binding-resolution.js';
import type {CreateBinaryCalibrationRunInput} from '../../binary-calibration/repository.js';
import {isEmptyObject,nullableString,parseJson,providerPolicyFor,repoError,type FrozenOriginRow} from '../../binary-calibration/storage-values.js';
import {sqliteSkillVersion} from './definition-commands.js';
import {sqliteResolutionStore} from './resolution-commands.js';
// Native SQLite named parameters keep the evidence query's bindings explicit.
const query=(db:DatabaseSync,sql:string,values:SQLInputValue[])=>({rows:db.prepare(sql).all(Object.fromEntries(values.map((value,index)=>['$'+(index+1),value])))});
export function deriveRunIdentity(
  db: DatabaseSync,
  projectId: string,
  input: CreateBinaryCalibrationRunInput
) {
  const result = query(db,
    `select revision.id as revision_id,revision.revision_digest,revision.content_digest,
            revision.item_count,revision.role,revision.source_kind,revision.provenance_level,
            revision.criterion_version_id,
            criterion.criterion_id,criterion.criterion_digest,
            skill.id as skill_id,version.*,
            batch.id as batch_id,batch.content_digest as batch_content_digest,
            batch.instruction_version_id,batch.population_id,batch.population_digest,
            batch.source_population_id,batch.population_definition,batch.population_collection_provenance,
            batch.population_size,batch.selection_method,batch.selection_seed,batch.rng_version,
            batch.draw_executed_by,batch.fixed_budget,batch.draw_digest,batch.strata,
            batch.custodian_subject_id,
            instruction.content_digest as instruction_digest
     from dataset_revisions revision
     join criterion_versions criterion on criterion.id=revision.criterion_version_id
     join skill_versions version
       on version.id=$3 and version.project_id=revision.project_id
      and version.criterion_version_id=revision.criterion_version_id
     join skills skill on skill.id=version.skill_id and skill.criterion_id=criterion.criterion_id
     join governed_review_batch_events frozen
       on frozen.dataset_revision_id=revision.id and frozen.event_kind='frozen'
     join governed_review_batches batch on batch.id=frozen.batch_id
     join review_instruction_versions instruction on instruction.id=batch.instruction_version_id
     where revision.id=$1 and revision.project_id=$2
       and (SELECT state FROM governed_review_batch_states WHERE batch_id=batch.id)='frozen'`,
    [input.datasetRevisionId, projectId, input.skillVersionId]
  );
  if (result.rows.length !== 1) {
    throw repoError("ineligible", "calibration requires one frozen governed truth origin and exact evaluator criterion");
  }
  const row = result.rows[0]!;
  if (row.role !== "sealed_validation" || row.source_kind !== "sealed_intake" ||
      row.provenance_level !== "governed_blind") {
    throw repoError("ineligible", "calibration requires sealed governed-blind truth");
  }
  if (Number(row.item_count) < 1 || Number(row.item_count) > 5_000 ||
      Number(row.fixed_budget) !== Number(row.item_count)) {
    throw repoError("ineligible", "calibration truth support must be a complete governed selection of at most 5,000 items");
  }
  const skillVersion = sqliteSkillVersion(row);
  if (skillVersion.verdictKind !== "binary") {
    throw repoError("unsupported", "binary calibration requires a binary evaluator version");
  }
  // Calibration runs the evaluator through its executor, one physical call
  // per item: a prompted protocol or typed-question/v1. The mock makes no
  // call, so it can't produce sealed evidence.
  const binding = skillVersion.executionBinding;
  if (binding.provider === "mock") {
    throw repoError("unsupported", "sealed calibration can't run a mock binding; it needs an evaluator on a provider it calls");
  }
  let identity: EvaluatorIdentity;
  try {
    identity = evaluatorIdentityFor(skillVersion);
  } catch (error) {
    throw repoError("unsupported", `sealed calibration requires an evaluator version with a valid evaluator identity (${identityProblem(error)})`);
  }
  if (mutableModelAlias(binding.modelId) !== null) {
    throw repoError(
      "ineligible",
      `sealed calibration requires a pinned model id; "${binding.modelId}" is a mutable alias under ${MUTABLE_MODEL_ALIAS_RULE_VERSION}`
    );
  }
  // Governed gate (ADR-0014 section 2): a resolved binding that states its
  // temperature and reasoning, unless its resolution shows the model
  // rejecting the parameter itself.
  const refusal = governedGateRefusal(binding, sqliteResolutionStore(db).load(projectId,skillVersion.id,binding));
  if (refusal !== null) {
    throw repoError("ineligible", `${refusal.message}. ${refusal.suggestion}${refusal.providerMessage ? ` The provider said: ${refusal.providerMessage}` : ""}`);
  }
  const evaluatorDigests = {
    definitionDigest: skillDigestInput(identity).definitionDigest,
    skillDigest: skillDigestOf(identity),
    outputContractDigest: evaluatorOutputContractDigest(identity.definition),
    requestedBindingDigest: sha256Digest(identity.executionBinding)
  };
  const { policy: providerPolicy, canonicalBytes: providerPolicyBytes } = providerPolicyFor(identity.executionBinding);

  let suiteBinding: { manifestId: string; manifestDigest: string; memberPosition: number } | null = null;
  if (input.suiteBinding) {
    const suite = query(db,
      `select manifest.manifest_digest,'null' as trial_plan,
              json_extract(member.value,'$.skillVersionId') skill_version_id,
              json_extract(member.value,'$.criterionVersionId') criterion_version_id,
              json_extract(member.value,'$.skillDigest') skill_digest,
              json_extract(member.value,'$.outputContractDigest') output_contract_digest
       from evaluator_suite_manifests manifest
       join json_each(CAST(manifest.canonical_bytes AS TEXT),'$.members') member
         on member.key=$3
       where manifest.id=$1 and manifest.project_id=$2
         and json_type(CAST(manifest.canonical_bytes AS TEXT),'$.trialPlan')='null' `,
      [input.suiteBinding.manifestId, projectId, input.suiteBinding.memberPosition]
    );
    const member = suite.rows[0];
    if (!member || canonicalJson(parseJson(member.trial_plan)) !== "null" ||
        String(member.skill_version_id) !== skillVersion.id ||
        String(member.criterion_version_id) !== skillVersion.criterionVersionId ||
        String(member.skill_digest) !== evaluatorDigests.skillDigest ||
        String(member.output_contract_digest) !== evaluatorDigests.outputContractDigest) {
      throw repoError("ineligible", "suite binding is not the exact single-trial evaluator member");
    }
    suiteBinding = {
      manifestId: input.suiteBinding.manifestId,
      manifestDigest: String(member.manifest_digest),
      memberPosition: input.suiteBinding.memberPosition
    };
  }

  const origin: FrozenOriginRow = {
    batch_id: String(row.batch_id),
    batch_content_digest: String(row.batch_content_digest),
    instruction_version_id: String(row.instruction_version_id),
    instruction_digest: String(row.instruction_digest),
    population_id: String(row.population_id),
    population_digest: String(row.population_digest),
    source_population_id: String(row.source_population_id),
    population_definition: parseJson(row.population_definition),
    population_collection_provenance: parseJson(row.population_collection_provenance),
    population_size: Number(row.population_size),
    selection_method: String(row.selection_method),
    selection_seed: nullableString(row.selection_seed),
    rng_version: nullableString(row.rng_version),
    draw_executed_by: String(row.draw_executed_by),
    fixed_budget: Number(row.fixed_budget),
    draw_digest: String(row.draw_digest),
    strata: parseJson(row.strata),
    custodian_subject_id: String(row.custodian_subject_id)
  };
  const representativeness = deriveRepresentativeness(db, origin);
  return {
    revisionDigest: String(row.revision_digest),
    truthContentDigest: String(row.content_digest),
    itemCount: Number(row.item_count),
    criterionId: String(row.criterion_id),
    criterionVersionId: String(row.criterion_version_id),
    criterionDigest: String(row.criterion_digest),
    skillVersion,
    executionBinding: identity.executionBinding,
    ...evaluatorDigests,
    providerPolicy,
    providerPolicyBytes,
    suiteBinding,
    origin: {
      batchId: origin.batch_id,
      batchDigest: origin.batch_content_digest,
      instructionVersionId: origin.instruction_version_id,
      instructionDigest: origin.instruction_digest,
      populationId: origin.population_id,
      populationDigest: origin.population_digest,
      drawDigest: origin.draw_digest,
      selectionMethod: origin.selection_method
    },
    representativeness
  };
}
function deriveRepresentativeness(db: DatabaseSync, origin: FrozenOriginRow): {
  representativeOfPopulationId: string | null;
  reasons: string[];
} {
  const evidence = db.prepare(`SELECT
   ?=(SELECT governed_content_v1_digest('governed-review-draw/v1',json_group_array(json_object('drawPosition',draw_position,'frameMemberDigest',frame_member_digest,'inclusionProbability',json(inclusion_probability),'reviewItemId',review_item_id,'samplingWeight',json(sampling_weight),'stratumKey',stratum_key) ORDER BY draw_position)) FROM governed_review_batch_items WHERE batch_id=?) draw_matches,
   (SELECT count(*) FROM governed_review_batch_items WHERE batch_id=?) selected_count,
   (SELECT count(*) FROM governed_review_item_resolutions WHERE batch_id=? AND resolved_label IN('pass','fail')) resolved_count,
   EXISTS(SELECT 1 FROM governed_review_task_states WHERE batch_id=? AND state='deferred') deferred,
   EXISTS(SELECT 1 FROM governed_review_task_states WHERE batch_id=? AND state<>'submitted') incomplete_tasks,
   EXISTS(SELECT 1 FROM governed_active_review_labels WHERE batch_id=? AND label='cannot_determine') cannot_determine`).get(origin.draw_digest,origin.batch_id,origin.batch_id,origin.batch_id,origin.batch_id,origin.batch_id,origin.batch_id)!;
  const reasons: string[] = [];
  const probabilityMethod = origin.selection_method === "simple_random" ||
    origin.selection_method === "stratified_random";
  if (!probabilityMethod) reasons.push("selection_method_not_eligible");
  if (isEmptyObject(origin.population_definition) || origin.population_size <= 0) {
    reasons.push("population_frame_incomplete");
  }
  if (isEmptyObject(origin.population_collection_provenance)) {
    reasons.push("collection_provenance_unverified");
  }
  if (origin.draw_executed_by !== "rubrist_server") reasons.push("draw_not_server_executed");
  if (probabilityMethod && (!origin.selection_seed || !origin.rng_version || evidence.draw_matches !== 1)) {
    reasons.push("draw_not_reproducible");
  }
  if (origin.fixed_budget !== Number(evidence.selected_count)) reasons.push("fixed_budget_mismatch");
  if (origin.selection_method === "stratified_random" &&
      (!Array.isArray(origin.strata) || origin.strata.length === 0)) reasons.push("strata_incomplete");
  if (evidence.incomplete_tasks === 1) reasons.push("review_coverage_incomplete");
  if (evidence.deferred === 1) reasons.push("deferred_assignments");
  if (evidence.cannot_determine === 1) reasons.push("cannot_determine_present");
  if (Number(evidence.resolved_count) !== Number(evidence.selected_count)) reasons.push("unresolved_items");
  const sorted = [...new Set(reasons)].sort();
  return {
    representativeOfPopulationId: sorted.length === 0 ? origin.source_population_id : null,
    reasons: sorted
  };
}

function identityProblem(error: unknown): string {
  const issues = (error as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues.slice(0, 3).map((issue) => `${issue.path.map(String).join(".") || "identity"}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message.slice(0, 200) : "invalid identity";
}
