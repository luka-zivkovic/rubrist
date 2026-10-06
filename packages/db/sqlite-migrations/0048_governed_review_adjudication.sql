-- Immutable adjudication chains with exact same-command considered-label sets.
CREATE VIEW governed_review_item_label_sets AS SELECT i.id batch_item_id,
 (SELECT count(*) FROM governed_active_review_labels WHERE batch_item_id=i.id) label_count,
 (SELECT json_group_array(json_object('labelId',label_id,'taskId',task_id) ORDER BY task_id,label_id) FROM governed_active_review_labels WHERE batch_item_id=i.id) label_set
 FROM governed_review_batch_items i;
CREATE TABLE governed_review_adjudications (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 batch_id TEXT NOT NULL,
 batch_item_id TEXT NOT NULL,
 chain_version INTEGER NOT NULL CHECK(chain_version BETWEEN 1 AND 2147483647),
 expected_previous_chain_version INTEGER NOT NULL CHECK(expected_previous_chain_version BETWEEN 0 AND 2147483647),
 supersedes_adjudication_id TEXT,
 adjudicator_subject_id TEXT NOT NULL,
 adjudicator_role_at_review TEXT NOT NULL CHECK(length(adjudicator_role_at_review)>0 AND length(CAST(adjudicator_role_at_review AS BLOB))<=256),
 decision TEXT NOT NULL CHECK(decision IN('pass','fail','unresolvable')),
 rationale TEXT NOT NULL CHECK(length(rationale)>0 AND length(CAST(rationale AS BLOB))<=32768),
 basis TEXT NOT NULL CHECK(length(basis)>0 AND length(CAST(basis AS BLOB))<=32768),
 correction_reason TEXT CHECK(correction_reason IS NULL OR (length(correction_reason)>0 AND length(CAST(correction_reason AS BLOB))<=32768)),
 considered_label_count INTEGER NOT NULL CHECK(considered_label_count BETWEEN 1 AND 2147483647),
 considered_label_set_digest TEXT NOT NULL,
 content_digest TEXT NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key)>0 AND length(CAST(idempotency_key AS BLOB))<=1024),
 request_digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 created_command_token TEXT NOT NULL,
 UNIQUE(project_id,id), UNIQUE(batch_item_id,chain_version), UNIQUE(batch_item_id,idempotency_key), UNIQUE(supersedes_adjudication_id), UNIQUE(id,project_id,created_command_token),
 FOREIGN KEY(project_id,batch_id,batch_item_id) REFERENCES governed_review_batch_items(project_id,batch_id,id),
 FOREIGN KEY(project_id,adjudicator_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 FOREIGN KEY(project_id,supersedes_adjudication_id) REFERENCES governed_review_adjudications(project_id,id),
 FOREIGN KEY(id,project_id,created_command_token) REFERENCES governed_review_adjudication_finalizations(adjudication_id,project_id,command_token) DEFERRABLE INITIALLY DEFERRED,
 CHECK((chain_version=1 AND supersedes_adjudication_id IS NULL AND correction_reason IS NULL) OR (chain_version>1 AND supersedes_adjudication_id IS NOT NULL AND correction_reason IS NOT NULL)),
 CHECK(length(considered_label_set_digest)=71 AND substr(considered_label_set_digest,1,7)='sha256:' AND substr(considered_label_set_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE governed_review_adjudication_labels (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 adjudication_id TEXT NOT NULL,
 label_id TEXT NOT NULL,
 PRIMARY KEY(adjudication_id,label_id),
 FOREIGN KEY(project_id,adjudication_id) REFERENCES governed_review_adjudications(project_id,id),
 FOREIGN KEY(project_id,label_id) REFERENCES governed_review_labels(project_id,id)
) STRICT;
CREATE TABLE governed_review_adjudication_finalizations (
 adjudication_id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 command_token TEXT NOT NULL,
 UNIQUE(adjudication_id,project_id,command_token),
 FOREIGN KEY(adjudication_id,project_id,command_token) REFERENCES governed_review_adjudications(id,project_id,created_command_token)
) STRICT;
CREATE TRIGGER governed_review_adjudications_immutable BEFORE UPDATE ON governed_review_adjudications BEGIN SELECT RAISE(ABORT,'immutable adjudication evidence'); END;
CREATE TRIGGER governed_review_adjudications_erase BEFORE DELETE ON governed_review_adjudications WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'adjudication deletion requires project erasure'); END;
CREATE TRIGGER governed_review_adjudication_labels_immutable BEFORE UPDATE ON governed_review_adjudication_labels BEGIN SELECT RAISE(ABORT,'immutable adjudication evidence'); END;
CREATE TRIGGER governed_review_adjudication_labels_erase BEFORE DELETE ON governed_review_adjudication_labels WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'adjudication deletion requires project erasure'); END;
CREATE TRIGGER governed_review_adjudication_finalizations_immutable BEFORE UPDATE ON governed_review_adjudication_finalizations BEGIN SELECT RAISE(ABORT,'immutable adjudication evidence'); END;
CREATE TRIGGER governed_review_adjudication_finalizations_erase BEFORE DELETE ON governed_review_adjudication_finalizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'adjudication deletion requires project erasure'); END;
CREATE TRIGGER governed_adjudication_insert BEFORE INSERT ON governed_review_adjudications BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NEW.created_command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM governed_review_batch_states WHERE batch_id=NEW.batch_id AND project_id=NEW.project_id AND state IN('adjudicating','resolved')) THEN RAISE(ABORT,'adjudication requires current command and adjudication barrier') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects s JOIN project_members pm ON pm.project_id=s.project_id AND pm.user_id=s.account_user_id WHERE s.id=NEW.adjudicator_subject_id AND s.project_id=NEW.project_id AND pm.role='owner' AND NEW.adjudicator_role_at_review='owner') OR EXISTS(SELECT 1 FROM governed_review_tasks WHERE batch_item_id=NEW.batch_item_id AND reviewer_subject_id=NEW.adjudicator_subject_id) THEN RAISE(ABORT,'adjudicator requires live owner independent of item raters') END;
 SELECT CASE WHEN NEW.expected_previous_chain_version<>coalesce((SELECT max(chain_version) FROM governed_review_adjudications WHERE batch_item_id=NEW.batch_item_id),0) OR NEW.chain_version<>NEW.expected_previous_chain_version+1 OR NEW.supersedes_adjudication_id IS NOT (SELECT id FROM governed_review_adjudications WHERE batch_item_id=NEW.batch_item_id ORDER BY chain_version DESC LIMIT 1) THEN RAISE(ABORT,'adjudication chain conflict') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_review_item_label_sets WHERE batch_item_id=NEW.batch_item_id AND label_count=NEW.considered_label_count AND NEW.considered_label_set_digest=governed_content_v1_digest('governed-review-item-label-set/v1',label_set)) THEN RAISE(ABORT,'adjudication requires exact considered label set') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_active_review_labels WHERE batch_item_id=NEW.batch_item_id AND label='cannot_determine') AND NOT(EXISTS(SELECT 1 FROM governed_active_review_labels WHERE batch_item_id=NEW.batch_item_id AND label='pass') AND EXISTS(SELECT 1 FROM governed_active_review_labels WHERE batch_item_id=NEW.batch_item_id AND label='fail')) THEN RAISE(ABORT,'adjudication requires actual disagreement or cannot_determine') END;
 SELECT CASE WHEN NEW.content_digest IS NOT governed_content_v1_digest('governed-review-adjudication/v1',json_object('adjudicatorRoleAtReview',NEW.adjudicator_role_at_review,'adjudicatorSubjectId',NEW.adjudicator_subject_id,'basis',NEW.basis,'batchId',NEW.batch_id,'batchItemId',NEW.batch_item_id,'chainVersion',NEW.chain_version,'consideredLabelCount',NEW.considered_label_count,'consideredLabelSetDigest',NEW.considered_label_set_digest,'correctionReason',NEW.correction_reason,'decision',NEW.decision,'rationale',NEW.rationale,'supersedesAdjudicationId',NEW.supersedes_adjudication_id)) THEN RAISE(ABORT,'adjudication content digest mismatch') END;
END;
CREATE TRIGGER governed_adjudication_label_insert BEFORE INSERT ON governed_review_adjudication_labels BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_review_adjudications e JOIN governed_active_review_labels a ON a.batch_item_id=e.batch_item_id AND a.project_id=e.project_id WHERE e.id=NEW.adjudication_id AND e.project_id=NEW.project_id AND a.label_id=NEW.label_id AND e.created_command_token=sqlite_command_token() AND NOT EXISTS(SELECT 1 FROM governed_review_adjudication_finalizations WHERE adjudication_id=e.id)) THEN RAISE(ABORT,'adjudication label requires exact unfinalized owning command') END;
END;
CREATE TRIGGER governed_adjudication_finalize BEFORE INSERT ON governed_review_adjudication_finalizations BEGIN
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM governed_review_adjudications e WHERE e.id=NEW.adjudication_id AND e.project_id=NEW.project_id AND e.created_command_token=NEW.command_token AND (SELECT count(*) FROM governed_review_adjudication_labels WHERE adjudication_id=e.id)=e.considered_label_count AND NOT EXISTS(SELECT 1 FROM governed_active_review_labels a WHERE a.batch_item_id=e.batch_item_id AND NOT EXISTS(SELECT 1 FROM governed_review_adjudication_labels l WHERE l.adjudication_id=e.id AND l.label_id=a.label_id))) THEN RAISE(ABORT,'adjudication requires complete exact considered label snapshot') END;
END;
CREATE TRIGGER governed_adjudication_snapshot AFTER INSERT ON governed_review_adjudications BEGIN
 INSERT INTO governed_review_adjudication_labels(project_id,adjudication_id,label_id) SELECT NEW.project_id,NEW.id,label_id FROM governed_active_review_labels WHERE batch_item_id=NEW.batch_item_id ORDER BY label_id;
 INSERT INTO governed_review_adjudication_finalizations(adjudication_id,project_id,command_token) VALUES(NEW.id,NEW.project_id,sqlite_command_token());
END;
DROP VIEW governed_review_item_resolutions;
CREATE VIEW governed_review_item_resolutions AS
 SELECT i.id batch_item_id,i.batch_id,i.project_id,
 CASE WHEN count(t.id)<>b.required_labels_per_item OR count(a.label_id)<>b.required_labels_per_item THEN 'coverage_gap'
 WHEN sum(a.label='pass')=b.required_labels_per_item OR sum(a.label='fail')=b.required_labels_per_item THEN CASE b.required_labels_per_item WHEN 1 THEN 'single_rater' ELSE 'unanimous' END
 WHEN head.id IS NULL THEN 'conflict' WHEN head.decision='unresolvable' THEN 'unresolvable' ELSE 'adjudicated' END resolution_kind,
 CASE WHEN count(t.id)<>b.required_labels_per_item OR count(a.label_id)<>b.required_labels_per_item THEN NULL
 WHEN sum(a.label='pass')=b.required_labels_per_item OR sum(a.label='fail')=b.required_labels_per_item THEN min(a.label)
 WHEN head.decision IN('pass','fail') THEN head.decision ELSE NULL END resolved_label,
 CASE WHEN count(t.id)=b.required_labels_per_item AND count(a.label_id)=b.required_labels_per_item AND NOT(sum(a.label='pass')=b.required_labels_per_item OR sum(a.label='fail')=b.required_labels_per_item) THEN head.id ELSE NULL END adjudication_id
 FROM governed_review_batch_items i JOIN governed_review_batches b ON b.id=i.batch_id LEFT JOIN governed_review_tasks t ON t.batch_item_id=i.id LEFT JOIN governed_active_review_labels a ON a.task_id=t.id LEFT JOIN governed_review_adjudications head ON head.batch_item_id=i.id AND head.chain_version=(SELECT max(chain_version) FROM governed_review_adjudications WHERE batch_item_id=i.id) GROUP BY i.id;
