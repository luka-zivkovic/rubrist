-- PostgreSQL parity for protected sealed intake populations.
--
-- 1. PG governed_sealed_intake_populations_predecessor_idx: a protected sealed
--    predecessor has at most one successor intake (ADR-0007/0008 one direct,
--    nonbranching successor), so a losing branch can never be drafted, opened,
--    or shown to reviewers. Upgrade is fail-closed: if an existing database
--    already holds two intakes over one predecessor, CREATE UNIQUE INDEX fails,
--    the runner rolls back every pending migration, and the database stays at
--    its prior version. Sealed intake evidence is append-only and deletable
--    only by project erasure, so this migration never deletes or rewrites it;
--    an operator must preserve the database and resolve the branch explicitly.
-- 2. CURRENT PG lets any live project member be the sealed-intake custodian
--    (no owner check in createSealedIntake, POST /sealed-intakes, or
--    guard_governed_sealed_intake_population). The trigger below is 0051's text
--    verbatim except its custodian predicate: live membership and the custodian
--    review role are still required, the owner role no longer is.
CREATE UNIQUE INDEX governed_sealed_intake_one_successor ON governed_sealed_intake_populations(predecessor_revision_id) WHERE predecessor_revision_id IS NOT NULL;
DROP TRIGGER governed_sealed_population_insert;
CREATE TRIGGER governed_sealed_population_insert BEFORE INSERT ON governed_sealed_intake_populations BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NEW.created_command_token IS NOT sqlite_command_token() THEN RAISE(ABORT,'sealed intake requires owning command') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects s JOIN project_members pm ON pm.project_id=s.project_id AND pm.user_id=s.account_user_id WHERE s.id=NEW.custodian_subject_id AND s.project_id=NEW.project_id AND pm.role IN('owner','member') AND NEW.custodian_role_at_review='custodian') THEN RAISE(ABORT,'sealed intake requires live member custodian') END;
 SELECT CASE WHEN NEW.window_end IS NOT NULL AND governed_timestamp_v1(NEW.window_end)<=governed_timestamp_v1(NEW.window_start) THEN RAISE(ABORT,'sealed intake window must ascend') END;
 SELECT CASE WHEN governed_jsonb_octets_v1(NEW.population_definition)>262144 OR governed_jsonb_octets_v1(NEW.collection_provenance)>262144 OR governed_canonical_json_v1(NEW.population_definition)='{}' OR governed_canonical_json_v1(NEW.collection_provenance)='{}' THEN RAISE(ABORT,'sealed intake requires bounded nonempty provenance') END;
 SELECT CASE WHEN NEW.predecessor_revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dataset_revisions r WHERE r.id=NEW.predecessor_revision_id AND r.project_id=NEW.project_id AND r.role='sealed_validation' AND NOT EXISTS(SELECT 1 FROM dataset_exposure_events WHERE revision_id=r.id AND exposure_class='development') AND NOT EXISTS(SELECT 1 FROM dataset_revisions WHERE parent_revision_id=r.id AND role='sealed_validation')) THEN RAISE(ABORT,'sealed successor requires unexposed predecessor without sealed child') END;
 SELECT CASE WHEN NEW.content_digest IS NOT governed_content_v1_digest('governed-sealed-intake-population/v1',json_object('collectionProvenance',json(NEW.collection_provenance),'custodianRoleAtReview',NEW.custodian_role_at_review,'custodianSubjectId',NEW.custodian_subject_id,'frameCount',NEW.frame_count,'frameDigest',NEW.frame_digest,'populationDefinition',json(NEW.population_definition),'predecessorRevisionId',NEW.predecessor_revision_id,'windowEnd',CASE WHEN NEW.window_end IS NULL THEN NULL ELSE governed_timestamp_v1(NEW.window_end) END,'windowStart',CASE WHEN NEW.window_start IS NULL THEN NULL ELSE governed_timestamp_v1(NEW.window_start) END)) THEN RAISE(ABORT,'sealed population digest mismatch') END;
END;
