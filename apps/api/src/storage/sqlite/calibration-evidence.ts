import {EVALUATOR_IDENTITY_BASIS,ExecutionBindingSchema,type BinaryCalibrationArtifact,type BinaryCalibrationPrivateLedger} from '@rubrist/shared';
import {BINARY_CALIBRATION_PRIVATE_LEDGER_CONTRACT,binaryCalibrationArtifactDigest,binaryCalibrationPrivateLedgerCommitmentDigest,buildBinaryCalibrationArtifact,canonicalBinaryCalibrationArtifactBytes,canonicalBinaryCalibrationPrivateLedgerBytes,verifyBinaryCalibrationPrivateLedgerForArtifact} from '../../lib/binary-calibration.js';
import {aggregateTrial,asStringArray,attemptResultFromRow,nullableString,parseJson,stableId,toIso,type RunRow,type EligibilityResult} from '../../binary-calibration/storage-values.js';
import type {snapshotRecord} from './calibration-eligibility.js';
/** Same immutable value construction as the PostgreSQL mint command. */
export function calibrationEvidence(run:RunRow,attemptRows:Record<string,unknown>[],authorization:{id:string;snapshotDigest:string;recordedAt:string},completion:EligibilityResult,completionCheck:ReturnType<typeof snapshotRecord>,artifactCreatedAt:string){
 const completedAt=artifactCreatedAt,completionRecordedAt=artifactCreatedAt;
      const artifactId = stableId("bca", run.id, "artifact-root");
      const ledgerId = stableId("bcl", run.id, "private-ledger-root");
      const records = attemptRows.map((row) => ({
        datasetRevisionItemDigest: String(row.dataset_revision_item_digest),
        trialIndex: Number(row.trial_index),
        truthLabel: row.truth_label === "pass" ? "pass" as const : "fail" as const,
        result: attemptResultFromRow(row),
        attemptState: String(row.attempt_state) as
          BinaryCalibrationPrivateLedger["records"][number]["attemptState"],
        physicalProviderCalls: Number(row.physical_provider_calls),
        providerObservation: {
          provider: String(row.provider),
          observedModel: nullableString(row.observed_model),
          observedVersion: nullableString(row.observed_version),
          systemFingerprint: nullableString(row.system_fingerprint),
          upstreamProvider: nullableString(row.upstream_provider)
        },
        commitmentSalt: String(row.commitment_salt)
      }));
      const ledger: BinaryCalibrationPrivateLedger = {
        contract: BINARY_CALIBRATION_PRIVATE_LEDGER_CONTRACT,
        schemaVersion: 1,
        canonicalizationVersion: "rubrist-canonical-json/v1",
        artifactId,
        calibrationRunId: run.id,
        projectId: run.project_id,
        revisionDigest: String(run.revision_digest),
        requestedProvider: String(run.requested_provider),
        itemCount: Number(run.item_count),
        trialsPerItem: 1,
        records
      };
      const ledgerBytes = canonicalBinaryCalibrationPrivateLedgerBytes(ledger);
      const ledgerCommitment = binaryCalibrationPrivateLedgerCommitmentDigest(ledger);
      const aggregate = aggregateTrial(records);
      const artifact = buildBinaryCalibrationArtifact({
        artifactId,
        calibrationRunId: run.id,
        projectId: run.project_id,
        lineage: { artifactRevision: 1, predecessorArtifactId: null, correctionReason: null },
        createdAt: artifactCreatedAt,
        startedAt: toIso(run.started_at),
        completedAt,
        criterion: {
          criterionId: String(run.criterion_id),
          criterionVersionId: String(run.criterion_version_id),
          criterionDigest: String(run.criterion_digest)
        },
        evaluator: {
          skillId: String(run.skill_id),
          skillVersionId: String(run.skill_version_id),
          identity: {
            basis: EVALUATOR_IDENTITY_BASIS,
            definitionDigest: String(run.definition_digest),
            executionBinding: ExecutionBindingSchema.parse(parseJson(run.execution_binding))
          },
          skillDigest: String(run.skill_digest),
          outputContractDigest: String(run.output_contract_digest),
          requestedBindingDigest: String(run.requested_binding_digest)
        },
        suiteBinding: run.suite_manifest_id === null ? null : {
          manifestId: String(run.suite_manifest_id),
          manifestDigest: String(run.suite_manifest_digest),
          memberPosition: Number(run.suite_member_position)
        },
        truth: {
          datasetRevisionId: String(run.dataset_revision_id),
          revisionDigest: String(run.revision_digest),
          contentDigest: String(run.truth_content_digest),
          itemCount: Number(run.item_count),
          role: "sealed_validation",
          sourceKind: "sealed_intake",
          provenanceLevel: "governed_blind",
          semanticLeakageDetection: "unsupported",
          representativeOfPopulationId: nullableString(run.representative_of_population_id),
          representativeIneligibleReasons: asStringArray(parseJson(run.representative_ineligible_reasons)) as
            BinaryCalibrationArtifact["truth"]["representativeIneligibleReasons"],
          selectionMethod: String(run.selection_method) as BinaryCalibrationArtifact["truth"]["selectionMethod"],
          origin: {
            governedReviewBatchId: String(run.governed_review_batch_id),
            governedReviewBatchDigest: String(run.governed_review_batch_digest),
            reviewInstructionVersionId: String(run.review_instruction_version_id),
            reviewInstructionDigest: String(run.review_instruction_digest),
            populationId: String(run.population_id),
            populationDigest: String(run.population_digest),
            drawDigest: String(run.draw_digest)
          }
        },
        exposure: {
          authorization: {
            state: "protected",
            snapshotDigest: authorization.snapshotDigest,
            eventId: authorization.id,
            recordedAt: authorization.recordedAt
          },
          completion: {
            state: completion.exposureState,
            snapshotDigest: completionCheck.snapshotDigest,
            eventId: completionCheck.id,
            recordedAt: completionRecordedAt,
            eligibility: {
              result: completion.eligible ? "eligible" : "ineligible",
              reasons: completion.reasons
            }
          }
        },
        execution: {
          definitionVersion: "sealed-binary-calibration-execution/v1",
          providerDataHandling: {
            executionEnvironment: String(run.execution_environment) as
              BinaryCalibrationArtifact["execution"]["providerDataHandling"]["executionEnvironment"],
            policyId: String(run.provider_policy_id),
            policyDigest: String(run.provider_policy_digest),
            payloadTransmission: "sealed_payload_to_pinned_provider"
          }
        },
        positiveClass: run.positive_class === "pass" ? "pass" : "fail",
        trialPlan: { kind: "single", trialsPerItem: 1 },
        truthSupport: aggregate.truthSupport,
        privateLedgerCommitmentDigest: ledgerCommitment,
        trials: [{
          trialIndex: 0,
          outcomes: aggregate.outcomes,
          confusionMatrix: aggregate.confusionMatrix,
          providerIdentityGroups: aggregate.providerIdentityGroups
        }]
      });
      verifyBinaryCalibrationPrivateLedgerForArtifact(ledger, artifact);
      const artifactBytes = canonicalBinaryCalibrationArtifactBytes(artifact);
      const artifactDigest = binaryCalibrationArtifactDigest(artifactBytes);

 return {artifactId,ledgerId,ledger,ledgerBytes,ledgerCommitment,artifact,artifactBytes,artifactDigest};
}
