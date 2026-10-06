-- Match the governed PostgreSQL content-view identity independently of the
-- request's idempotency key. One person contributes one view per study item.
CREATE UNIQUE INDEX analysis_study_item_view_person
 ON analysis_study_item_views(study_id,study_item_id,viewer_subject_id);
CREATE UNIQUE INDEX analysis_study_view_request
 ON analysis_study_item_views(study_id,idempotency_key);
