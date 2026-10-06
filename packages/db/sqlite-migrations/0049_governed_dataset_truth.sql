-- Authoritative links retain the exact native or imported truth behind revisions.
CREATE TABLE governed_dataset_truth_links (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 dataset_revision_id TEXT NOT NULL,
 dataset_revision_item_id TEXT NOT NULL UNIQUE,
 criterion_version_id TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN('governed_labels','adjudication','imported_truth')),
 batch_item_id TEXT,
 governed_label_ids TEXT NOT NULL CHECK(json_valid(governed_label_ids) AND json_type(governed_label_ids)='array'),
 adjudication_id TEXT,
 imported_truth_id TEXT,
 resolution_kind TEXT NOT NULL CHECK(resolution_kind IN('single_rater','unanimous','adjudicated','imported_self_attested','imported_verified_attested','imported_unverified')),
 resolved_label TEXT NOT NULL CHECK(resolved_label IN('pass','fail')),
 supporting_label_count INTEGER NOT NULL CHECK(supporting_label_count BETWEEN 0 AND 2147483647),
 content_digest TEXT NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key)>0 AND length(CAST(idempotency_key AS BLOB))<=1024),
 request_digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 created_command_token TEXT NOT NULL,
 UNIQUE(project_id,id), UNIQUE(project_id,idempotency_key), UNIQUE(id,project_id,created_command_token),
 FOREIGN KEY(project_id,dataset_revision_id,dataset_revision_item_id) REFERENCES dataset_revision_items(project_id,revision_id,id),
 FOREIGN KEY(project_id,criterion_version_id) REFERENCES criterion_versions(project_id,id),
 FOREIGN KEY(project_id,batch_item_id) REFERENCES governed_review_batch_items(project_id,id),
 FOREIGN KEY(project_id,adjudication_id) REFERENCES governed_review_adjudications(project_id,id),
 FOREIGN KEY(project_id,imported_truth_id) REFERENCES governed_imported_truth(project_id,id),
 FOREIGN KEY(id,project_id,created_command_token) REFERENCES governed_dataset_truth_finalizations(truth_link_id,project_id,command_token) DEFERRABLE INITIALLY DEFERRED,
 CHECK((source_kind='governed_labels' AND batch_item_id IS NOT NULL AND json_array_length(governed_label_ids)>0 AND adjudication_id IS NULL AND imported_truth_id IS NULL AND resolution_kind IN('single_rater','unanimous')) OR (source_kind='adjudication' AND batch_item_id IS NOT NULL AND json_array_length(governed_label_ids)=0 AND adjudication_id IS NOT NULL AND imported_truth_id IS NULL AND resolution_kind='adjudicated') OR (source_kind='imported_truth' AND batch_item_id IS NULL AND json_array_length(governed_label_ids)=0 AND adjudication_id IS NULL AND imported_truth_id IS NOT NULL AND supporting_label_count=0 AND resolution_kind IN('imported_self_attested','imported_verified_attested','imported_unverified'))),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE governed_dataset_truth_link_labels (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 truth_link_id TEXT NOT NULL,
 label_id TEXT NOT NULL,
 PRIMARY KEY(truth_link_id,label_id),
 FOREIGN KEY(project_id,truth_link_id) REFERENCES governed_dataset_truth_links(project_id,id),
 FOREIGN KEY(project_id,label_id) REFERENCES governed_review_labels(project_id,id)
) STRICT;
CREATE TABLE governed_dataset_truth_finalizations (
 truth_link_id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 command_token TEXT NOT NULL,
 UNIQUE(truth_link_id,project_id,command_token),
 FOREIGN KEY(truth_link_id,project_id,command_token) REFERENCES governed_dataset_truth_links(id,project_id,created_command_token)
) STRICT;
CREATE TRIGGER governed_dataset_truth_links_immutable BEFORE UPDATE ON governed_dataset_truth_links BEGIN SELECT RAISE(ABORT,'immutable governed truth evidence'); END;
CREATE TRIGGER governed_dataset_truth_links_erase BEFORE DELETE ON governed_dataset_truth_links WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'governed truth deletion requires project erasure'); END;
CREATE TRIGGER governed_dataset_truth_link_labels_immutable BEFORE UPDATE ON governed_dataset_truth_link_labels BEGIN SELECT RAISE(ABORT,'immutable governed truth evidence'); END;
CREATE TRIGGER governed_dataset_truth_link_labels_erase BEFORE DELETE ON governed_dataset_truth_link_labels WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'governed truth deletion requires project erasure'); END;
CREATE TRIGGER governed_dataset_truth_finalizations_immutable BEFORE UPDATE ON governed_dataset_truth_finalizations BEGIN SELECT RAISE(ABORT,'immutable governed truth evidence'); END;
CREATE TRIGGER governed_dataset_truth_finalizations_erase BEFORE DELETE ON governed_dataset_truth_finalizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'governed truth deletion requires project erasure'); END;
CREATE TRIGGER governed_truth_insert BEFORE INSERT ON governed_dataset_truth_links BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NEW.created_command_token IS NOT sqlite_command_token() OR EXISTS(SELECT 1 FROM dataset_revision_finalizations WHERE revision_id=NEW.dataset_revision_id) THEN RAISE(ABORT,'truth link requires current unfinalized revision command') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM dataset_revisions r JOIN dataset_revision_items i ON i.revision_id=r.id AND i.project_id=r.project_id WHERE r.id=NEW.dataset_revision_id AND r.project_id=NEW.project_id AND i.id=NEW.dataset_revision_item_id AND r.criterion_version_id=NEW.criterion_version_id AND i.reference_label=NEW.resolved_label AND json_extract(i.reference_provenance,'$.kind')='dataset_claim' AND json_extract(i.reference_provenance,'$.sourceId')=NEW.id) THEN RAISE(ABORT,'truth link requires exact revision item criterion label and compatibility pointer') END;
 SELECT CASE WHEN json_array_length(NEW.governed_label_ids)>20 OR EXISTS(SELECT 1 FROM json_each(NEW.governed_label_ids) WHERE type<>'text' OR length(value)=0 OR length(CAST(value AS BLOB))>256) OR (SELECT coalesce(sum(length(CAST(value AS BLOB))),0) FROM json_each(NEW.governed_label_ids))>4096 THEN RAISE(ABORT,'invalid truth label ids') END;
 SELECT CASE WHEN NEW.source_kind IN('governed_labels','adjudication') AND NOT EXISTS(SELECT 1 FROM governed_review_batch_items bi JOIN governed_review_batches b ON b.id=bi.batch_id JOIN governed_review_batch_states bs ON bs.batch_id=b.id JOIN governed_review_items ri ON ri.id=bi.review_item_id JOIN governed_review_item_resolutions res ON res.batch_item_id=bi.id JOIN dataset_revisions r ON r.id=NEW.dataset_revision_id JOIN dataset_revision_items i ON i.id=NEW.dataset_revision_item_id WHERE bi.id=NEW.batch_item_id AND b.project_id=NEW.project_id AND b.criterion_version_id=NEW.criterion_version_id AND bs.state='resolved' AND r.role=b.role_intent AND r.role<>'sealed_validation' AND r.provenance_level='governed_blind' AND i.input_digest=ri.input_digest AND governed_canonical_json_v1(i.payload_snapshot)=governed_canonical_json_v1(ri.review_payload_snapshot) AND res.resolution_kind=NEW.resolution_kind AND res.resolved_label=NEW.resolved_label AND res.adjudication_id IS NEW.adjudication_id) THEN RAISE(ABORT,'native truth requires exact resolved nonsealed batch evidence') END;
 SELECT CASE WHEN NEW.source_kind='governed_labels' AND (NEW.supporting_label_count<>json_array_length(NEW.governed_label_ids) OR NEW.supporting_label_count<>(SELECT required_labels_per_item FROM governed_review_batches b JOIN governed_review_batch_items i ON i.batch_id=b.id WHERE i.id=NEW.batch_item_id) OR NEW.governed_label_ids IS NOT (SELECT json_group_array(label_id ORDER BY label_id) FROM governed_active_review_labels WHERE batch_item_id=NEW.batch_item_id)) THEN RAISE(ABORT,'truth must name every exact active independent label') END;
 SELECT CASE WHEN NEW.source_kind='adjudication' AND NOT EXISTS(SELECT 1 FROM governed_review_adjudications a WHERE a.id=NEW.adjudication_id AND a.batch_item_id=NEW.batch_item_id AND a.decision=NEW.resolved_label AND a.considered_label_count=NEW.supporting_label_count) THEN RAISE(ABORT,'truth requires exact authoritative adjudication') END;
 SELECT CASE WHEN NEW.source_kind='imported_truth' AND NOT EXISTS(SELECT 1 FROM governed_imported_truth t JOIN dataset_revisions r ON r.id=NEW.dataset_revision_id JOIN dataset_revision_items i ON i.id=NEW.dataset_revision_item_id WHERE t.id=NEW.imported_truth_id AND r.role IN('analysis_authoring','iterative_development') AND r.source_kind='collection_snapshot' AND t.project_id=NEW.project_id AND t.criterion_version_id=NEW.criterion_version_id AND t.input_digest=i.input_digest AND governed_canonical_json_v1(t.payload_snapshot)=governed_canonical_json_v1(i.payload_snapshot) AND t.label=NEW.resolved_label AND NEW.resolution_kind=CASE t.evidence_class WHEN 'imported_self_attested' THEN 'imported_self_attested' WHEN 'imported_verified_attested' THEN 'imported_verified_attested' ELSE 'imported_unverified' END AND r.provenance_level=CASE t.evidence_class WHEN 'imported_self_attested' THEN 'imported_self_attested' WHEN 'imported_verified_attested' THEN 'imported_verified_attested' ELSE 'unverified' END) THEN RAISE(ABORT,'imported truth must preserve exact artifact and honest provenance') END;
 SELECT CASE WHEN NEW.content_digest IS NOT governed_content_v1_digest('governed-dataset-truth-link/v1',json_object('adjudicationId',NEW.adjudication_id,'batchItemId',NEW.batch_item_id,'criterionVersionId',NEW.criterion_version_id,'datasetRevisionId',NEW.dataset_revision_id,'datasetRevisionItemId',NEW.dataset_revision_item_id,'governedLabelIds',json(NEW.governed_label_ids),'importedTruthId',NEW.imported_truth_id,'resolutionKind',NEW.resolution_kind,'resolvedLabel',NEW.resolved_label,'sourceKind',NEW.source_kind,'supportingLabelCount',NEW.supporting_label_count)) THEN RAISE(ABORT,'truth content digest mismatch') END;
END;
CREATE TRIGGER governed_truth_label_insert BEFORE INSERT ON governed_dataset_truth_link_labels BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_dataset_truth_links t JOIN governed_active_review_labels a ON a.batch_item_id=t.batch_item_id AND a.project_id=t.project_id WHERE t.id=NEW.truth_link_id AND t.project_id=NEW.project_id AND t.source_kind='governed_labels' AND a.label_id=NEW.label_id AND EXISTS(SELECT 1 FROM json_each(t.governed_label_ids) WHERE value=NEW.label_id) AND t.created_command_token=sqlite_command_token() AND NOT EXISTS(SELECT 1 FROM governed_dataset_truth_finalizations WHERE truth_link_id=t.id)) THEN RAISE(ABORT,'truth label requires exact unfinalized owning command') END;
END;
CREATE TRIGGER governed_truth_finalize BEFORE INSERT ON governed_dataset_truth_finalizations BEGIN
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM governed_dataset_truth_links t WHERE t.id=NEW.truth_link_id AND t.project_id=NEW.project_id AND t.created_command_token=NEW.command_token AND (SELECT count(*) FROM governed_dataset_truth_link_labels WHERE truth_link_id=t.id)=json_array_length(t.governed_label_ids)) THEN RAISE(ABORT,'truth requires complete exact label snapshot') END;
END;
CREATE TRIGGER governed_truth_snapshot AFTER INSERT ON governed_dataset_truth_links BEGIN
 INSERT INTO governed_dataset_truth_link_labels(project_id,truth_link_id,label_id) SELECT NEW.project_id,NEW.id,value FROM json_each(NEW.governed_label_ids);
 INSERT INTO governed_dataset_truth_finalizations(truth_link_id,project_id,command_token) VALUES(NEW.id,NEW.project_id,sqlite_command_token());
END;
CREATE TRIGGER governed_adjudication_materialized BEFORE INSERT ON governed_review_adjudications WHEN EXISTS(SELECT 1 FROM governed_dataset_truth_links WHERE batch_item_id=NEW.batch_item_id) BEGIN SELECT RAISE(ABORT,'materialized truth requires protected successor correction'); END;
-- Evidence classes are claims backed by every item, never caller-selected badges.
CREATE TRIGGER dataset_revision_governed_finalize BEFORE INSERT ON dataset_revision_finalizations WHEN EXISTS(SELECT 1 FROM dataset_revisions WHERE id=NEW.revision_id AND provenance_level IN('governed_blind','imported_self_attested','imported_verified_attested')) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM dataset_revisions r WHERE r.id=NEW.revision_id AND r.item_count>0 AND r.criterion_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dataset_revision_items i WHERE i.revision_id=r.id AND NOT EXISTS(SELECT 1 FROM governed_dataset_truth_links t WHERE t.dataset_revision_item_id=i.id AND t.dataset_revision_id=r.id AND ((r.provenance_level='governed_blind' AND t.source_kind IN('governed_labels','adjudication')) OR (r.provenance_level=t.resolution_kind AND t.source_kind='imported_truth'))))) THEN RAISE(ABORT,'claimed revision provenance requires complete authoritative truth links') END;
END;
