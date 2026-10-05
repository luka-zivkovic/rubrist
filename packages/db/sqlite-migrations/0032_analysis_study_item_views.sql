CREATE TABLE analysis_study_item_views (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,study_id TEXT NOT NULL,study_item_id TEXT NOT NULL,
 dataset_exposure_event_id TEXT NOT NULL REFERENCES dataset_exposure_events(id),viewer_user_id TEXT NOT NULL,viewer_subject_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,content_digest TEXT NOT NULL,
 counts_toward_closure INTEGER NOT NULL CHECK(counts_toward_closure IN(0,1)),viewed_at TEXT NOT NULL,
 UNIQUE(project_id,id),UNIQUE(study_item_id,idempotency_key),
 FOREIGN KEY(project_id,study_id) REFERENCES analysis_studies(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,study_item_id) REFERENCES analysis_study_items(project_id,id),
 FOREIGN KEY(project_id,viewer_subject_id) REFERENCES governed_reviewer_subjects(project_id,id)
) STRICT;
CREATE INDEX analysis_study_item_views_item ON analysis_study_item_views(study_item_id,viewed_at,id);
CREATE TRIGGER analysis_study_item_view_insert BEFORE INSERT ON analysis_study_item_views BEGIN
 SELECT CASE WHEN NEW.viewed_at IS NOT sqlite_command_time() OR NOT EXISTS(SELECT 1 FROM analysis_study_items WHERE project_id=NEW.project_id AND study_id=NEW.study_id AND id=NEW.study_item_id)
 THEN RAISE(ABORT,'study view requires exact item and command time') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects s JOIN project_members m ON m.project_id=s.project_id AND m.user_id=s.account_user_id
 WHERE s.project_id=NEW.project_id AND s.id=NEW.viewer_subject_id AND s.account_user_id=NEW.viewer_user_id AND m.role IN('owner','member')) THEN RAISE(ABORT,'study view requires exact member subject') END;
 SELECT CASE WHEN coalesce((SELECT to_state FROM analysis_study_events WHERE study_id=NEW.study_id ORDER BY version DESC LIMIT 1),'draft') IN('draft','abandoned')
 OR ((SELECT to_state FROM analysis_study_events WHERE study_id=NEW.study_id ORDER BY version DESC LIMIT 1)='coding_open' AND EXISTS(SELECT 1 FROM analysis_study_events WHERE study_id=NEW.study_id AND event_type='coding_opened' AND stopping_rule='server_deadline' AND close_at<=sqlite_command_time()))
 THEN RAISE(ABORT,'study view unavailable in current state or before overdue closure') END;
 SELECT CASE WHEN NEW.counts_toward_closure IS NOT ((SELECT to_state FROM analysis_study_events WHERE study_id=NEW.study_id ORDER BY version DESC LIMIT 1)='coding_open') THEN RAISE(ABORT,'study view closure participation mismatch') END;
 SELECT CASE WHEN analysis_trimmed_text_v1(NEW.idempotency_key,240) IS NOT 1 THEN RAISE(ABORT,'study view invalid idempotency key') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analysis_studies s JOIN dataset_exposure_events e ON e.project_id=s.project_id AND e.revision_id=s.dataset_revision_id
 WHERE s.id=NEW.study_id AND s.project_id=NEW.project_id AND e.id=NEW.dataset_exposure_event_id AND e.revision_item_id IS NULL
 AND e.kind='human_access' AND e.exposure_class='development' AND e.activity='content_view' AND e.subject_kind='person' AND e.subject_id=NEW.viewer_subject_id AND e.actor_user_id=NEW.viewer_user_id
 AND e.evidence_ref_kind='analysis_population' AND e.evidence_ref_id=s.population_id) THEN RAISE(ABORT,'study view requires exact content exposure') END;
 SELECT CASE WHEN NEW.request_digest IS NOT analysis_sha256_v1(json_object('basis','analysis-study-item-view-request/v1','datasetRevisionId',(SELECT dataset_revision_id FROM analysis_studies WHERE id=NEW.study_id),
 'projectId',NEW.project_id,'studyId',NEW.study_id,'studyItemId',NEW.study_item_id,'viewerSubjectId',NEW.viewer_subject_id,'viewerUserId',NEW.viewer_user_id)) THEN RAISE(ABORT,'study view request digest mismatch') END;
 SELECT CASE WHEN NEW.content_digest IS NOT analysis_sha256_v1(json_object('basis','analysis-study-item-view/v1','countsTowardClosure',json(CASE NEW.counts_toward_closure WHEN 1 THEN 'true' ELSE 'false' END),
 'datasetExposureEventId',NEW.dataset_exposure_event_id,'projectId',NEW.project_id,'requestDigest',NEW.request_digest,'studyId',NEW.study_id,'studyItemId',NEW.study_item_id,
 'viewedAt',NEW.viewed_at,'viewerSubjectId',NEW.viewer_subject_id,'viewerUserId',NEW.viewer_user_id)) THEN RAISE(ABORT,'study view content digest mismatch') END;
END;
CREATE TRIGGER analysis_study_item_views_immutable BEFORE UPDATE ON analysis_study_item_views BEGIN SELECT RAISE(ABORT,'immutable study item views'); END;
CREATE TRIGGER analysis_study_item_views_erase BEFORE DELETE ON analysis_study_item_views WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'study item views deletion requires project erasure'); END;
