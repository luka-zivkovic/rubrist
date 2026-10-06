-- Immutable, system-derived separation evidence. Calibration-specific checks
-- remain fail-closed until their owning execution command is ported.
CREATE TABLE governed_review_capability_checks (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 batch_id TEXT NOT NULL, criterion_version_id TEXT NOT NULL,
 evaluator_version_id TEXT, subject_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 2147483647),
 expected_previous_sequence INTEGER NOT NULL CHECK(expected_previous_sequence BETWEEN 0 AND 2147483647),
 check_scope TEXT NOT NULL CHECK(check_scope IN('batch_open','adjudication','truth_freeze','final_validation')),
 result TEXT NOT NULL CHECK(result IN('eligible','unknown','ineligible')),
 verification_method TEXT NOT NULL CHECK(verification_method IN('system_derived','independently_verified')),
 capability_query_version TEXT NOT NULL CHECK(capability_query_version='sealed-separation/v1'),
 covered_capabilities TEXT NOT NULL CHECK(json_valid(covered_capabilities) AND json_type(covered_capabilities)='array'),
 excluded_capabilities TEXT NOT NULL CHECK(json_valid(excluded_capabilities) AND json_type(excluded_capabilities)='array'),
 unknown_capabilities TEXT NOT NULL CHECK(json_valid(unknown_capabilities) AND json_type(unknown_capabilities)='array'),
 evidence TEXT NOT NULL CHECK(json_valid(evidence)),
 evidence_digest TEXT NOT NULL, content_digest TEXT NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key)>0 AND length(CAST(idempotency_key AS BLOB))<=1024),
 request_digest TEXT NOT NULL, checked_at TEXT NOT NULL,
 UNIQUE(project_id,id), UNIQUE(project_id,idempotency_key),
 FOREIGN KEY(project_id,batch_id) REFERENCES governed_review_batches(project_id,id),
 FOREIGN KEY(project_id,criterion_version_id) REFERENCES criterion_versions(project_id,id),
 FOREIGN KEY(project_id,evaluator_version_id) REFERENCES skill_versions(project_id,id),
 FOREIGN KEY(project_id,subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 CHECK(check_scope<>'final_validation' OR evaluator_version_id IS NOT NULL),
 CHECK((result='eligible' AND json_array_length(excluded_capabilities)=0 AND json_array_length(unknown_capabilities)=0) OR (result='ineligible' AND json_array_length(excluded_capabilities)>0) OR (result='unknown' AND json_array_length(unknown_capabilities)>0)),
 CHECK(length(evidence_digest)=71 AND substr(evidence_digest,1,7)='sha256:' AND substr(evidence_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE UNIQUE INDEX governed_capability_review_sequence ON governed_review_capability_checks(batch_id,check_scope,subject_id,sequence) WHERE evaluator_version_id IS NULL;
CREATE UNIQUE INDEX governed_capability_evaluator_sequence ON governed_review_capability_checks(batch_id,check_scope,subject_id,evaluator_version_id,sequence) WHERE evaluator_version_id IS NOT NULL;
CREATE TRIGGER governed_capability_immutable BEFORE UPDATE ON governed_review_capability_checks BEGIN SELECT RAISE(ABORT,'immutable capability evidence'); END;
CREATE TRIGGER governed_capability_erase BEFORE DELETE ON governed_review_capability_checks WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'capability evidence deletion requires project erasure'); END;
CREATE TRIGGER governed_capability_insert BEFORE INSERT ON governed_review_capability_checks BEGIN
 SELECT CASE WHEN NEW.checked_at IS NOT sqlite_command_time() THEN RAISE(ABORT,'capability check requires current command') END;
 SELECT CASE WHEN NEW.verification_method<>'system_derived' OR NEW.evaluator_version_id IS NOT NULL OR NEW.check_scope='final_validation' THEN RAISE(ABORT,'calibration and independent verification capability checks are staged') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_review_batches WHERE id=NEW.batch_id AND project_id=NEW.project_id AND criterion_version_id=NEW.criterion_version_id) THEN RAISE(ABORT,'capability check requires exact batch criterion') END;
 SELECT CASE WHEN NEW.expected_previous_sequence<>coalesce((SELECT max(sequence) FROM governed_review_capability_checks WHERE batch_id=NEW.batch_id AND check_scope=NEW.check_scope AND subject_id=NEW.subject_id AND evaluator_version_id IS NEW.evaluator_version_id),0) OR NEW.sequence<>NEW.expected_previous_sequence+1 THEN RAISE(ABORT,'capability check sequence conflict') END;
 SELECT CASE WHEN governed_canonical_json_v1(NEW.covered_capabilities)<>'["criterion_authoring","instruction_authoring","evaluator_authoring","rubric_authoring","prompt_authoring","example_selection","development_exposure"]' THEN RAISE(ABORT,'capability coverage must be complete') END;
 SELECT CASE WHEN json_array_length(NEW.excluded_capabilities)>100 OR json_array_length(NEW.unknown_capabilities)>100 OR EXISTS(SELECT 1 FROM json_each(NEW.excluded_capabilities) WHERE type<>'text' OR length(value)=0 OR length(CAST(value AS BLOB))>1024) OR EXISTS(SELECT 1 FROM json_each(NEW.unknown_capabilities) WHERE type<>'text' OR length(value)=0 OR length(CAST(value AS BLOB))>1024) OR (SELECT coalesce(sum(length(CAST(value AS BLOB))),0) FROM json_each(NEW.excluded_capabilities))>65536 OR (SELECT coalesce(sum(length(CAST(value AS BLOB))),0) FROM json_each(NEW.unknown_capabilities))>65536 OR governed_jsonb_octets_v1(NEW.evidence)>262144 THEN RAISE(ABORT,'capability evidence exceeds bounds') END;
 SELECT CASE WHEN NEW.evidence_digest IS NOT governed_content_v1_digest('sealed-separation-evidence/v1',NEW.evidence) THEN RAISE(ABORT,'capability evidence digest mismatch') END;
 SELECT CASE WHEN NOT analysis_governed_capability_valid_v1(NEW.project_id,NEW.criterion_version_id,NEW.subject_id,NEW.result,governed_canonical_json_v1(NEW.excluded_capabilities),governed_canonical_json_v1(NEW.unknown_capabilities),governed_canonical_json_v1(NEW.evidence)) THEN RAISE(ABORT,'capability evidence must match live system facts') END;
 SELECT CASE WHEN NEW.content_digest IS NOT governed_content_v1_digest('governed-review-capability-check/v1',json_object('batchId',NEW.batch_id,'capabilityQueryVersion',NEW.capability_query_version,'checkScope',NEW.check_scope,'coveredCapabilities',json(NEW.covered_capabilities),'evidenceDigest',NEW.evidence_digest,'evaluatorVersionId',NEW.evaluator_version_id,'excludedCapabilities',json(NEW.excluded_capabilities),'result',NEW.result,'sequence',NEW.sequence,'subjectId',NEW.subject_id,'unknownCapabilities',json(NEW.unknown_capabilities),'verificationMethod',NEW.verification_method)) THEN RAISE(ABORT,'capability check content digest mismatch') END;
END;
