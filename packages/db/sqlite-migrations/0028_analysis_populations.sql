-- Frozen populations and one reproducible draw. All digest checks are triggers.
CREATE TABLE analysis_populations (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL,
 dataset_revision_id TEXT NOT NULL,
 window_start TEXT NOT NULL,
 window_end TEXT NOT NULL,
 eligible_sources TEXT NOT NULL,
 eligible_ingestion_purposes TEXT NOT NULL,
 canonicalization_version TEXT NOT NULL,
 ordering_version TEXT NOT NULL,
 population_size INTEGER NOT NULL,
 exclusion_count INTEGER NOT NULL,
 frame_digest TEXT NOT NULL,
 content_digest TEXT NOT NULL,
 snapshot_kind TEXT NOT NULL CHECK(snapshot_kind='sqlite-serialized-freeze/v1'),
 snapshot_taken_at TEXT NOT NULL,
 created_by_user_id TEXT NOT NULL,
 created_by_subject_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 created_command_token TEXT NOT NULL,
 UNIQUE(project_id,id),
 UNIQUE(project_id,frame_digest),
 UNIQUE(dataset_revision_id),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,created_by_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 FOREIGN KEY(project_id,dataset_revision_id) REFERENCES dataset_revisions(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,id) REFERENCES analysis_population_finalizations(project_id,population_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(window_end>window_start AND population_size BETWEEN 1 AND 100000 AND exclusion_count>=0),
 CHECK(eligible_sources='["manual","langsmith","langfuse","ironside"]'),
 CHECK(eligible_ingestion_purposes='["analysis_eligible_manual","analysis_eligible_langsmith","analysis_eligible_langfuse","analysis_eligible_ironside"]'),
 CHECK(canonicalization_version='governed-content-json/v1' AND ordering_version='cases-created-at-id/v1'),
 CHECK(length(frame_digest)=71 AND substr(frame_digest,1,7)='sha256:' AND substr(frame_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE analysis_population_members (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL,
 population_id TEXT NOT NULL,
 revision_item_id TEXT NOT NULL,
 case_id TEXT NOT NULL,
 raw_trace_id TEXT NOT NULL,
 source_trace_id TEXT NOT NULL,
 case_type TEXT NOT NULL,
 ingestion_purpose TEXT NOT NULL,
 "position" INTEGER NOT NULL,
 ingestion_time TEXT NOT NULL,
 input_digest TEXT NOT NULL,
 item_digest TEXT NOT NULL,
 frame_member_digest TEXT NOT NULL,
 lineage_digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(project_id,id),
 FOREIGN KEY(project_id,population_id) REFERENCES analysis_populations(project_id,id) ON DELETE CASCADE,
 UNIQUE(population_id,position),
 UNIQUE(population_id,case_id),
 UNIQUE(population_id,revision_item_id),
 FOREIGN KEY(project_id,revision_item_id) REFERENCES dataset_revision_items(project_id,id),
 CHECK(position BETWEEN 0 AND 99999),
 CHECK(length(source_trace_id)>0),
 CHECK(length(input_digest)=71 AND substr(input_digest,1,7)='sha256:' AND substr(input_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(item_digest)=71 AND substr(item_digest,1,7)='sha256:' AND substr(item_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(frame_member_digest)=71 AND substr(frame_member_digest,1,7)='sha256:' AND substr(frame_member_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(lineage_digest)=71 AND substr(lineage_digest,1,7)='sha256:' AND substr(lineage_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE analysis_population_exclusions (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL,
 population_id TEXT NOT NULL,
 case_id TEXT NOT NULL,
 raw_trace_id TEXT,
 source_trace_id TEXT,
 case_type TEXT NOT NULL,
 ingestion_purpose TEXT NOT NULL,
 "position" INTEGER NOT NULL,
 ingestion_time TEXT NOT NULL,
 reason TEXT NOT NULL,
 content_digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(project_id,id),
 FOREIGN KEY(project_id,population_id) REFERENCES analysis_populations(project_id,id) ON DELETE CASCADE,
 UNIQUE(population_id,position),
 UNIQUE(population_id,case_id),
 CHECK(position>=0),
 CHECK(reason='ineligible_ingestion_purpose'),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE analysis_population_draws (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL,
 population_id TEXT NOT NULL,
 dataset_revision_id TEXT NOT NULL,
 method TEXT NOT NULL,
 stopping_rule TEXT NOT NULL,
 draw_executor TEXT NOT NULL,
 seed TEXT NOT NULL,
 rng_version TEXT NOT NULL,
 algorithm_version TEXT NOT NULL,
 fixed_budget INTEGER NOT NULL,
 population_size INTEGER NOT NULL,
 inclusion_numerator INTEGER NOT NULL,
 inclusion_denominator INTEGER NOT NULL,
 draw_digest TEXT NOT NULL,
 content_digest TEXT NOT NULL,
 executed_by_subject_id TEXT NOT NULL,
 executed_at TEXT NOT NULL,
 UNIQUE(project_id,id),
 FOREIGN KEY(project_id,population_id) REFERENCES analysis_populations(project_id,id) ON DELETE CASCADE,
 UNIQUE(population_id),
 FOREIGN KEY(project_id,dataset_revision_id) REFERENCES dataset_revisions(project_id,id),
 FOREIGN KEY(project_id,executed_by_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 CHECK(method='simple_random' AND stopping_rule='fixed' AND draw_executor='rubrist_server'),
 CHECK(rng_version='sha256-rank/v1' AND algorithm_version='rubrist-analysis-draw/v1'),
 CHECK(length(seed)=64 AND seed NOT GLOB '*[^0-9a-f]*'),
 CHECK(fixed_budget BETWEEN 1 AND 10000 AND population_size BETWEEN 1 AND 100000 AND fixed_budget<=population_size AND inclusion_numerator=fixed_budget AND inclusion_denominator=population_size),
 CHECK(length(draw_digest)=71 AND substr(draw_digest,1,7)='sha256:' AND substr(draw_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE analysis_population_draw_items (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL,
 draw_id TEXT NOT NULL,
 population_id TEXT NOT NULL,
 member_id TEXT NOT NULL,
 revision_item_id TEXT NOT NULL,
 case_id TEXT NOT NULL,
 "position" INTEGER NOT NULL,
 frame_member_digest TEXT NOT NULL,
 rank_digest TEXT NOT NULL,
 content_digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(project_id,id),
 FOREIGN KEY(project_id,population_id) REFERENCES analysis_populations(project_id,id) ON DELETE CASCADE,
 UNIQUE(draw_id,position),
 UNIQUE(draw_id,member_id),
 UNIQUE(draw_id,case_id),
 UNIQUE(draw_id,revision_item_id),
 FOREIGN KEY(project_id,draw_id) REFERENCES analysis_population_draws(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,member_id) REFERENCES analysis_population_members(project_id,id),
 CHECK(position BETWEEN 0 AND 9999),
 CHECK(length(frame_member_digest)=71 AND substr(frame_member_digest,1,7)='sha256:' AND substr(frame_member_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(rank_digest)=71 AND substr(rank_digest,1,7)='sha256:' AND substr(rank_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE analysis_population_requests (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 population_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(project_id,id),
 FOREIGN KEY(project_id,population_id) REFERENCES analysis_populations(project_id,id) ON DELETE CASCADE,
 UNIQUE(project_id,idempotency_key),
 CHECK(length(idempotency_key)>0 AND idempotency_key=trim(idempotency_key) AND length(cast(idempotency_key AS BLOB))<=1024),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE analysis_population_finalizations (
 population_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, command_token TEXT NOT NULL,
 UNIQUE(project_id,population_id),
 FOREIGN KEY(project_id,population_id) REFERENCES analysis_populations(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER analysis_populations_immutable BEFORE UPDATE ON analysis_populations BEGIN SELECT RAISE(ABORT,'immutable analysis evidence'); END;
CREATE TRIGGER analysis_populations_erase BEFORE DELETE ON analysis_populations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'analysis evidence deletion requires project erasure'); END;
CREATE TRIGGER analysis_population_members_immutable BEFORE UPDATE ON analysis_population_members BEGIN SELECT RAISE(ABORT,'immutable analysis evidence'); END;
CREATE TRIGGER analysis_population_members_erase BEFORE DELETE ON analysis_population_members WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'analysis evidence deletion requires project erasure'); END;
CREATE TRIGGER analysis_population_exclusions_immutable BEFORE UPDATE ON analysis_population_exclusions BEGIN SELECT RAISE(ABORT,'immutable analysis evidence'); END;
CREATE TRIGGER analysis_population_exclusions_erase BEFORE DELETE ON analysis_population_exclusions WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'analysis evidence deletion requires project erasure'); END;
CREATE TRIGGER analysis_population_draws_immutable BEFORE UPDATE ON analysis_population_draws BEGIN SELECT RAISE(ABORT,'immutable analysis evidence'); END;
CREATE TRIGGER analysis_population_draws_erase BEFORE DELETE ON analysis_population_draws WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'analysis evidence deletion requires project erasure'); END;
CREATE TRIGGER analysis_population_draw_items_immutable BEFORE UPDATE ON analysis_population_draw_items BEGIN SELECT RAISE(ABORT,'immutable analysis evidence'); END;
CREATE TRIGGER analysis_population_draw_items_erase BEFORE DELETE ON analysis_population_draw_items WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'analysis evidence deletion requires project erasure'); END;
CREATE TRIGGER analysis_population_requests_immutable BEFORE UPDATE ON analysis_population_requests BEGIN SELECT RAISE(ABORT,'immutable analysis evidence'); END;
CREATE TRIGGER analysis_population_requests_erase BEFORE DELETE ON analysis_population_requests WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'analysis evidence deletion requires project erasure'); END;
CREATE TRIGGER analysis_population_finalizations_immutable BEFORE UPDATE ON analysis_population_finalizations BEGIN SELECT RAISE(ABORT,'immutable analysis evidence'); END;
CREATE TRIGGER analysis_population_finalizations_erase BEFORE DELETE ON analysis_population_finalizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'analysis evidence deletion requires project erasure'); END;

CREATE TRIGGER analysis_population_insert BEFORE INSERT ON analysis_populations BEGIN
 SELECT CASE WHEN NEW.created_command_token IS NOT sqlite_command_token() OR NEW.created_at IS NOT sqlite_command_time() OR NEW.snapshot_taken_at IS NOT sqlite_command_time()
   THEN RAISE(ABORT,'population requires managed serialized snapshot') END;
 SELECT CASE WHEN NEW.window_start IS NOT analysis_timestamp_v1(NEW.window_start) OR NEW.window_end IS NOT analysis_timestamp_v1(NEW.window_end)
   OR CAST(strftime('%s',NEW.window_end) AS INTEGER)*1000+CAST(substr(NEW.window_end,21,3) AS INTEGER)>sqlite_command_milliseconds()-60000 THEN RAISE(ABORT,'population window must be canonical and lag command time') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects WHERE project_id=NEW.project_id AND id=NEW.created_by_subject_id AND account_user_id=NEW.created_by_user_id)
   THEN RAISE(ABORT,'population actor mismatch') END;
END;
DROP TRIGGER dataset_revision_stage;
CREATE TRIGGER dataset_revision_stage BEFORE INSERT ON dataset_revisions WHEN NOT(
 (NEW.analysis_population_id IS NULL AND ((NEW.role IN ('analysis_authoring','iterative_development') AND NEW.source_kind='collection_snapshot') OR (NEW.role='regression_golden' AND NEW.source_kind='golden_snapshot')))
 OR (NEW.source_kind='analysis_population' AND NEW.role='analysis_authoring' AND EXISTS(
 SELECT 1 FROM analysis_populations p WHERE p.project_id=NEW.project_id AND p.id=NEW.analysis_population_id AND p.dataset_revision_id=NEW.id AND p.created_command_token=sqlite_command_token()
 AND NEW.series_id='analysis-population:'||p.id AND NEW.revision_number=1 AND NEW.source_dataset_id IS NULL AND NEW.parent_revision_id IS NULL AND NEW.criterion_version_id IS NULL
 AND NEW.provenance_level='unverified' AND NEW.created_by_user_id=p.created_by_user_id AND NEW.created_at=p.created_at AND NEW.item_count=p.population_size)))
BEGIN SELECT RAISE(ABORT,'governed dataset revision workflow unavailable or population mismatch'); END;

CREATE TRIGGER analysis_member_insert BEFORE INSERT ON analysis_population_members BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analysis_populations p WHERE p.project_id=NEW.project_id AND p.id=NEW.population_id AND NEW.position<p.population_size
 AND p.created_command_token=sqlite_command_token() AND NEW.created_at=sqlite_command_time() AND NEW.ingestion_time>=p.window_start AND NEW.ingestion_time<p.window_end)
 OR EXISTS(SELECT 1 FROM analysis_population_draws WHERE population_id=NEW.population_id) THEN RAISE(ABORT,'member requires open population and bounded position') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cases c JOIN raw_traces r ON r.project_id=c.project_id AND r.id=c.raw_trace_id
 WHERE c.project_id=NEW.project_id AND c.id=NEW.case_id AND r.id=NEW.raw_trace_id AND r.source_trace_id=NEW.source_trace_id
 AND c.case_type=NEW.case_type AND c.ingestion_purpose=NEW.ingestion_purpose AND c.created_at=NEW.ingestion_time
 AND c.ingestion_purpose='analysis_eligible_'||c.case_type AND c.case_type IN ('manual','langsmith','langfuse','ironside')) THEN RAISE(ABORT,'member source mismatch') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM case_input_identity_records WHERE project_id=NEW.project_id AND source_case_id=NEW.case_id AND input_digest=NEW.input_digest
 AND identity_basis='input-identity/v1' AND record_kind IN ('authoring_import','identity_resolved'))
 OR EXISTS(SELECT 1 FROM case_input_identity_records WHERE project_id=NEW.project_id AND source_case_id=NEW.case_id AND input_digest<>NEW.input_digest
 AND identity_basis='input-identity/v1' AND record_kind IN ('authoring_import','identity_resolved'))
 OR NOT EXISTS(SELECT 1 FROM governed_input_identity_claims WHERE project_id=NEW.project_id AND input_digest=NEW.input_digest AND usage_class='nonsealed')
 THEN RAISE(ABORT,'member requires exact nonsealed identity') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM dataset_revision_items i JOIN analysis_populations p ON p.dataset_revision_id=i.revision_id AND p.project_id=i.project_id
 WHERE p.id=NEW.population_id AND i.project_id=NEW.project_id AND i.id=NEW.revision_item_id AND i.position=NEW.position AND i.source_case_id=NEW.case_id AND i.source_trace_id=NEW.source_trace_id
 AND i.source_dataset_item_id IS NULL AND i.source_golden_entry_id IS NULL AND i.input_digest=NEW.input_digest AND i.item_digest=NEW.item_digest
 AND i.reference_label IS NULL AND i.reference_fail_step IS NULL AND i.note IS NULL
 AND governed_canonical_json_v1(i.payload_snapshot)=(SELECT analysis_payload_snapshot_v1(normalized_payload) FROM cases WHERE project_id=NEW.project_id AND id=NEW.case_id)
 AND governed_canonical_json_v1(i.reference_provenance)=governed_canonical_json_v1(json_object('actorUserIds',json('[]'),'basis','Analysis population member; no reference label.','kind','unlabeled','sourceId',NEW.case_id,'verdictIds',json('[]')))
 AND NEW.item_digest=analysis_sha256_v1(json_object('basis','dataset-revision-item/v1','expectedFailStep',NULL,'inputIdentity',json_object('basis','input-identity/v1','digest',NEW.input_digest),'note',NULL,'redactedPayload',json(i.payload_snapshot),'referenceLabel',NULL,'reviewProvenance',json(i.reference_provenance))))
 THEN RAISE(ABORT,'member revision binding mismatch') END;
 SELECT CASE WHEN NEW.frame_member_digest<>analysis_sha256_v1(json_object('basis','analysis-population-frame-member/v1','caseId',NEW.case_id,'ingestionTime',analysis_timestamp_v1(NEW.ingestion_time),'inputDigest',NEW.input_digest,'itemDigest',NEW.item_digest,'position',NEW.position))
 OR NEW.lineage_digest<>analysis_sha256_v1(json_object('basis','analysis-population-member/v1','caseId',NEW.case_id,'ingestionTime',analysis_timestamp_v1(NEW.ingestion_time),'inputDigest',NEW.input_digest,'itemDigest',NEW.item_digest,'position',NEW.position,'revisionItemId',NEW.revision_item_id)) THEN RAISE(ABORT,'member digest mismatch') END;
END;
CREATE TRIGGER analysis_exclusion_insert BEFORE INSERT ON analysis_population_exclusions BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analysis_populations p WHERE p.project_id=NEW.project_id AND p.id=NEW.population_id AND NEW.position<p.exclusion_count
 AND p.created_command_token=sqlite_command_token() AND NEW.created_at=sqlite_command_time() AND NEW.ingestion_time>=p.window_start AND NEW.ingestion_time<p.window_end)
 OR EXISTS(SELECT 1 FROM analysis_population_draws WHERE population_id=NEW.population_id) THEN RAISE(ABORT,'exclusion requires open population and bounded position') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cases c LEFT JOIN raw_traces r ON r.project_id=c.project_id AND r.id=c.raw_trace_id
 WHERE c.project_id=NEW.project_id AND c.id=NEW.case_id AND c.raw_trace_id IS NEW.raw_trace_id AND r.source_trace_id IS NEW.source_trace_id
 AND c.case_type=NEW.case_type AND c.ingestion_purpose=NEW.ingestion_purpose AND c.created_at=NEW.ingestion_time
 AND ((c.case_type='manual' AND c.raw_trace_id IS NOT NULL AND c.ingestion_purpose IN ('judge_api','judge_batch_general','dataset_example','trace_test_synthetic')) OR (c.case_type='release_evidence' AND c.ingestion_purpose='release_evidence')))
 THEN RAISE(ABORT,'exclusion source mismatch') END;
 SELECT CASE WHEN NEW.content_digest<>analysis_sha256_v1(json_object('basis','analysis-population-exclusion/v1','caseId',NEW.case_id,'caseType',NEW.case_type,'ingestionPurpose',NEW.ingestion_purpose,'ingestionTime',analysis_timestamp_v1(NEW.ingestion_time),'position',CAST(NEW.position AS TEXT),'rawTraceId',NEW.raw_trace_id,'reason',NEW.reason,'sourceTraceId',NEW.source_trace_id)) THEN RAISE(ABORT,'exclusion digest mismatch') END;
END;
CREATE TRIGGER analysis_draw_insert BEFORE INSERT ON analysis_population_draws BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analysis_populations p WHERE p.project_id=NEW.project_id AND p.id=NEW.population_id AND p.dataset_revision_id=NEW.dataset_revision_id AND p.population_size=NEW.population_size
 AND p.created_command_token=sqlite_command_token() AND NEW.executed_at=sqlite_command_time() AND NEW.executed_by_subject_id=p.created_by_subject_id
 AND p.population_size=(SELECT count(*) FROM analysis_population_members WHERE population_id=p.id) AND p.exclusion_count=(SELECT count(*) FROM analysis_population_exclusions WHERE population_id=p.id)) THEN RAISE(ABORT,'draw requires exact complete population') END;
END;
CREATE TRIGGER analysis_draw_item_insert BEFORE INSERT ON analysis_population_draw_items BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM analysis_population_finalizations WHERE population_id=NEW.population_id)
 OR NOT EXISTS(SELECT 1 FROM analysis_population_draws d JOIN analysis_population_members m ON m.population_id=d.population_id AND m.project_id=d.project_id
 JOIN analysis_populations p ON p.id=d.population_id
 WHERE d.project_id=NEW.project_id AND d.id=NEW.draw_id AND d.population_id=NEW.population_id AND NEW.position<d.fixed_budget
 AND p.created_command_token=sqlite_command_token() AND NEW.created_at=sqlite_command_time()
 AND m.id=NEW.member_id AND m.revision_item_id=NEW.revision_item_id AND m.case_id=NEW.case_id AND m.frame_member_digest=NEW.frame_member_digest
 AND NEW.rank_digest=analysis_sha256_v1(json_object('basis','rubrist-analysis-rank/v1','caseId',NEW.case_id,'frameMemberDigest',NEW.frame_member_digest,'seed',d.seed))) THEN RAISE(ABORT,'draw item binding or rank mismatch') END;
 SELECT CASE WHEN NEW.content_digest<>analysis_sha256_v1(json_object('basis','analysis-population-draw-item/v1','caseId',NEW.case_id,'frameMemberDigest',NEW.frame_member_digest,'memberId',NEW.member_id,'position',NEW.position,'rankDigest',NEW.rank_digest,'revisionItemId',NEW.revision_item_id)) THEN RAISE(ABORT,'draw item digest mismatch') END;
END;
CREATE TRIGGER analysis_request_insert BEFORE INSERT ON analysis_population_requests BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NOT EXISTS(SELECT 1 FROM analysis_populations p JOIN analysis_population_draws d ON d.population_id=p.id
 WHERE p.project_id=NEW.project_id AND p.id=NEW.population_id AND NEW.request_digest=analysis_sha256_v1(json_object('basis','analysis-population-request/v1','fixedBudget',d.fixed_budget,'projectId',p.project_id,'windowEnd',p.window_end,'windowStart',p.window_start))) THEN RAISE(ABORT,'request body mismatch') END;
END;

CREATE TRIGGER analysis_population_finalize BEFORE INSERT ON analysis_population_finalizations BEGIN
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM analysis_populations p JOIN dataset_revisions r ON r.id=p.dataset_revision_id AND r.project_id=p.project_id
 WHERE p.id=NEW.population_id AND p.project_id=NEW.project_id AND p.created_command_token=NEW.command_token AND r.analysis_population_id=p.id AND r.source_kind='analysis_population' AND r.role='analysis_authoring'
 AND r.series_id='analysis-population:'||p.id AND r.revision_number=1 AND r.source_dataset_id IS NULL AND r.parent_revision_id IS NULL AND r.criterion_version_id IS NULL
 AND r.provenance_level='unverified' AND r.created_by_user_id=p.created_by_user_id AND r.created_at=p.created_at AND r.item_count=p.population_size)
 THEN RAISE(ABORT,'population reciprocal revision mismatch') END;

SELECT CASE WHEN (SELECT count(*) FROM analysis_population_members WHERE population_id=NEW.population_id)<>(SELECT population_size FROM analysis_populations WHERE id=NEW.population_id) OR EXISTS(SELECT c.id,c.created_at,row_number() OVER(ORDER BY c.created_at,governed_utf16_sort_key_v1(c.id))-1 FROM cases c JOIN analysis_populations p ON p.project_id=c.project_id WHERE p.id=NEW.population_id AND c.created_at>=p.window_start AND c.created_at<p.window_end AND c.ingestion_purpose IN ('analysis_eligible_manual','analysis_eligible_langsmith','analysis_eligible_langfuse','analysis_eligible_ironside') EXCEPT SELECT case_id,ingestion_time,position FROM analysis_population_members WHERE population_id=NEW.population_id) OR EXISTS(SELECT case_id,ingestion_time,position FROM analysis_population_members WHERE population_id=NEW.population_id EXCEPT SELECT c.id,c.created_at,row_number() OVER(ORDER BY c.created_at,governed_utf16_sort_key_v1(c.id))-1 FROM cases c JOIN analysis_populations p ON p.project_id=c.project_id WHERE p.id=NEW.population_id AND c.created_at>=p.window_start AND c.created_at<p.window_end AND c.ingestion_purpose IN ('analysis_eligible_manual','analysis_eligible_langsmith','analysis_eligible_langfuse','analysis_eligible_ironside')) THEN RAISE(ABORT,'population requires complete ordered analysis_population_members') END;
SELECT CASE WHEN (SELECT count(*) FROM analysis_population_exclusions WHERE population_id=NEW.population_id)<>(SELECT exclusion_count FROM analysis_populations WHERE id=NEW.population_id) OR EXISTS(SELECT c.id,c.created_at,row_number() OVER(ORDER BY c.created_at,governed_utf16_sort_key_v1(c.id))-1 FROM cases c JOIN analysis_populations p ON p.project_id=c.project_id WHERE p.id=NEW.population_id AND c.created_at>=p.window_start AND c.created_at<p.window_end AND c.ingestion_purpose IN ('judge_api','judge_batch_general','dataset_example','trace_test_synthetic','release_evidence') EXCEPT SELECT case_id,ingestion_time,position FROM analysis_population_exclusions WHERE population_id=NEW.population_id) OR EXISTS(SELECT case_id,ingestion_time,position FROM analysis_population_exclusions WHERE population_id=NEW.population_id EXCEPT SELECT c.id,c.created_at,row_number() OVER(ORDER BY c.created_at,governed_utf16_sort_key_v1(c.id))-1 FROM cases c JOIN analysis_populations p ON p.project_id=c.project_id WHERE p.id=NEW.population_id AND c.created_at>=p.window_start AND c.created_at<p.window_end AND c.ingestion_purpose IN ('judge_api','judge_batch_general','dataset_example','trace_test_synthetic','release_evidence')) THEN RAISE(ABORT,'population requires complete ordered analysis_population_exclusions') END;
SELECT CASE WHEN EXISTS(SELECT 1 FROM analysis_population_members m WHERE m.population_id=NEW.population_id AND (
 NOT EXISTS(SELECT 1 FROM case_input_identity_records i WHERE i.project_id=m.project_id AND i.source_case_id=m.case_id AND i.input_digest=m.input_digest AND i.identity_basis='input-identity/v1' AND i.record_kind IN ('authoring_import','identity_resolved')) OR
 EXISTS(SELECT 1 FROM case_input_identity_records i WHERE i.project_id=m.project_id AND i.source_case_id=m.case_id AND i.input_digest<>m.input_digest AND i.identity_basis='input-identity/v1' AND i.record_kind IN ('authoring_import','identity_resolved')))) THEN RAISE(ABORT,'population identity changed before finalization') END;
SELECT CASE WHEN EXISTS(SELECT 1 FROM analysis_populations p JOIN dataset_revisions r ON r.id=p.dataset_revision_id WHERE p.id=NEW.population_id AND (p.frame_digest<>analysis_sha256_v1(json_object('basis','analysis-population-frame/v1','canonicalizationVersion',p.canonicalization_version,'eligibleIngestionPurposes',json(p.eligible_ingestion_purposes),'eligibleSources',json(p.eligible_sources),'frameMemberDigests',json((SELECT json_group_array(frame_member_digest ORDER BY position) FROM analysis_population_members WHERE population_id=p.id)),'orderingVersion',p.ordering_version,'projectId',p.project_id,'windowEnd',p.window_end,'windowStart',p.window_start)) OR p.content_digest<>analysis_sha256_v1(json_object('basis','analysis-population-content/v1','itemDigests',json((SELECT json_group_array(item_digest ORDER BY position) FROM analysis_population_members WHERE population_id=p.id)))) OR r.content_digest<>analysis_sha256_v1(json_object('basis','dataset-revision-content/v1','inputIdentityBasis','input-identity/v1','itemDigests',json((SELECT json_group_array(item_digest ORDER BY item_digest) FROM analysis_population_members WHERE population_id=p.id)))) OR r.revision_digest<>analysis_sha256_v1(json_object('basis','dataset-revision/v1','inputIdentityBasis','input-identity/v1','role','analysis_authoring','itemDigests',json((SELECT json_group_array(item_digest ORDER BY item_digest) FROM analysis_population_members WHERE population_id=p.id)))))) THEN RAISE(ABORT,'population aggregate digest mismatch') END;
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analysis_population_draws d JOIN analysis_populations p ON p.id=d.population_id WHERE p.id=NEW.population_id
 AND d.fixed_budget=(SELECT count(*) FROM analysis_population_draw_items WHERE draw_id=d.id) AND d.content_digest=analysis_sha256_v1(json_object('basis','analysis-population-draw-content/v1','drawItemContentDigests',json((SELECT json_group_array(content_digest ORDER BY position) FROM analysis_population_draw_items WHERE draw_id=d.id)))) AND d.draw_digest=analysis_sha256_v1(json_object('algorithmVersion',d.algorithm_version,'basis','rubrist-analysis-draw/v1','contentDigest',d.content_digest,'datasetRevisionId',d.dataset_revision_id,'drawExecutor',d.draw_executor,'drawItemContentDigests',json((SELECT json_group_array(content_digest ORDER BY position) FROM analysis_population_draw_items WHERE draw_id=d.id)),'fixedBudget',d.fixed_budget,'frameDigest',p.frame_digest,'inclusionProbability',json_object('denominator',d.inclusion_denominator,'numerator',d.inclusion_numerator),'method',d.method,'populationId',d.population_id,'populationSize',d.population_size,'rngVersion',d.rng_version,'seed',d.seed,'stoppingRule',d.stopping_rule))) THEN RAISE(ABORT,'population requires complete digest-bound draw') END;
 SELECT CASE WHEN EXISTS(
 SELECT member_id,rank_digest,expected_position FROM (
 SELECT member_id,rank_digest,row_number() OVER(ORDER BY rank_digest,frame_member_digest,governed_utf16_sort_key_v1(case_id))-1 expected_position,fixed_budget FROM (
 SELECT m.id member_id,m.case_id,m.frame_member_digest,d.fixed_budget,analysis_sha256_v1(json_object('basis','rubrist-analysis-rank/v1','caseId',m.case_id,'frameMemberDigest',m.frame_member_digest,'seed',d.seed)) rank_digest
 FROM analysis_population_members m JOIN analysis_population_draws d ON d.population_id=m.population_id WHERE m.population_id=NEW.population_id)) WHERE expected_position<fixed_budget
 EXCEPT SELECT member_id,rank_digest,position FROM analysis_population_draw_items WHERE population_id=NEW.population_id) THEN RAISE(ABORT,'draw selection mismatch') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analysis_population_requests WHERE population_id=NEW.population_id) THEN RAISE(ABORT,'population requires exact request binding') END;
END;

CREATE TRIGGER analysis_freeze_cases_delete BEFORE DELETE ON cases
 WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) AND EXISTS(
 SELECT 1 FROM analysis_populations p JOIN cases c ON c.project_id=p.project_id
 WHERE p.project_id=OLD.project_id AND c.id=OLD.id AND c.created_at>=p.window_start AND c.created_at<p.window_end AND p.created_command_token=sqlite_command_token())
 BEGIN SELECT RAISE(ABORT,'population source cannot change in its creating command'); END;
CREATE TRIGGER analysis_freeze_cases_update BEFORE UPDATE ON cases
 WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) AND EXISTS(
 SELECT 1 FROM analysis_populations p JOIN cases c ON c.project_id=p.project_id
 WHERE p.project_id=OLD.project_id AND c.id=OLD.id AND c.created_at>=p.window_start AND c.created_at<p.window_end AND p.created_command_token=sqlite_command_token())
 BEGIN SELECT RAISE(ABORT,'population source cannot change in its creating command'); END;
CREATE TRIGGER analysis_freeze_raw_traces_delete BEFORE DELETE ON raw_traces
 WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) AND EXISTS(
 SELECT 1 FROM analysis_populations p JOIN cases c ON c.project_id=p.project_id
 WHERE p.project_id=OLD.project_id AND c.raw_trace_id=OLD.id AND c.created_at>=p.window_start AND c.created_at<p.window_end AND p.created_command_token=sqlite_command_token())
 BEGIN SELECT RAISE(ABORT,'population source cannot change in its creating command'); END;
CREATE TRIGGER analysis_freeze_raw_traces_update BEFORE UPDATE ON raw_traces
 WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) AND EXISTS(
 SELECT 1 FROM analysis_populations p JOIN cases c ON c.project_id=p.project_id
 WHERE p.project_id=OLD.project_id AND c.raw_trace_id=OLD.id AND c.created_at>=p.window_start AND c.created_at<p.window_end AND p.created_command_token=sqlite_command_token())
 BEGIN SELECT RAISE(ABORT,'population source cannot change in its creating command'); END;
CREATE TRIGGER analysis_freeze_identity_insert BEFORE INSERT ON case_input_identity_records WHEN EXISTS(
 SELECT 1 FROM analysis_populations p JOIN cases c ON c.project_id=p.project_id
 WHERE p.project_id=NEW.project_id AND c.id=NEW.source_case_id AND c.created_at>=p.window_start AND c.created_at<p.window_end AND p.created_command_token=sqlite_command_token())
 BEGIN SELECT RAISE(ABORT,'population identity cannot change in its creating command'); END;
CREATE TRIGGER analysis_eval_boundary_insert BEFORE INSERT ON eval_runs WHEN EXISTS(SELECT 1 FROM dataset_revisions WHERE id=NEW.dataset_revision_id AND source_kind='analysis_population')
 BEGIN SELECT RAISE(ABORT,'analysis population revisions require a governed handoff before evaluation'); END;
CREATE TRIGGER analysis_eval_boundary_update BEFORE UPDATE ON eval_runs WHEN EXISTS(SELECT 1 FROM dataset_revisions WHERE id=NEW.dataset_revision_id AND source_kind='analysis_population')
 BEGIN SELECT RAISE(ABORT,'analysis population revisions require a governed handoff before evaluation'); END;

CREATE INDEX analysis_population_project_time ON analysis_populations(project_id,created_at DESC,id);
CREATE INDEX analysis_population_overlap ON analysis_population_members(project_id,case_id,population_id);
CREATE INDEX analysis_population_command ON analysis_populations(created_command_token,project_id);
