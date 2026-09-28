-- Preserve the hosted evidence under ADR-0011's preservation exception.
-- Older values may be implicit defaults; do not reinterpret them as declarations.
ALTER TABLE skill_versions
  ADD COLUMN rubric_provenance_declared boolean NOT NULL DEFAULT false,
  ALTER COLUMN rubric_provenance SET DEFAULT 'unspecified',
  DROP CONSTRAINT skill_versions_rubric_provenance_check,
  ADD CONSTRAINT skill_versions_rubric_provenance_check
    CHECK (rubric_provenance IN ('human-authored', 'agent-drafted', 'unspecified')),
  ADD CONSTRAINT skill_versions_authorship_declaration_check
    CHECK (NOT rubric_provenance_declared OR rubric_provenance <> 'unspecified');

CREATE FUNCTION preserve_skill_version_authorship() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rubric_provenance IS DISTINCT FROM OLD.rubric_provenance
     OR NEW.rubric_provenance_declared IS DISTINCT FROM OLD.rubric_provenance_declared THEN
    RAISE EXCEPTION 'skill-version authorship is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER skill_versions_preserve_authorship
BEFORE UPDATE ON skill_versions
FOR EACH ROW EXECUTE FUNCTION preserve_skill_version_authorship();

-- Request digests include explicit declarations only. Historical omission
-- retains its exact digest even when the old default said human-authored.
CREATE OR REPLACE FUNCTION evaluator_lifecycle_request_digest_v1(row_value evaluator_lifecycles) RETURNS text
    LANGUAGE sql STABLE
    -- The decision threshold is a float8: its JSON digits must be the
    -- shortest exact ones, whatever the session's extra_float_digits.
    SET extra_float_digits TO '1'
    AS $$
  select governed_content_v1_digest('evaluator-candidate-request/v1',jsonb_build_object(
    'criterionId',row_value.criterion_id,
    'criterionVersionId',row_value.criterion_version_id,
    'expectedBatchDigest',row_value.governed_batch_digest,
    'expectedTruthContentDigest',row_value.truth_content_digest,
    'expectedTruthRevisionDigest',row_value.truth_revision_digest,
    'governedBatchId',row_value.governed_batch_id,
    'customEndpointUrl',(select version.custom_endpoint_url from skill_versions version where version.id=row_value.skill_version_id),
    'executionBinding',(select version.execution_binding from skill_versions version where version.id=row_value.skill_version_id),
    'outputSchema',(select version.output_schema from skill_versions version where version.id=row_value.skill_version_id),
    'prompt',(select version.prompt from skill_versions version where version.id=row_value.skill_version_id),
    'projectId',row_value.project_id,
    'rubricMarkdown',(select version.rubric_markdown from skill_versions version where version.id=row_value.skill_version_id),
    'skillDescription',(select skill.description from skills skill where skill.id=row_value.skill_id),
    'skillName',(select skill.name from skills skill where skill.id=row_value.skill_id),
    'truthDatasetRevisionId',row_value.truth_dataset_revision_id,
    'typedQuestion',(select version.typed_question from skill_versions version where version.id=row_value.skill_version_id),
    'decisionThreshold',(select version.decision_threshold from skill_versions version where version.id=row_value.skill_version_id)
  ) || coalesce((select case when version.rubric_provenance_declared
       then jsonb_build_object('rubricProvenance',version.rubric_provenance)
       else '{}'::jsonb end
       from skill_versions version where version.id=row_value.skill_version_id), '{}'::jsonb))
$$;
