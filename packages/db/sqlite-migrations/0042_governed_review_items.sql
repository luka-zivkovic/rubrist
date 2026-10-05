CREATE TABLE governed_review_items (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 source_kind TEXT NOT NULL CHECK(source_kind IN('dataset_revision_item','sealed_intake')),
 source_revision_id TEXT,source_revision_item_id TEXT,sealed_intake_population_id TEXT,sealed_frame_position INTEGER CHECK(sealed_frame_position IS NULL OR sealed_frame_position BETWEEN 0 AND 2147483647),
 sealed_predecessor_revision_id TEXT,sealed_predecessor_revision_item_id TEXT,
 identity_basis TEXT NOT NULL CHECK(identity_basis='input-identity/v1'),input_digest TEXT NOT NULL,source_item_digest TEXT,
 review_payload_projection_version TEXT NOT NULL CHECK(review_payload_projection_version='governed-review-payload/v1'),
 review_payload_snapshot TEXT NOT NULL CHECK(json_valid(review_payload_snapshot)),redaction_provenance TEXT NOT NULL CHECK(json_valid(redaction_provenance)),
 content_digest TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,
 created_by_subject_id TEXT,created_at TEXT NOT NULL,
 UNIQUE(project_id,id),UNIQUE(project_id,idempotency_key),
 FOREIGN KEY(project_id,source_revision_id,source_revision_item_id) REFERENCES dataset_revision_items(project_id,revision_id,id),
 FOREIGN KEY(project_id,sealed_predecessor_revision_id,sealed_predecessor_revision_item_id) REFERENCES dataset_revision_items(project_id,revision_id,id),
 FOREIGN KEY(project_id,created_by_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 CHECK(length(idempotency_key)>0 AND length(CAST(idempotency_key AS BLOB))<=1024),
 CHECK(length(input_digest)=71 AND substr(input_digest,1,7)='sha256:' AND substr(input_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(source_item_digest IS NULL OR (length(source_item_digest)=71 AND substr(source_item_digest,1,7)='sha256:' AND substr(source_item_digest,8) NOT GLOB '*[^0-9a-f]*')),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK((source_kind='dataset_revision_item' AND source_revision_id IS NOT NULL AND source_revision_item_id IS NOT NULL AND source_item_digest IS NOT NULL AND sealed_intake_population_id IS NULL AND sealed_frame_position IS NULL AND sealed_predecessor_revision_id IS NULL AND sealed_predecessor_revision_item_id IS NULL)
 OR (source_kind='sealed_intake' AND source_revision_id IS NULL AND source_revision_item_id IS NULL AND source_item_digest IS NULL AND sealed_intake_population_id IS NOT NULL AND sealed_frame_position IS NOT NULL AND ((sealed_predecessor_revision_id IS NULL AND sealed_predecessor_revision_item_id IS NULL) OR (sealed_predecessor_revision_id IS NOT NULL AND sealed_predecessor_revision_item_id IS NOT NULL))))
) STRICT;
CREATE INDEX governed_review_item_input ON governed_review_items(project_id,input_digest);
-- Removed only with the complete sealed population, frame, overlap and
-- protected-successor guards. This intermediate migration opens no sealed path.
CREATE TRIGGER governed_review_item_sealed_stage BEFORE INSERT ON governed_review_items WHEN NEW.source_kind='sealed_intake' BEGIN SELECT RAISE(ABORT,'sealed intake requires complete governed review port'); END;
CREATE TRIGGER governed_review_item_insert BEFORE INSERT ON governed_review_items BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() THEN RAISE(ABORT,'review item requires command time') END;
 SELECT CASE WHEN governed_jsonb_octets_v1(NEW.review_payload_snapshot)>2097152 OR governed_jsonb_octets_v1(NEW.redaction_provenance)>131072 THEN RAISE(ABORT,'review item exceeds byte bounds') END;
 SELECT CASE WHEN governed_canonical_json_v1(NEW.review_payload_snapshot) IS NOT governed_canonical_json_v1(governed_review_payload_project_v1(NEW.review_payload_snapshot)) THEN RAISE(ABORT,'review item payload is not its safe projection') END;
 SELECT CASE WHEN NEW.source_kind='dataset_revision_item' AND NOT EXISTS(SELECT 1 FROM dataset_revision_items i JOIN dataset_revisions r ON r.project_id=i.project_id AND r.id=i.revision_id WHERE i.project_id=NEW.project_id AND i.id=NEW.source_revision_item_id AND i.revision_id=NEW.source_revision_id AND r.role<>'sealed_validation' AND i.input_digest=NEW.input_digest AND i.item_digest=NEW.source_item_digest AND governed_canonical_json_v1(NEW.review_payload_snapshot)=governed_canonical_json_v1(governed_review_payload_project_v1(i.payload_snapshot))) THEN RAISE(ABORT,'review item requires exact immutable nonsealed source') END;
 SELECT CASE WHEN NEW.content_digest IS NOT governed_content_v1_digest('governed-review-item/v1',json_object('identityBasis',NEW.identity_basis,'inputDigest',NEW.input_digest,'redactionProvenance',json(NEW.redaction_provenance),'reviewPayloadProjectionVersion',NEW.review_payload_projection_version,'reviewPayloadSnapshot',json(NEW.review_payload_snapshot),'sealedFramePosition',NEW.sealed_frame_position,'sealedIntakePopulationId',NEW.sealed_intake_population_id,'sealedPredecessorRevisionId',NEW.sealed_predecessor_revision_id,'sealedPredecessorRevisionItemId',NEW.sealed_predecessor_revision_item_id,'sourceKind',NEW.source_kind,'sourceItemDigest',NEW.source_item_digest,'sourceRevisionId',NEW.source_revision_id,'sourceRevisionItemId',NEW.source_revision_item_id)) THEN RAISE(ABORT,'review item content digest mismatch') END;
END;
CREATE TRIGGER governed_review_item_immutable BEFORE UPDATE ON governed_review_items BEGIN SELECT RAISE(ABORT,'immutable governed review item'); END;
CREATE TRIGGER governed_review_item_erase BEFORE DELETE ON governed_review_items WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'review item deletion requires project erasure'); END;
