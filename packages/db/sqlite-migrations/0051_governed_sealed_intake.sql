-- Sealed intake protects exact inputs before any review is assigned.
CREATE TABLE governed_sealed_intake_populations (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 custodian_subject_id TEXT NOT NULL,
 custodian_role_at_review TEXT NOT NULL CHECK(length(custodian_role_at_review)>0 AND length(CAST(custodian_role_at_review AS BLOB))<=256),
 population_definition TEXT NOT NULL CHECK(json_valid(population_definition)),
 window_start TEXT,window_end TEXT,
 collection_provenance TEXT NOT NULL CHECK(json_valid(collection_provenance)),
 frame_count INTEGER NOT NULL CHECK(frame_count BETWEEN 1 AND 10000000),
 frame_digest TEXT NOT NULL,
 predecessor_revision_id TEXT,
 content_digest TEXT NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key)>0 AND length(CAST(idempotency_key AS BLOB))<=1024),
 request_digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 created_command_token TEXT NOT NULL,
 UNIQUE(project_id,id), UNIQUE(project_id,idempotency_key), UNIQUE(id,project_id,created_command_token),
 FOREIGN KEY(project_id,custodian_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 FOREIGN KEY(project_id,predecessor_revision_id) REFERENCES dataset_revisions(project_id,id),
 FOREIGN KEY(id,project_id,created_command_token) REFERENCES governed_sealed_intake_finalizations(intake_id,project_id,command_token) DEFERRABLE INITIALLY DEFERRED,
 CHECK((window_start IS NULL)=(window_end IS NULL)),
 CHECK(length(frame_digest)=71 AND substr(frame_digest,1,7)='sha256:' AND substr(frame_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE governed_sealed_intake_finalizations (
 intake_id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 command_token TEXT NOT NULL,
 UNIQUE(intake_id,project_id,command_token),
 FOREIGN KEY(intake_id,project_id,command_token) REFERENCES governed_sealed_intake_populations(id,project_id,created_command_token)
) STRICT;
CREATE UNIQUE INDEX governed_review_items_sealed_position ON governed_review_items(sealed_intake_population_id,sealed_frame_position) WHERE source_kind='sealed_intake';
CREATE UNIQUE INDEX governed_review_items_sealed_input ON governed_review_items(sealed_intake_population_id,input_digest) WHERE source_kind='sealed_intake';
CREATE TRIGGER governed_sealed_intake_populations_immutable BEFORE UPDATE ON governed_sealed_intake_populations BEGIN SELECT RAISE(ABORT,'immutable sealed intake evidence'); END;
CREATE TRIGGER governed_sealed_intake_populations_erase BEFORE DELETE ON governed_sealed_intake_populations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'sealed intake deletion requires project erasure'); END;
CREATE TRIGGER governed_sealed_intake_finalizations_immutable BEFORE UPDATE ON governed_sealed_intake_finalizations BEGIN SELECT RAISE(ABORT,'immutable sealed intake evidence'); END;
CREATE TRIGGER governed_sealed_intake_finalizations_erase BEFORE DELETE ON governed_sealed_intake_finalizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'sealed intake deletion requires project erasure'); END;
CREATE TRIGGER governed_sealed_population_insert BEFORE INSERT ON governed_sealed_intake_populations BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NEW.created_command_token IS NOT sqlite_command_token() THEN RAISE(ABORT,'sealed intake requires owning command') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects s JOIN project_members pm ON pm.project_id=s.project_id AND pm.user_id=s.account_user_id WHERE s.id=NEW.custodian_subject_id AND s.project_id=NEW.project_id AND pm.role='owner' AND NEW.custodian_role_at_review='custodian') THEN RAISE(ABORT,'sealed intake requires live owner custodian') END;
 SELECT CASE WHEN NEW.window_end IS NOT NULL AND governed_timestamp_v1(NEW.window_end)<=governed_timestamp_v1(NEW.window_start) THEN RAISE(ABORT,'sealed intake window must ascend') END;
 SELECT CASE WHEN governed_jsonb_octets_v1(NEW.population_definition)>262144 OR governed_jsonb_octets_v1(NEW.collection_provenance)>262144 OR governed_canonical_json_v1(NEW.population_definition)='{}' OR governed_canonical_json_v1(NEW.collection_provenance)='{}' THEN RAISE(ABORT,'sealed intake requires bounded nonempty provenance') END;
 SELECT CASE WHEN NEW.predecessor_revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dataset_revisions r WHERE r.id=NEW.predecessor_revision_id AND r.project_id=NEW.project_id AND r.role='sealed_validation' AND NOT EXISTS(SELECT 1 FROM dataset_exposure_events WHERE revision_id=r.id AND exposure_class='development') AND NOT EXISTS(SELECT 1 FROM dataset_revisions WHERE parent_revision_id=r.id AND role='sealed_validation')) THEN RAISE(ABORT,'sealed successor requires unexposed predecessor without sealed child') END;
 SELECT CASE WHEN NEW.content_digest IS NOT governed_content_v1_digest('governed-sealed-intake-population/v1',json_object('collectionProvenance',json(NEW.collection_provenance),'custodianRoleAtReview',NEW.custodian_role_at_review,'custodianSubjectId',NEW.custodian_subject_id,'frameCount',NEW.frame_count,'frameDigest',NEW.frame_digest,'populationDefinition',json(NEW.population_definition),'predecessorRevisionId',NEW.predecessor_revision_id,'windowEnd',CASE WHEN NEW.window_end IS NULL THEN NULL ELSE governed_timestamp_v1(NEW.window_end) END,'windowStart',CASE WHEN NEW.window_start IS NULL THEN NULL ELSE governed_timestamp_v1(NEW.window_start) END)) THEN RAISE(ABORT,'sealed population digest mismatch') END;
END;
DROP TRIGGER governed_review_item_sealed_stage;
CREATE TRIGGER governed_sealed_item_insert BEFORE INSERT ON governed_review_items WHEN NEW.source_kind='sealed_intake' BEGIN
 SELECT CASE WHEN NEW.input_digest IS NOT governed_input_identity_v1(NEW.review_payload_snapshot) THEN RAISE(ABORT,'sealed input identity must match retained payload') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_sealed_intake_populations p WHERE p.id=NEW.sealed_intake_population_id AND p.project_id=NEW.project_id AND p.custodian_subject_id IS NEW.created_by_subject_id AND p.predecessor_revision_id IS NEW.sealed_predecessor_revision_id AND NEW.sealed_frame_position<p.frame_count AND p.created_command_token=sqlite_command_token() AND NOT EXISTS(SELECT 1 FROM governed_sealed_intake_finalizations WHERE intake_id=p.id)) THEN RAISE(ABORT,'sealed item requires exact unfinalized population and custodian') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM governed_input_identity_claims WHERE project_id=NEW.project_id AND input_digest=NEW.input_digest AND usage_class='nonsealed') THEN RAISE(ABORT,'sealed input overlaps retained nonsealed identity') END;
 SELECT CASE WHEN NEW.sealed_predecessor_revision_item_id IS NULL AND (EXISTS(SELECT 1 FROM dataset_revision_items WHERE project_id=NEW.project_id AND input_digest=NEW.input_digest) OR EXISTS(SELECT 1 FROM governed_review_items WHERE project_id=NEW.project_id AND source_kind='sealed_intake' AND input_digest=NEW.input_digest)) THEN RAISE(ABORT,'sealed input overlaps unrelated sealed evidence') END;
 SELECT CASE WHEN NEW.sealed_predecessor_revision_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dataset_revisions r JOIN dataset_revision_items i ON i.revision_id=r.id AND i.project_id=r.project_id WHERE r.id=NEW.sealed_predecessor_revision_id AND i.id=NEW.sealed_predecessor_revision_item_id AND r.project_id=NEW.project_id AND r.role='sealed_validation' AND i.input_digest=NEW.input_digest AND NOT EXISTS(SELECT 1 FROM dataset_exposure_events WHERE revision_id=r.id AND exposure_class='development') AND NOT EXISTS(SELECT 1 FROM dataset_revisions WHERE parent_revision_id=r.id AND role='sealed_validation')) THEN RAISE(ABORT,'sealed successor requires exact protected predecessor item') END;
 SELECT CASE WHEN NEW.sealed_predecessor_revision_item_id IS NOT NULL AND EXISTS(SELECT 1 FROM dataset_revision_items i JOIN dataset_revisions r ON r.id=i.revision_id WHERE i.project_id=NEW.project_id AND i.input_digest=NEW.input_digest AND r.role='sealed_validation' AND r.series_id<>(SELECT series_id FROM dataset_revisions WHERE id=NEW.sealed_predecessor_revision_id)) THEN RAISE(ABORT,'sealed successor overlaps unrelated sealed lineage') END;
 SELECT CASE WHEN NEW.sealed_predecessor_revision_item_id IS NOT NULL AND EXISTS(SELECT 1 FROM governed_review_items old WHERE old.project_id=NEW.project_id AND old.source_kind='sealed_intake' AND old.input_digest=NEW.input_digest AND NOT EXISTS(SELECT 1 FROM governed_review_batch_items bi JOIN governed_dataset_truth_links t ON t.batch_item_id=bi.id JOIN dataset_revisions r ON r.id=t.dataset_revision_id WHERE bi.review_item_id=old.id AND r.series_id=(SELECT series_id FROM dataset_revisions WHERE id=NEW.sealed_predecessor_revision_id))) THEN RAISE(ABORT,'sealed successor overlaps unrelated intake') END;
 INSERT INTO governed_input_identity_claims(project_id,input_digest,usage_class,created_at) VALUES(NEW.project_id,NEW.input_digest,'sealed',sqlite_command_time()) ON CONFLICT(project_id,input_digest) DO NOTHING;
END;
CREATE TRIGGER governed_sealed_intake_finalize BEFORE INSERT ON governed_sealed_intake_finalizations BEGIN
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM governed_sealed_intake_populations p WHERE p.id=NEW.intake_id AND p.project_id=NEW.project_id AND p.created_command_token=NEW.command_token AND p.frame_count=(SELECT count(*) FROM governed_review_items WHERE sealed_intake_population_id=p.id) AND p.frame_digest=governed_content_v1_digest('governed-sealed-intake-frame/v1',(SELECT json_group_array(json_object('framePosition',sealed_frame_position,'inputDigest',input_digest,'reviewItemId',id) ORDER BY sealed_frame_position) FROM governed_review_items WHERE sealed_intake_population_id=p.id))) THEN RAISE(ABORT,'sealed intake requires complete exact frame') END;
END;
