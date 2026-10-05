-- Permanent study/draw ownership and the exact selected-item bundle. Study
-- transitions, observations and closures arrive with their own complete guards.
CREATE TABLE analysis_studies (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 population_id TEXT NOT NULL,draw_id TEXT NOT NULL,dataset_revision_id TEXT NOT NULL,
 contract_version TEXT NOT NULL CHECK(contract_version='analysis-study/v1'),
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 240 AND idempotency_key=trim(idempotency_key)),
 request_digest TEXT NOT NULL CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
 content_digest TEXT NOT NULL CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 created_by_user_id TEXT NOT NULL,created_by_subject_id TEXT NOT NULL,created_at TEXT NOT NULL,created_command_token TEXT NOT NULL,
 UNIQUE(project_id,id),UNIQUE(project_id,idempotency_key),UNIQUE(project_id,draw_id),
 FOREIGN KEY(project_id,population_id) REFERENCES analysis_populations(project_id,id),
 FOREIGN KEY(project_id,draw_id) REFERENCES analysis_population_draws(project_id,id),
 FOREIGN KEY(project_id,dataset_revision_id) REFERENCES dataset_revisions(project_id,id),
 FOREIGN KEY(project_id,created_by_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 FOREIGN KEY(project_id,id) REFERENCES analysis_study_finalizations(project_id,study_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE analysis_study_items (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,study_id TEXT NOT NULL,draw_item_id TEXT NOT NULL,
 member_id TEXT NOT NULL,revision_item_id TEXT NOT NULL,case_id TEXT NOT NULL,
 position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 9999),
 content_digest TEXT NOT NULL CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),created_at TEXT NOT NULL,
 UNIQUE(project_id,id),UNIQUE(study_id,position),UNIQUE(study_id,draw_item_id),UNIQUE(study_id,revision_item_id),UNIQUE(study_id,case_id),
 FOREIGN KEY(project_id,study_id) REFERENCES analysis_studies(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,draw_item_id) REFERENCES analysis_population_draw_items(project_id,id),
 FOREIGN KEY(project_id,member_id) REFERENCES analysis_population_members(project_id,id),
 FOREIGN KEY(project_id,revision_item_id) REFERENCES dataset_revision_items(project_id,id)
) STRICT;
CREATE TABLE analysis_study_finalizations (
 study_id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,command_token TEXT NOT NULL,
 UNIQUE(project_id,study_id),FOREIGN KEY(project_id,study_id) REFERENCES analysis_studies(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX analysis_study_project_time ON analysis_studies(project_id,created_at DESC,id);
CREATE TRIGGER analysis_study_insert BEFORE INSERT ON analysis_studies BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NEW.created_command_token IS NOT sqlite_command_token() THEN RAISE(ABORT,'study requires command time and ownership') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects s JOIN project_members m ON m.project_id=s.project_id AND m.user_id=s.account_user_id
 WHERE s.project_id=NEW.project_id AND s.id=NEW.created_by_subject_id AND s.account_user_id=NEW.created_by_user_id AND m.role='owner') THEN RAISE(ABORT,'study requires exact owner subject') END;
 SELECT CASE WHEN NEW.request_digest<>analysis_sha256_v1(json_object('basis','analysis-study-request/v1','populationId',NEW.population_id,'projectId',NEW.project_id))
 OR NEW.content_digest<>analysis_sha256_v1(json_object('basis','analysis-study/v1','contractVersion',NEW.contract_version,'datasetRevisionId',NEW.dataset_revision_id,'drawId',NEW.draw_id,'populationId',NEW.population_id,'projectId',NEW.project_id)) THEN RAISE(ABORT,'study digest mismatch') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analysis_populations p JOIN analysis_population_draws d ON d.population_id=p.id AND d.project_id=p.project_id
 JOIN dataset_revisions r ON r.id=p.dataset_revision_id AND r.project_id=p.project_id
 WHERE p.id=NEW.population_id AND p.project_id=NEW.project_id AND d.id=NEW.draw_id AND r.id=NEW.dataset_revision_id AND d.dataset_revision_id=r.id AND r.source_kind='analysis_population' AND r.analysis_population_id=p.id) THEN RAISE(ABORT,'study population draw revision mismatch') END;
END;
CREATE TRIGGER analysis_study_item_insert BEFORE INSERT ON analysis_study_items BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM analysis_study_finalizations WHERE study_id=NEW.study_id) OR NOT EXISTS(
 SELECT 1 FROM analysis_studies s JOIN analysis_population_draw_items d ON d.draw_id=s.draw_id AND d.population_id=s.population_id AND d.project_id=s.project_id
 JOIN analysis_population_members m ON m.id=d.member_id AND m.project_id=d.project_id AND m.population_id=d.population_id
 WHERE s.id=NEW.study_id AND s.project_id=NEW.project_id AND s.created_at=NEW.created_at AND s.created_command_token=sqlite_command_token()
 AND d.id=NEW.draw_item_id AND d.member_id=NEW.member_id AND d.revision_item_id=NEW.revision_item_id AND d.case_id=NEW.case_id AND d.position=NEW.position AND m.revision_item_id=NEW.revision_item_id AND m.case_id=NEW.case_id) THEN RAISE(ABORT,'study item requires exact selected lineage in creating command') END;
 SELECT CASE WHEN NEW.content_digest<>analysis_sha256_v1(json_object('basis','analysis-study-item/v1','caseId',NEW.case_id,'drawItemId',NEW.draw_item_id,'memberId',NEW.member_id,'position',NEW.position,'revisionItemId',NEW.revision_item_id,'studyId',NEW.study_id)) THEN RAISE(ABORT,'study item digest mismatch') END;
END;
CREATE TRIGGER analysis_study_finalize BEFORE INSERT ON analysis_study_finalizations BEGIN
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM analysis_studies s JOIN analysis_population_draws d ON d.id=s.draw_id
 WHERE s.project_id=NEW.project_id AND s.id=NEW.study_id AND s.created_command_token=NEW.command_token AND d.fixed_budget=(SELECT count(*) FROM analysis_study_items WHERE study_id=s.id))
 OR EXISTS(SELECT d.id,d.member_id,d.revision_item_id,d.case_id,d.position FROM analysis_population_draw_items d JOIN analysis_studies s ON s.draw_id=d.draw_id WHERE s.id=NEW.study_id
 EXCEPT SELECT draw_item_id,member_id,revision_item_id,case_id,position FROM analysis_study_items WHERE study_id=NEW.study_id)
 OR EXISTS(SELECT draw_item_id,member_id,revision_item_id,case_id,position FROM analysis_study_items WHERE study_id=NEW.study_id
 EXCEPT SELECT d.id,d.member_id,d.revision_item_id,d.case_id,d.position FROM analysis_population_draw_items d JOIN analysis_studies s ON s.draw_id=d.draw_id WHERE s.id=NEW.study_id)
 THEN RAISE(ABORT,'study must freeze every selected draw item exactly once') END;
END;
CREATE TRIGGER analysis_studies_immutable BEFORE UPDATE ON analysis_studies BEGIN SELECT RAISE(ABORT,'immutable study evidence'); END;
CREATE TRIGGER analysis_study_items_immutable BEFORE UPDATE ON analysis_study_items BEGIN SELECT RAISE(ABORT,'immutable study evidence'); END;
CREATE TRIGGER analysis_study_finalizations_immutable BEFORE UPDATE ON analysis_study_finalizations BEGIN SELECT RAISE(ABORT,'immutable study evidence'); END;
CREATE TRIGGER analysis_studies_erase BEFORE DELETE ON analysis_studies WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'study evidence deletion requires project erasure'); END;
CREATE TRIGGER analysis_study_items_erase BEFORE DELETE ON analysis_study_items WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'study evidence deletion requires project erasure'); END;
CREATE TRIGGER analysis_study_finalizations_erase BEFORE DELETE ON analysis_study_finalizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'study evidence deletion requires project erasure'); END;
