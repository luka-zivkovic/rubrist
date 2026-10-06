-- Immutable nonsealed drafts, exact membership and assignment bundles.
CREATE TABLE governed_review_batches (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 criterion_version_id TEXT NOT NULL,
 instruction_version_id TEXT NOT NULL,
 role_intent TEXT NOT NULL,
 source_population_kind TEXT NOT NULL,
 source_population_id TEXT NOT NULL,
 population_id TEXT NOT NULL,
 population_definition TEXT NOT NULL,
 population_collection_provenance TEXT NOT NULL,
 population_size INTEGER NOT NULL,
 population_digest TEXT NOT NULL,
 window_start TEXT,
 window_end TEXT,
 selection_method TEXT NOT NULL,
 selection_seed TEXT,
 rng_version TEXT,
 selection_algorithm_version TEXT NOT NULL,
 serve_order_seed TEXT NOT NULL,
 serve_order_version TEXT NOT NULL,
 draw_executed_by TEXT NOT NULL,
 fixed_budget INTEGER NOT NULL,
 stopping_rule TEXT NOT NULL,
 stop_at TEXT NOT NULL,
 draw_digest TEXT NOT NULL,
 strata TEXT NOT NULL,
 required_labels_per_item INTEGER NOT NULL,
 evaluator_blind INTEGER NOT NULL,
 peer_blind_until_labeling_closed INTEGER NOT NULL,
 separation_of_duties_required INTEGER NOT NULL,
 custodian_subject_id TEXT,
 custodian_role_at_review TEXT,
 state_machine_version TEXT NOT NULL,
 content_digest TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 created_by_subject_id TEXT,
 created_at TEXT NOT NULL,
 created_command_token TEXT NOT NULL,
 UNIQUE(project_id,id),
 UNIQUE(id,project_id,created_command_token),
 FOREIGN KEY(id,project_id,created_command_token) REFERENCES governed_review_batch_finalizations(batch_id,project_id,command_token) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,criterion_version_id) REFERENCES criterion_versions(project_id,id),
 FOREIGN KEY(project_id,instruction_version_id) REFERENCES review_instruction_versions(project_id,id),
 FOREIGN KEY(project_id,custodian_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 FOREIGN KEY(project_id,created_by_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 UNIQUE(project_id,idempotency_key),
 CHECK(role_intent IN('analysis_authoring','iterative_development','sealed_validation')),
 CHECK(source_population_kind IN('dataset_revision','sealed_intake','analysis_promotion_handoff')),
 CHECK(selection_method IN('simple_random','stratified_random','systematic','convenience','uncertainty','failure_hunting','manual')),
 CHECK((draw_executed_by='rubrist_server' AND selection_method IN('simple_random','stratified_random','systematic')) OR (draw_executed_by='caller_selected' AND selection_method IN('convenience','uncertainty','failure_hunting','manual'))),
 CHECK(selection_method NOT IN('simple_random','stratified_random') OR (selection_seed IS NOT NULL AND rng_version IS NOT NULL)),
 CHECK(population_size BETWEEN 0 AND 10000000 AND fixed_budget BETWEEN 1 AND 10000 AND fixed_budget<=population_size),
 CHECK(required_labels_per_item BETWEEN 1 AND 20),
 CHECK(stopping_rule='fixed' AND state_machine_version='governed-review-state/v1' AND serve_order_version='sha256-serve-rank/v1'),
 CHECK(length(serve_order_seed)=64 AND serve_order_seed NOT GLOB '*[^0-9a-f]*'),
 CHECK(evaluator_blind IN(0,1) AND peer_blind_until_labeling_closed IN(0,1) AND separation_of_duties_required IN(0,1)),
 CHECK((window_start IS NULL)=(window_end IS NULL)),
 CHECK(json_valid(population_definition) AND json_valid(population_collection_provenance) AND json_valid(strata) AND json_type(strata)='array' AND json_array_length(strata)<=1000 AND (selection_method<>'stratified_random' OR json_array_length(strata)>0)),
 CHECK((role_intent='sealed_validation' AND source_population_kind='sealed_intake' AND required_labels_per_item>=2 AND evaluator_blind=1 AND peer_blind_until_labeling_closed=1 AND separation_of_duties_required=1 AND custodian_subject_id IS NOT NULL AND custodian_role_at_review IS NOT NULL AND length(custodian_role_at_review)>0) OR (role_intent<>'sealed_validation' AND source_population_kind='dataset_revision') OR (role_intent='analysis_authoring' AND source_population_kind='analysis_promotion_handoff' AND custodian_subject_id IS NULL AND custodian_role_at_review IS NULL)),
 CHECK(length(population_id)>0 AND length(CAST(population_id AS BLOB))<=4096),
 CHECK(length(source_population_id)>0 AND length(CAST(source_population_id AS BLOB))<=4096),
 CHECK(length(selection_algorithm_version)>0 AND length(CAST(selection_algorithm_version AS BLOB))<=256),
 CHECK(length(idempotency_key)>0 AND length(CAST(idempotency_key AS BLOB))<=1024),
 CHECK(rng_version IS NULL OR length(CAST(rng_version AS BLOB))<=256),
 CHECK(selection_seed IS NULL OR length(CAST(selection_seed AS BLOB))<=4096),
 CHECK(custodian_role_at_review IS NULL OR length(CAST(custodian_role_at_review AS BLOB))<=256),
 CHECK(custodian_role_at_review IS NULL OR length(custodian_role_at_review)>0),
 CHECK(length(population_digest)=71 AND substr(population_digest,1,7)='sha256:' AND substr(population_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(draw_digest)=71 AND substr(draw_digest,1,7)='sha256:' AND substr(draw_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TRIGGER governed_review_batches_immutable BEFORE UPDATE ON governed_review_batches BEGIN SELECT RAISE(ABORT,'immutable governed draft evidence'); END;
CREATE TRIGGER governed_review_batches_erase BEFORE DELETE ON governed_review_batches WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'governed draft deletion requires project erasure'); END;
CREATE TABLE governed_review_batch_items (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 batch_id TEXT NOT NULL,
 review_item_id TEXT NOT NULL,
 draw_position INTEGER NOT NULL,
 serve_position INTEGER NOT NULL,
 frame_member_digest TEXT NOT NULL,
 stratum_key TEXT,
 inclusion_probability TEXT,
 sampling_weight TEXT,
 content_digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(project_id,id),
 UNIQUE(project_id,batch_id,id),
 UNIQUE(batch_id,draw_position),
 UNIQUE(batch_id,serve_position),
 UNIQUE(batch_id,review_item_id),
 FOREIGN KEY(project_id,batch_id) REFERENCES governed_review_batches(project_id,id),
 FOREIGN KEY(project_id,review_item_id) REFERENCES governed_review_items(project_id,id),
 CHECK(draw_position BETWEEN 0 AND 2147483647 AND serve_position BETWEEN 0 AND 2147483647),
 CHECK(length(frame_member_digest)=71 AND substr(frame_member_digest,1,7)='sha256:' AND substr(frame_member_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TRIGGER governed_review_batch_items_immutable BEFORE UPDATE ON governed_review_batch_items BEGIN SELECT RAISE(ABORT,'immutable governed draft evidence'); END;
CREATE TRIGGER governed_review_batch_items_erase BEFORE DELETE ON governed_review_batch_items WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'governed draft deletion requires project erasure'); END;
CREATE TABLE governed_review_tasks (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 batch_id TEXT NOT NULL,
 batch_item_id TEXT NOT NULL,
 reviewer_subject_id TEXT NOT NULL,
 reviewer_role_at_review TEXT NOT NULL,
 serve_order INTEGER NOT NULL,
 content_digest TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(project_id,id),
 UNIQUE(batch_item_id,reviewer_subject_id),
 UNIQUE(batch_id,reviewer_subject_id,serve_order),
 UNIQUE(project_id,idempotency_key),
 FOREIGN KEY(project_id,batch_id,batch_item_id) REFERENCES governed_review_batch_items(project_id,batch_id,id),
 FOREIGN KEY(project_id,reviewer_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 CHECK(serve_order BETWEEN 0 AND 200000),
 CHECK(length(reviewer_role_at_review)>0 AND length(CAST(reviewer_role_at_review AS BLOB))<=256),
 CHECK(length(idempotency_key)>0 AND length(CAST(idempotency_key AS BLOB))<=1024),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TRIGGER governed_review_tasks_immutable BEFORE UPDATE ON governed_review_tasks BEGIN SELECT RAISE(ABORT,'immutable governed draft evidence'); END;
CREATE TRIGGER governed_review_tasks_erase BEFORE DELETE ON governed_review_tasks WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'governed draft deletion requires project erasure'); END;
CREATE TABLE governed_review_batch_finalizations (
 batch_id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,command_token TEXT NOT NULL,
 UNIQUE(batch_id,project_id,command_token),FOREIGN KEY(batch_id,project_id,command_token) REFERENCES governed_review_batches(id,project_id,created_command_token)
) STRICT;
CREATE TRIGGER governed_batch_finalize_immutable BEFORE UPDATE ON governed_review_batch_finalizations BEGIN SELECT RAISE(ABORT,'immutable governed draft finalization'); END;
CREATE TRIGGER governed_batch_finalize_erase BEFORE DELETE ON governed_review_batch_finalizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'governed draft finalization deletion requires project erasure'); END;
CREATE TRIGGER governed_batch_source_stage BEFORE INSERT ON governed_review_batches WHEN NEW.source_population_kind<>'dataset_revision' OR NEW.role_intent='sealed_validation' BEGIN SELECT RAISE(ABORT,'governed source requires complete sealed or promotion port'); END;
CREATE TRIGGER governed_batch_insert BEFORE INSERT ON governed_review_batches BEGIN
 SELECT CASE WHEN NEW.window_end IS NOT NULL AND governed_timestamp_v1(NEW.window_end)<=governed_timestamp_v1(NEW.window_start) THEN RAISE(ABORT,'batch time window must be ascending') END;
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NEW.created_command_token IS NOT sqlite_command_token() THEN RAISE(ABORT,'governed draft requires owning command') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM review_instruction_versions WHERE project_id=NEW.project_id AND id=NEW.instruction_version_id AND criterion_version_id=NEW.criterion_version_id) THEN RAISE(ABORT,'batch instruction must bind exact criterion') END;
 SELECT CASE WHEN NEW.source_population_kind='dataset_revision' AND NOT EXISTS(SELECT 1 FROM dataset_revisions WHERE project_id=NEW.project_id AND id=NEW.source_population_id AND role=NEW.role_intent AND role<>'sealed_validation' AND source_kind<>'analysis_population' AND content_digest=NEW.population_digest AND item_count=NEW.population_size) THEN RAISE(ABORT,'batch requires exact immutable source population') END;
 SELECT CASE WHEN governed_timestamp_v1(NEW.stop_at)<=governed_timestamp_v1(sqlite_command_time()) THEN RAISE(ABORT,'batch fixed stop must be in the future') END;
 SELECT CASE WHEN governed_jsonb_octets_v1(NEW.population_definition)>262144 OR governed_jsonb_octets_v1(NEW.population_collection_provenance)>262144 OR governed_jsonb_octets_v1(NEW.strata)>262144 THEN RAISE(ABORT,'batch provenance exceeds byte bounds') END;
 SELECT CASE WHEN NEW.content_digest IS NOT governed_content_v1_digest('governed-review-batch/v1',json_object('criterionVersionId',NEW.criterion_version_id,'custodianRoleAtReview',NEW.custodian_role_at_review,'custodianSubjectId',NEW.custodian_subject_id,'drawDigest',NEW.draw_digest,'drawExecutedBy',NEW.draw_executed_by,'evaluatorBlind',json(CASE NEW.evaluator_blind WHEN 1 THEN 'true' ELSE 'false' END),'fixedBudget',NEW.fixed_budget,'instructionVersionId',NEW.instruction_version_id,'peerBlindUntilLabelingClosed',json(CASE NEW.peer_blind_until_labeling_closed WHEN 1 THEN 'true' ELSE 'false' END),'populationCollectionProvenance',json(NEW.population_collection_provenance),'populationDefinition',json(NEW.population_definition),'populationDigest',NEW.population_digest,'populationId',NEW.population_id,'populationSize',NEW.population_size,'requiredLabelsPerItem',NEW.required_labels_per_item,'rngVersion',NEW.rng_version,'roleIntent',NEW.role_intent,'selectionAlgorithmVersion',NEW.selection_algorithm_version,'selectionMethod',NEW.selection_method,'selectionSeed',NEW.selection_seed,'separationOfDutiesRequired',json(CASE NEW.separation_of_duties_required WHEN 1 THEN 'true' ELSE 'false' END),'serveOrderSeed',NEW.serve_order_seed,'serveOrderVersion',NEW.serve_order_version,'sourcePopulationId',NEW.source_population_id,'sourcePopulationKind',NEW.source_population_kind,'stateMachineVersion',NEW.state_machine_version,'stopAt',CASE WHEN NEW.stop_at IS NULL THEN NULL ELSE governed_timestamp_v1(NEW.stop_at) END,'stoppingRule',NEW.stopping_rule,'strata',json(NEW.strata),'windowEnd',CASE WHEN NEW.window_end IS NULL THEN NULL ELSE governed_timestamp_v1(NEW.window_end) END,'windowStart',CASE WHEN NEW.window_start IS NULL THEN NULL ELSE governed_timestamp_v1(NEW.window_start) END)) THEN RAISE(ABORT,'governed draft content digest mismatch') END;
END;
CREATE TRIGGER governed_batch_item_insert BEFORE INSERT ON governed_review_batch_items BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NOT EXISTS(SELECT 1 FROM governed_review_batches b JOIN governed_review_items i ON i.project_id=b.project_id AND i.id=NEW.review_item_id WHERE b.project_id=NEW.project_id AND b.id=NEW.batch_id AND b.created_command_token=sqlite_command_token() AND NOT EXISTS(SELECT 1 FROM governed_review_batch_finalizations WHERE batch_id=b.id) AND i.source_kind='dataset_revision_item' AND i.source_revision_id=b.source_population_id AND i.content_digest=NEW.frame_member_digest AND NEW.serve_position<b.fixed_budget AND NEW.draw_position<b.fixed_budget AND (b.selection_method<>'stratified_random' OR NEW.stratum_key IS NOT NULL) AND (b.selection_method NOT IN('simple_random','stratified_random') OR (NEW.inclusion_probability IS NOT NULL AND NEW.sampling_weight IS NOT NULL))) THEN RAISE(ABORT,'batch item requires exact source and unfinalized owning command') END;
 SELECT CASE WHEN (NEW.inclusion_probability IS NOT NULL AND governed_positive_numeric_v1(NEW.inclusion_probability,1)<>1) OR (NEW.sampling_weight IS NOT NULL AND governed_positive_numeric_v1(NEW.sampling_weight,0)<>1) THEN RAISE(ABORT,'invalid governed sampling numbers') END;
 SELECT CASE WHEN NEW.content_digest IS NOT governed_content_v1_digest('governed-review-batch-item/v1',json_object('batchId',NEW.batch_id,'drawPosition',NEW.draw_position,'frameMemberDigest',NEW.frame_member_digest,'inclusionProbability',json(NEW.inclusion_probability),'reviewItemId',NEW.review_item_id,'samplingWeight',json(NEW.sampling_weight),'servePosition',NEW.serve_position,'stratumKey',NEW.stratum_key)) THEN RAISE(ABORT,'governed draft content digest mismatch') END;
END;
CREATE TRIGGER governed_task_insert BEFORE INSERT ON governed_review_tasks BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NOT EXISTS(SELECT 1 FROM governed_review_batches b JOIN governed_review_batch_items i ON i.project_id=b.project_id AND i.batch_id=b.id JOIN governed_reviewer_subjects s ON s.project_id=b.project_id AND s.id=NEW.reviewer_subject_id JOIN project_members pm ON pm.project_id=s.project_id AND pm.user_id=s.account_user_id WHERE b.project_id=NEW.project_id AND b.id=NEW.batch_id AND i.id=NEW.batch_item_id AND i.serve_position=NEW.serve_order AND pm.role=NEW.reviewer_role_at_review AND pm.role IN('owner','member') AND b.created_command_token=sqlite_command_token() AND NOT EXISTS(SELECT 1 FROM governed_review_batch_finalizations WHERE batch_id=b.id) AND (b.role_intent<>'sealed_validation' OR s.id<>b.custodian_subject_id) AND (SELECT count(*) FROM governed_review_tasks WHERE batch_item_id=i.id)<b.required_labels_per_item) THEN RAISE(ABORT,'review assignment requires exact live reviewer and unfinalized owning command') END;
 SELECT CASE WHEN NEW.content_digest IS NOT governed_content_v1_digest('governed-review-task/v1',json_object('batchId',NEW.batch_id,'batchItemId',NEW.batch_item_id,'reviewerRoleAtReview',NEW.reviewer_role_at_review,'reviewerSubjectId',NEW.reviewer_subject_id,'serveOrder',NEW.serve_order)) THEN RAISE(ABORT,'governed draft content digest mismatch') END;
END;
CREATE TRIGGER governed_batch_finalize BEFORE INSERT ON governed_review_batch_finalizations BEGIN
 SELECT CASE WHEN analysis_governed_batch_views_valid_v1(NEW.batch_id,NEW.project_id)<>1 THEN RAISE(ABORT,'governed draft blind views exceed safe byte bounds') END;
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM governed_review_batches b WHERE b.id=NEW.batch_id AND b.project_id=NEW.project_id AND b.created_command_token=NEW.command_token AND (SELECT count(*) FROM governed_review_batch_items WHERE batch_id=b.id)=b.fixed_budget AND NOT EXISTS(SELECT 1 FROM governed_review_batch_items i WHERE i.batch_id=b.id AND (SELECT count(*) FROM governed_review_tasks WHERE batch_item_id=i.id)<>b.required_labels_per_item) AND (SELECT count(DISTINCT reviewer_subject_id) FROM governed_review_tasks WHERE batch_id=b.id)=b.required_labels_per_item AND b.draw_digest=governed_content_v1_digest('governed-review-draw/v1',(SELECT json_group_array(json_object('drawPosition',draw_position,'frameMemberDigest',frame_member_digest,'inclusionProbability',json(inclusion_probability),'reviewItemId',review_item_id,'samplingWeight',json(sampling_weight),'stratumKey',stratum_key) ORDER BY draw_position) FROM governed_review_batch_items WHERE batch_id=b.id))) THEN RAISE(ABORT,'governed draft requires complete exact draw and assignments') END;
END;
