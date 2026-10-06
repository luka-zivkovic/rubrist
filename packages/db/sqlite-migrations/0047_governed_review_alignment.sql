-- Alignment snapshots freeze the exact visible post-barrier label set.
CREATE VIEW governed_review_batch_label_sets AS SELECT b.id batch_id,
 (SELECT count(*) FROM governed_active_review_labels WHERE batch_id=b.id) label_count,
 (SELECT json_group_array(json_object('batchItemId',batch_item_id,'labelId',label_id,'taskId',task_id) ORDER BY batch_item_id,task_id,label_id) FROM governed_active_review_labels WHERE batch_id=b.id) label_set
 FROM governed_review_batches b;
CREATE TABLE governed_review_alignment_events (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 batch_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 2147483647),
 expected_previous_sequence INTEGER NOT NULL CHECK(expected_previous_sequence BETWEEN 0 AND 2147483647),
 event_kind TEXT NOT NULL CHECK(event_kind IN('comment_recorded','instruction_change_proposed','closed')),
 actor_subject_id TEXT NOT NULL,
 actor_role_at_review TEXT NOT NULL CHECK(length(actor_role_at_review)>0 AND length(CAST(actor_role_at_review AS BLOB))<=256),
 content TEXT NOT NULL CHECK(length(content)>0 AND length(CAST(content AS BLOB))<=65536),
 proposed_instruction_version_id TEXT,
 visible_label_count INTEGER NOT NULL CHECK(visible_label_count BETWEEN 1 AND 2147483647),
 visible_label_set_digest TEXT NOT NULL,
 previous_event_digest TEXT,
 event_digest TEXT NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key)>0 AND length(CAST(idempotency_key AS BLOB))<=1024),
 request_digest TEXT NOT NULL,
 occurred_at TEXT NOT NULL,
 created_command_token TEXT NOT NULL,
 UNIQUE(project_id,id), UNIQUE(batch_id,sequence), UNIQUE(batch_id,idempotency_key), UNIQUE(id,project_id,created_command_token),
 FOREIGN KEY(project_id,batch_id) REFERENCES governed_review_batches(project_id,id),
 FOREIGN KEY(project_id,actor_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 FOREIGN KEY(project_id,proposed_instruction_version_id) REFERENCES review_instruction_versions(project_id,id),
 FOREIGN KEY(id,project_id,created_command_token) REFERENCES governed_review_alignment_finalizations(alignment_event_id,project_id,command_token) DEFERRABLE INITIALLY DEFERRED,
 CHECK((event_kind='instruction_change_proposed' AND proposed_instruction_version_id IS NOT NULL) OR (event_kind<>'instruction_change_proposed' AND proposed_instruction_version_id IS NULL)),
 CHECK(length(visible_label_set_digest)=71 AND substr(visible_label_set_digest,1,7)='sha256:' AND substr(visible_label_set_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(event_digest)=71 AND substr(event_digest,1,7)='sha256:' AND substr(event_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(previous_event_digest IS NULL OR (length(previous_event_digest)=71 AND substr(previous_event_digest,1,7)='sha256:' AND substr(previous_event_digest,8) NOT GLOB '*[^0-9a-f]*'))
) STRICT;
CREATE TABLE governed_review_alignment_event_labels (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 alignment_event_id TEXT NOT NULL,
 label_id TEXT NOT NULL,
 PRIMARY KEY(alignment_event_id,label_id),
 FOREIGN KEY(project_id,alignment_event_id) REFERENCES governed_review_alignment_events(project_id,id),
 FOREIGN KEY(project_id,label_id) REFERENCES governed_review_labels(project_id,id)
) STRICT;
CREATE TABLE governed_review_alignment_finalizations (
 alignment_event_id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 command_token TEXT NOT NULL,
 UNIQUE(alignment_event_id,project_id,command_token),
 FOREIGN KEY(alignment_event_id,project_id,command_token) REFERENCES governed_review_alignment_events(id,project_id,created_command_token)
) STRICT;
CREATE TRIGGER governed_review_alignment_events_immutable BEFORE UPDATE ON governed_review_alignment_events BEGIN SELECT RAISE(ABORT,'immutable alignment evidence'); END;
CREATE TRIGGER governed_review_alignment_events_erase BEFORE DELETE ON governed_review_alignment_events WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'alignment deletion requires project erasure'); END;
CREATE TRIGGER governed_review_alignment_event_labels_immutable BEFORE UPDATE ON governed_review_alignment_event_labels BEGIN SELECT RAISE(ABORT,'immutable alignment evidence'); END;
CREATE TRIGGER governed_review_alignment_event_labels_erase BEFORE DELETE ON governed_review_alignment_event_labels WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'alignment deletion requires project erasure'); END;
CREATE TRIGGER governed_review_alignment_finalizations_immutable BEFORE UPDATE ON governed_review_alignment_finalizations BEGIN SELECT RAISE(ABORT,'immutable alignment evidence'); END;
CREATE TRIGGER governed_review_alignment_finalizations_erase BEFORE DELETE ON governed_review_alignment_finalizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'alignment deletion requires project erasure'); END;
CREATE TRIGGER governed_alignment_insert BEFORE INSERT ON governed_review_alignment_events BEGIN
 SELECT CASE WHEN NEW.occurred_at IS NOT sqlite_command_time() OR NEW.created_command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM governed_review_batch_states WHERE batch_id=NEW.batch_id AND project_id=NEW.project_id AND state='alignment_open') THEN RAISE(ABORT,'alignment requires current command and open alignment barrier') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects s JOIN project_members pm ON pm.project_id=s.project_id AND pm.user_id=s.account_user_id WHERE s.id=NEW.actor_subject_id AND s.project_id=NEW.project_id AND pm.role=NEW.actor_role_at_review AND (pm.role='owner' OR (pm.role='member' AND EXISTS(SELECT 1 FROM governed_review_tasks WHERE batch_id=NEW.batch_id AND reviewer_subject_id=s.id)))) THEN RAISE(ABORT,'alignment requires live owner or assigned reviewer') END;
 SELECT CASE WHEN NEW.expected_previous_sequence<>coalesce((SELECT max(sequence) FROM governed_review_alignment_events WHERE batch_id=NEW.batch_id),0) OR NEW.sequence<>NEW.expected_previous_sequence+1 OR NEW.previous_event_digest IS NOT (SELECT event_digest FROM governed_review_alignment_events WHERE batch_id=NEW.batch_id ORDER BY sequence DESC LIMIT 1) THEN RAISE(ABORT,'alignment sequence conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM governed_review_alignment_events WHERE batch_id=NEW.batch_id AND event_kind='closed') THEN RAISE(ABORT,'alignment history is closed') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_review_batch_label_sets WHERE batch_id=NEW.batch_id AND label_count=NEW.visible_label_count AND NEW.visible_label_set_digest=governed_content_v1_digest('governed-review-label-set/v1',label_set)) THEN RAISE(ABORT,'alignment requires exact visible label set') END;
 SELECT CASE WHEN NEW.proposed_instruction_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM governed_review_batches b JOIN review_instruction_versions base ON base.id=b.instruction_version_id JOIN review_instruction_versions proposed ON proposed.id=NEW.proposed_instruction_version_id AND proposed.project_id=b.project_id AND proposed.criterion_version_id=b.criterion_version_id AND proposed.revision>base.revision WHERE b.id=NEW.batch_id) THEN RAISE(ABORT,'instruction proposal requires later same-criterion version') END;
 SELECT CASE WHEN NEW.event_digest IS NOT governed_content_v1_digest('governed-review-alignment-event/v1',json_object('actorRoleAtReview',NEW.actor_role_at_review,'actorSubjectId',NEW.actor_subject_id,'batchId',NEW.batch_id,'content',NEW.content,'eventKind',NEW.event_kind,'previousEventDigest',NEW.previous_event_digest,'proposedInstructionVersionId',NEW.proposed_instruction_version_id,'sequence',NEW.sequence,'visibleLabelCount',NEW.visible_label_count,'visibleLabelSetDigest',NEW.visible_label_set_digest)) THEN RAISE(ABORT,'alignment event digest mismatch') END;
END;
CREATE TRIGGER governed_alignment_label_insert BEFORE INSERT ON governed_review_alignment_event_labels BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_review_alignment_events e JOIN governed_active_review_labels a ON a.batch_id=e.batch_id AND a.project_id=e.project_id WHERE e.id=NEW.alignment_event_id AND e.project_id=NEW.project_id AND a.label_id=NEW.label_id AND e.created_command_token=sqlite_command_token() AND NOT EXISTS(SELECT 1 FROM governed_review_alignment_finalizations WHERE alignment_event_id=e.id)) THEN RAISE(ABORT,'alignment label requires exact unfinalized owning command') END;
END;
CREATE TRIGGER governed_alignment_finalize BEFORE INSERT ON governed_review_alignment_finalizations BEGIN
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM governed_review_alignment_events e WHERE e.id=NEW.alignment_event_id AND e.project_id=NEW.project_id AND e.created_command_token=NEW.command_token AND (SELECT count(*) FROM governed_review_alignment_event_labels WHERE alignment_event_id=e.id)=e.visible_label_count AND NOT EXISTS(SELECT 1 FROM governed_active_review_labels a WHERE a.batch_id=e.batch_id AND NOT EXISTS(SELECT 1 FROM governed_review_alignment_event_labels l WHERE l.alignment_event_id=e.id AND l.label_id=a.label_id))) THEN RAISE(ABORT,'alignment requires complete exact visible label snapshot') END;
END;
CREATE TRIGGER governed_alignment_snapshot AFTER INSERT ON governed_review_alignment_events BEGIN
 INSERT INTO governed_review_alignment_event_labels(project_id,alignment_event_id,label_id) SELECT NEW.project_id,NEW.id,label_id FROM governed_active_review_labels WHERE batch_id=NEW.batch_id ORDER BY label_id;
 INSERT INTO governed_review_alignment_finalizations(alignment_event_id,project_id,command_token) VALUES(NEW.id,NEW.project_id,sqlite_command_token());
END;
DROP TRIGGER governed_batch_event_stage;
CREATE TRIGGER governed_batch_event_stage BEFORE INSERT ON governed_review_batch_events WHEN NEW.event_kind='frozen' BEGIN SELECT RAISE(ABORT,'governed truth freeze requires complete port'); END;
DROP TRIGGER governed_batch_event_insert;
CREATE TRIGGER governed_batch_event_insert BEFORE INSERT ON governed_review_batch_events BEGIN
 SELECT CASE WHEN NEW.occurred_at IS NOT sqlite_command_time() OR NOT EXISTS(SELECT 1 FROM governed_review_batches b WHERE b.id=NEW.batch_id AND b.project_id=NEW.project_id AND b.created_at<=NEW.occurred_at AND EXISTS(SELECT 1 FROM governed_review_batch_finalizations WHERE batch_id=b.id)) THEN RAISE(ABORT,'batch event requires current owning command and finalized draft') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects s JOIN project_members pm ON pm.project_id=s.project_id AND pm.user_id=s.account_user_id WHERE s.project_id=NEW.project_id AND s.id=NEW.actor_subject_id AND pm.role='owner' AND NEW.actor_role_at_review='owner') THEN RAISE(ABORT,'batch transition requires live owner') END;
 SELECT CASE WHEN NEW.expected_previous_state_version<>(SELECT state_version FROM governed_review_batch_states WHERE batch_id=NEW.batch_id) OR NEW.state_version<>NEW.expected_previous_state_version+1 OR NEW.sequence<>NEW.state_version OR NEW.previous_event_digest IS NOT (SELECT event_digest FROM governed_review_batch_events WHERE batch_id=NEW.batch_id ORDER BY state_version DESC LIMIT 1) THEN RAISE(ABORT,'governed batch state version conflict') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_review_batch_states WHERE batch_id=NEW.batch_id AND ((state='draft' AND NEW.event_kind IN('open','abandoned')) OR (state='open' AND NEW.event_kind IN('abandoned','labeling_closed')) OR (state='labeling_closed' AND NEW.event_kind IN('alignment_open','adjudicating','resolved','incomplete')) OR (state='alignment_open' AND NEW.event_kind IN('adjudicating','incomplete')) OR (state='adjudicating' AND NEW.event_kind IN('resolved','incomplete')))) THEN RAISE(ABORT,'invalid governed batch transition') END;
 SELECT CASE WHEN NEW.dataset_revision_id IS NOT NULL OR NEW.representative_of_population_id IS NOT NULL OR json_array_length(NEW.representative_ineligible_reasons)<>0 OR governed_jsonb_octets_v1(NEW.details)>65536 THEN RAISE(ABORT,'invalid pre-barrier batch details') END;
 INSERT INTO governed_review_task_events(id,project_id,task_id,sequence,state_version,expected_previous_state_version,event_kind,reason,previous_event_digest,event_digest,idempotency_key,request_digest,occurred_at)
 SELECT 'grte_expired_'||NEW.id||'_'||t.id,t.project_id,t.id,ts.state_version+1,ts.state_version+1,ts.state_version,'expired','fixed_stop',e.event_digest,
 governed_content_v1_digest('governed-review-task-event/v1',json_object('activity',NULL,'actorRoleAtReview',NULL,'actorSubjectId',NULL,'canonicalizationVersion',NULL,'eventKind','expired','exposureClass',NULL,'labelId',NULL,'canonicalViewBytesBase64',NULL,'previousEventDigest',e.event_digest,'reason','fixed_stop','sequence',ts.state_version+1,'stateVersion',ts.state_version+1,'taskId',t.id,'viewContractVersion',NULL,'viewDigest',NULL)),
 'expire:'||NEW.id,governed_content_v1_digest('governed-review-expiry-request/v1',json_object('batchEventId',NEW.id,'taskId',t.id)),NEW.occurred_at
 FROM governed_review_tasks t JOIN governed_review_task_states ts ON ts.task_id=t.id JOIN governed_review_batches b ON b.id=t.batch_id LEFT JOIN governed_review_task_events e ON e.task_id=t.id AND e.state_version=ts.state_version
 WHERE t.batch_id=NEW.batch_id AND NEW.event_kind='labeling_closed' AND governed_timestamp_v1(NEW.occurred_at)>=governed_timestamp_v1(b.stop_at) AND ts.state IN('assigned','viewed','withdrawn') ORDER BY t.id;
 SELECT CASE WHEN NEW.event_kind='labeling_closed' AND EXISTS(SELECT 1 FROM governed_review_task_states WHERE batch_id=NEW.batch_id AND state NOT IN('submitted','deferred','expired')) THEN RAISE(ABORT,'labeling closure requires terminal tasks or fixed stop') END;
 SELECT CASE WHEN NEW.event_kind='resolved' AND EXISTS(SELECT 1 FROM governed_review_item_resolutions WHERE batch_id=NEW.batch_id AND resolution_kind NOT IN('single_rater','unanimous','adjudicated')) THEN RAISE(ABORT,'batch resolution requires complete resolved truth') END;
 SELECT CASE WHEN NEW.event_kind='incomplete' AND NOT EXISTS(SELECT 1 FROM governed_review_item_resolutions WHERE batch_id=NEW.batch_id AND resolution_kind IN('coverage_gap','unresolvable')) THEN RAISE(ABORT,'incomplete requires coverage gap or unresolvable adjudication') END;
 SELECT CASE WHEN NEW.event_kind IN('alignment_open','adjudicating') AND (EXISTS(SELECT 1 FROM governed_review_item_resolutions WHERE batch_id=NEW.batch_id AND resolution_kind='coverage_gap') OR NOT EXISTS(SELECT 1 FROM governed_review_item_resolutions WHERE batch_id=NEW.batch_id AND resolution_kind='conflict')) THEN RAISE(ABORT,'alignment and adjudication require complete coverage and conflict') END;
 SELECT CASE WHEN NEW.event_kind='adjudicating' AND (SELECT state FROM governed_review_batch_states WHERE batch_id=NEW.batch_id)='alignment_open' AND NOT EXISTS(SELECT 1 FROM governed_review_alignment_events WHERE batch_id=NEW.batch_id AND event_kind='closed' AND sequence=(SELECT max(sequence) FROM governed_review_alignment_events WHERE batch_id=NEW.batch_id)) THEN RAISE(ABORT,'alignment must close before adjudication') END;
 SELECT CASE WHEN NEW.event_digest IS NOT governed_content_v1_digest('governed-review-batch-event/v1',json_object('actorRoleAtReview',NEW.actor_role_at_review,'actorSubjectId',NEW.actor_subject_id,'batchId',NEW.batch_id,'datasetRevisionId',NEW.dataset_revision_id,'details',json(NEW.details),'eventKind',NEW.event_kind,'previousEventDigest',NEW.previous_event_digest,'representativeIneligibleReasons',json(NEW.representative_ineligible_reasons),'representativeOfPopulationId',NEW.representative_of_population_id,'sequence',NEW.sequence,'stateVersion',NEW.state_version)) THEN RAISE(ABORT,'governed stream event digest mismatch') END;
END;
