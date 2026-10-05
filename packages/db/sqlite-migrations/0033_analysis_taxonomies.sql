CREATE TABLE analysis_failure_taxonomies (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
 contract_version TEXT NOT NULL CHECK(contract_version='analysis-taxonomy/v1'),name TEXT NOT NULL,description TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,request_payload TEXT NOT NULL CHECK(json_valid(request_payload) AND json_type(request_payload)='object'),request_digest TEXT NOT NULL,content_digest TEXT NOT NULL,
 created_by_user_id TEXT NOT NULL,created_by_subject_id TEXT NOT NULL,created_at TEXT NOT NULL,created_command_token TEXT NOT NULL,initial_revision_id TEXT NOT NULL,
 UNIQUE(project_id,id),UNIQUE(project_id,idempotency_key),
 FOREIGN KEY(project_id,created_by_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 FOREIGN KEY(project_id,initial_revision_id) REFERENCES analysis_failure_taxonomy_revisions(project_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE analysis_failure_taxonomy_revisions (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,taxonomy_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 10000),
 predecessor_revision_id TEXT,predecessor_revision_digest TEXT,code_count INTEGER NOT NULL CHECK(code_count BETWEEN 1 AND 1000),reason TEXT NOT NULL,
 content_digest TEXT NOT NULL,revision_digest TEXT NOT NULL,created_by_user_id TEXT NOT NULL,created_by_subject_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,request_payload TEXT NOT NULL CHECK(json_valid(request_payload) AND json_type(request_payload)='object'),request_digest TEXT NOT NULL,created_at TEXT NOT NULL,created_command_token TEXT NOT NULL,
 UNIQUE(project_id,id),UNIQUE(taxonomy_id,sequence),UNIQUE(taxonomy_id,idempotency_key),
 CHECK((predecessor_revision_id IS NULL)=(predecessor_revision_digest IS NULL)),
 FOREIGN KEY(project_id,taxonomy_id) REFERENCES analysis_failure_taxonomies(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,predecessor_revision_id) REFERENCES analysis_failure_taxonomy_revisions(project_id,id),
 FOREIGN KEY(project_id,created_by_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 FOREIGN KEY(project_id,id) REFERENCES analysis_taxonomy_finalizations(project_id,revision_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE analysis_failure_codes (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,taxonomy_id TEXT NOT NULL,created_in_revision_id TEXT NOT NULL,
 client_token TEXT NOT NULL,content_digest TEXT NOT NULL,created_by_user_id TEXT NOT NULL,created_by_subject_id TEXT NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(project_id,id),UNIQUE(taxonomy_id,id),UNIQUE(created_in_revision_id,client_token),
 FOREIGN KEY(project_id,taxonomy_id) REFERENCES analysis_failure_taxonomies(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,created_in_revision_id) REFERENCES analysis_failure_taxonomy_revisions(project_id,id),
 FOREIGN KEY(project_id,created_by_subject_id) REFERENCES governed_reviewer_subjects(project_id,id)
) STRICT;
CREATE TABLE analysis_failure_taxonomy_revision_codes (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,taxonomy_id TEXT NOT NULL,taxonomy_revision_id TEXT NOT NULL,code_id TEXT NOT NULL,
 position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 999),label TEXT NOT NULL,definition TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('active','retired')),entry_digest TEXT NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(project_id,id),UNIQUE(taxonomy_revision_id,position),UNIQUE(taxonomy_revision_id,code_id),
 FOREIGN KEY(project_id,taxonomy_id) REFERENCES analysis_failure_taxonomies(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,taxonomy_revision_id) REFERENCES analysis_failure_taxonomy_revisions(project_id,id),
 FOREIGN KEY(project_id,code_id) REFERENCES analysis_failure_codes(project_id,id)
) STRICT;
CREATE UNIQUE INDEX analysis_taxonomy_active_labels ON analysis_failure_taxonomy_revision_codes(taxonomy_revision_id,label) WHERE status='active';
CREATE TABLE analysis_taxonomy_finalizations (
 revision_id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,command_token TEXT NOT NULL,
 UNIQUE(project_id,revision_id),FOREIGN KEY(project_id,revision_id) REFERENCES analysis_failure_taxonomy_revisions(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER analysis_failure_taxonomy_insert BEFORE INSERT ON analysis_failure_taxonomies BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NEW.created_command_token IS NOT sqlite_command_token() THEN RAISE(ABORT,'taxonomy requires command ownership') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects s JOIN project_members m ON m.project_id=s.project_id AND m.user_id=s.account_user_id WHERE s.project_id=NEW.project_id AND s.id=NEW.created_by_subject_id AND s.account_user_id=NEW.created_by_user_id AND m.role='owner') THEN RAISE(ABORT,'taxonomy requires exact owner') END;
 SELECT CASE WHEN analysis_trimmed_text_v1(NEW.name,240) IS NOT 1 OR analysis_trimmed_text_v1(NEW.description,5000) IS NOT 1 OR analysis_trimmed_text_v1(NEW.idempotency_key,240) IS NOT 1
 OR length(CAST(governed_canonical_json_v1(NEW.request_payload) AS BLOB))>8388608 OR (SELECT count(*) FROM json_each(NEW.request_payload))<>4
 OR json_type(NEW.request_payload,'$.name') IS NOT 'text' OR json_extract(NEW.request_payload,'$.name') IS NOT NEW.name
 OR json_type(NEW.request_payload,'$.description') IS NOT 'text' OR json_extract(NEW.request_payload,'$.description') IS NOT NEW.description
 OR analysis_trimmed_text_v1(json_extract(NEW.request_payload,'$.reason'),2000) IS NOT 1
 OR json_type(NEW.request_payload,'$.codes') IS NOT 'array' OR json_array_length(NEW.request_payload,'$.codes') NOT BETWEEN 1 AND 1000
 OR NEW.request_digest IS NOT analysis_sha256_v1(json_set(NEW.request_payload,'$.basis','analysis-taxonomy-request/v1','$.projectId',NEW.project_id))
 OR NEW.content_digest IS NOT analysis_sha256_v1(json_object('basis','analysis-taxonomy-content/v1','contractVersion',NEW.contract_version,'description',NEW.description,'name',NEW.name,'projectId',NEW.project_id)) THEN RAISE(ABORT,'taxonomy request or content mismatch') END;
END;
CREATE TRIGGER analysis_taxonomy_revision_insert BEFORE INSERT ON analysis_failure_taxonomy_revisions BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NEW.created_command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM analysis_failure_taxonomies WHERE id=NEW.taxonomy_id AND project_id=NEW.project_id) THEN RAISE(ABORT,'taxonomy revision requires exact taxonomy and command ownership') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects s JOIN project_members m ON m.project_id=s.project_id AND m.user_id=s.account_user_id WHERE s.project_id=NEW.project_id AND s.id=NEW.created_by_subject_id AND s.account_user_id=NEW.created_by_user_id AND m.role='owner') THEN RAISE(ABORT,'taxonomy revision requires exact owner') END;
 SELECT CASE WHEN NEW.sequence IS NOT coalesce((SELECT max(sequence) FROM analysis_failure_taxonomy_revisions WHERE taxonomy_id=NEW.taxonomy_id),0)+1
 OR NEW.predecessor_revision_id IS NOT (SELECT id FROM analysis_failure_taxonomy_revisions WHERE taxonomy_id=NEW.taxonomy_id ORDER BY sequence DESC LIMIT 1)
 OR NEW.predecessor_revision_digest IS NOT (SELECT revision_digest FROM analysis_failure_taxonomy_revisions WHERE taxonomy_id=NEW.taxonomy_id ORDER BY sequence DESC LIMIT 1)
 OR (NEW.predecessor_revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM analysis_taxonomy_finalizations WHERE revision_id=NEW.predecessor_revision_id)) THEN RAISE(ABORT,'taxonomy revision compare-and-swap head mismatch') END;
 SELECT CASE WHEN analysis_trimmed_text_v1(NEW.reason,2000) IS NOT 1 OR analysis_trimmed_text_v1(NEW.idempotency_key,240) IS NOT 1 OR length(CAST(governed_canonical_json_v1(NEW.request_payload) AS BLOB))>8388608
 OR json_extract(NEW.request_payload,'$.reason') IS NOT NEW.reason OR json_type(NEW.request_payload,'$.codes') IS NOT 'array' OR json_array_length(NEW.request_payload,'$.codes')<>NEW.code_count THEN RAISE(ABORT,'taxonomy revision request shape mismatch') END;
 SELECT CASE WHEN NEW.sequence=1 AND NOT EXISTS(SELECT 1 FROM analysis_failure_taxonomies t WHERE t.id=NEW.taxonomy_id AND t.initial_revision_id=NEW.id AND t.created_command_token=NEW.created_command_token AND t.created_at=NEW.created_at AND t.created_by_user_id=NEW.created_by_user_id AND t.created_by_subject_id=NEW.created_by_subject_id AND governed_canonical_json_v1(t.request_payload)=governed_canonical_json_v1(NEW.request_payload) AND t.request_digest=NEW.request_digest) THEN RAISE(ABORT,'taxonomy initial revision must bind exact create request') END;
 SELECT CASE WHEN NEW.sequence>1 AND ((SELECT count(*) FROM json_each(NEW.request_payload))<>5
 OR json_extract(NEW.request_payload,'$.expectedPredecessorRevisionId') IS NOT NEW.predecessor_revision_id OR json_extract(NEW.request_payload,'$.expectedPredecessorRevisionDigest') IS NOT NEW.predecessor_revision_digest
 OR json_type(NEW.request_payload,'$.expectedPredecessorSequence') IS NOT 'integer' OR json_extract(NEW.request_payload,'$.expectedPredecessorSequence') IS NOT NEW.sequence-1
 OR NEW.request_digest IS NOT analysis_sha256_v1(json_set(NEW.request_payload,'$.basis','analysis-taxonomy-request/v1','$.taxonomyId',NEW.taxonomy_id))) THEN RAISE(ABORT,'taxonomy successor request mismatch') END;
 SELECT CASE WHEN NEW.revision_digest IS NOT analysis_sha256_v1(json_object('basis','analysis-taxonomy-revision/v1','contentDigest',NEW.content_digest,'predecessorRevisionDigest',NEW.predecessor_revision_digest,'predecessorRevisionId',NEW.predecessor_revision_id,'reason',NEW.reason,'sequence',NEW.sequence,'taxonomyId',NEW.taxonomy_id)) THEN RAISE(ABORT,'taxonomy revision digest mismatch') END;
END;
CREATE TRIGGER analysis_failure_code_insert BEFORE INSERT ON analysis_failure_codes BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects s JOIN project_members m ON m.project_id=s.project_id AND m.user_id=s.account_user_id WHERE s.project_id=NEW.project_id AND s.id=NEW.created_by_subject_id AND s.account_user_id=NEW.created_by_user_id AND m.role='owner') THEN RAISE(ABORT,'failure code requires exact current owner') END;
 SELECT CASE WHEN analysis_trimmed_text_v1(NEW.client_token,120) IS NOT 1 OR NOT EXISTS(SELECT 1 FROM analysis_failure_taxonomy_revisions r WHERE r.id=NEW.created_in_revision_id AND r.project_id=NEW.project_id AND r.taxonomy_id=NEW.taxonomy_id AND r.created_by_user_id=NEW.created_by_user_id AND r.created_by_subject_id=NEW.created_by_subject_id AND r.created_at=NEW.created_at AND r.created_command_token=sqlite_command_token())
 OR EXISTS(SELECT 1 FROM analysis_taxonomy_finalizations WHERE revision_id=NEW.created_in_revision_id) THEN RAISE(ABORT,'failure code requires creating revision command') END;
 SELECT CASE WHEN NEW.content_digest IS NOT analysis_sha256_v1(json_object('basis','analysis-taxonomy-code/v1','codeId',NEW.id,'createdInRevisionId',NEW.created_in_revision_id,'projectId',NEW.project_id,'taxonomyId',NEW.taxonomy_id)) THEN RAISE(ABORT,'failure code digest mismatch') END;
END;
CREATE TRIGGER analysis_taxonomy_code_entry_insert BEFORE INSERT ON analysis_failure_taxonomy_revision_codes BEGIN
 SELECT CASE WHEN analysis_trimmed_text_v1(NEW.label,500) IS NOT 1 OR analysis_trimmed_text_v1(NEW.definition,5000) IS NOT 1
 OR NOT EXISTS(SELECT 1 FROM analysis_failure_taxonomy_revisions r JOIN analysis_failure_codes c ON c.project_id=r.project_id AND c.taxonomy_id=r.taxonomy_id
 WHERE r.id=NEW.taxonomy_revision_id AND r.project_id=NEW.project_id AND r.taxonomy_id=NEW.taxonomy_id AND c.id=NEW.code_id AND r.created_at=NEW.created_at AND r.created_command_token=sqlite_command_token() AND NEW.position<r.code_count)
 OR EXISTS(SELECT 1 FROM analysis_taxonomy_finalizations WHERE revision_id=NEW.taxonomy_revision_id) THEN RAISE(ABORT,'taxonomy entry requires exact creating revision') END;
 SELECT CASE WHEN NEW.entry_digest IS NOT analysis_sha256_v1(json_object('basis','analysis-taxonomy-revision-code/v1','codeId',NEW.code_id,'definition',NEW.definition,'label',NEW.label,'position',NEW.position,'status',NEW.status,'taxonomyId',NEW.taxonomy_id,'taxonomyRevisionId',NEW.taxonomy_revision_id)) THEN RAISE(ABORT,'taxonomy entry digest mismatch') END;
END;
CREATE TRIGGER analysis_taxonomy_finalize BEFORE INSERT ON analysis_taxonomy_finalizations BEGIN
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM analysis_failure_taxonomy_revisions r WHERE r.id=NEW.revision_id AND r.project_id=NEW.project_id AND r.created_command_token=NEW.command_token
 AND r.code_count=(SELECT count(*) FROM analysis_failure_taxonomy_revision_codes WHERE taxonomy_revision_id=r.id)
 AND r.content_digest=analysis_sha256_v1(json_object('basis','analysis-taxonomy-content/v1','entryDigests',json((SELECT json_group_array(entry_digest ORDER BY position) FROM analysis_failure_taxonomy_revision_codes WHERE taxonomy_revision_id=r.id))))) THEN RAISE(ABORT,'taxonomy revision incomplete or content mismatch') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM analysis_failure_codes c WHERE c.created_in_revision_id=NEW.revision_id AND NOT EXISTS(SELECT 1 FROM analysis_failure_taxonomy_revision_codes e WHERE e.taxonomy_revision_id=NEW.revision_id AND e.code_id=c.id)) THEN RAISE(ABORT,'taxonomy revision omits newly created code') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM analysis_failure_taxonomy_revisions r,json_each(r.request_payload,'$.codes') command
 LEFT JOIN analysis_failure_taxonomy_revision_codes e ON e.taxonomy_revision_id=r.id AND e.position=CAST(command.key AS INTEGER)
 LEFT JOIN analysis_failure_codes c ON c.id=e.code_id
 WHERE r.id=NEW.revision_id AND (e.id IS NULL OR c.id IS NULL OR command.type<>'object' OR
 CASE json_extract(command.value,'$.kind')
 WHEN 'new' THEN (SELECT count(*) FROM json_each(command.value))<>4 OR c.created_in_revision_id<>r.id
 OR json_type(command.value,'$.clientToken') IS NOT 'text' OR c.client_token IS NOT json_extract(command.value,'$.clientToken')
 OR json_type(command.value,'$.label') IS NOT 'text' OR e.label IS NOT json_extract(command.value,'$.label')
 OR json_type(command.value,'$.definition') IS NOT 'text' OR e.definition IS NOT json_extract(command.value,'$.definition') OR e.status<>'active'
 WHEN 'existing' THEN (SELECT count(*) FROM json_each(command.value))<>5 OR c.created_in_revision_id=r.id
 OR json_type(command.value,'$.codeId') IS NOT 'text' OR e.code_id IS NOT json_extract(command.value,'$.codeId')
 OR json_type(command.value,'$.label') IS NOT 'text' OR e.label IS NOT json_extract(command.value,'$.label')
 OR json_type(command.value,'$.definition') IS NOT 'text' OR e.definition IS NOT json_extract(command.value,'$.definition')
 OR json_type(command.value,'$.status') IS NOT 'text' OR e.status IS NOT json_extract(command.value,'$.status')
 ELSE 1 END)) THEN RAISE(ABORT,'taxonomy revision codes differ from exact request') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM analysis_failure_taxonomy_revisions r JOIN analysis_failure_taxonomy_revision_codes e ON e.taxonomy_revision_id=r.id JOIN analysis_failure_codes c ON c.id=e.code_id
 WHERE r.id=NEW.revision_id AND r.sequence=1 AND (e.status<>'active' OR c.created_in_revision_id<>r.id)) THEN RAISE(ABORT,'initial taxonomy codes must be new and active') END;
 SELECT CASE WHEN EXISTS(SELECT prior.code_id FROM analysis_failure_taxonomy_revision_codes prior JOIN analysis_failure_taxonomy_revisions r ON r.predecessor_revision_id=prior.taxonomy_revision_id WHERE r.id=NEW.revision_id
 EXCEPT SELECT code_id FROM analysis_failure_taxonomy_revision_codes WHERE taxonomy_revision_id=NEW.revision_id)
 OR EXISTS(SELECT 1 FROM analysis_failure_taxonomy_revision_codes e JOIN analysis_failure_taxonomy_revisions r ON r.id=e.taxonomy_revision_id JOIN analysis_failure_codes c ON c.id=e.code_id
 WHERE r.id=NEW.revision_id AND r.sequence>1 AND c.created_in_revision_id<>r.id AND NOT EXISTS(SELECT 1 FROM analysis_failure_taxonomy_revision_codes prior WHERE prior.taxonomy_revision_id=r.predecessor_revision_id AND prior.code_id=e.code_id))
 OR EXISTS(SELECT 1 FROM analysis_failure_taxonomy_revision_codes e JOIN analysis_failure_taxonomy_revisions r ON r.id=e.taxonomy_revision_id JOIN analysis_failure_taxonomy_revision_codes prior ON prior.taxonomy_revision_id=r.predecessor_revision_id AND prior.code_id=e.code_id
 WHERE r.id=NEW.revision_id AND ((e.status='retired' AND (e.label<>prior.label OR e.definition<>prior.definition)) OR (prior.status='retired' AND e.status<>'retired')))
 THEN RAISE(ABORT,'taxonomy successor must retain codes and freeze retirement') END;
END;
CREATE TRIGGER analysis_failure_taxonomies_immutable BEFORE UPDATE ON analysis_failure_taxonomies BEGIN SELECT RAISE(ABORT,'immutable taxonomy evidence'); END;
CREATE TRIGGER analysis_failure_taxonomies_erase BEFORE DELETE ON analysis_failure_taxonomies WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'taxonomy deletion requires project erasure'); END;
CREATE TRIGGER analysis_failure_taxonomy_revisions_immutable BEFORE UPDATE ON analysis_failure_taxonomy_revisions BEGIN SELECT RAISE(ABORT,'immutable taxonomy evidence'); END;
CREATE TRIGGER analysis_failure_taxonomy_revisions_erase BEFORE DELETE ON analysis_failure_taxonomy_revisions WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'taxonomy deletion requires project erasure'); END;
CREATE TRIGGER analysis_failure_codes_immutable BEFORE UPDATE ON analysis_failure_codes BEGIN SELECT RAISE(ABORT,'immutable taxonomy evidence'); END;
CREATE TRIGGER analysis_failure_codes_erase BEFORE DELETE ON analysis_failure_codes WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'taxonomy deletion requires project erasure'); END;
CREATE TRIGGER analysis_failure_taxonomy_revision_codes_immutable BEFORE UPDATE ON analysis_failure_taxonomy_revision_codes BEGIN SELECT RAISE(ABORT,'immutable taxonomy evidence'); END;
CREATE TRIGGER analysis_failure_taxonomy_revision_codes_erase BEFORE DELETE ON analysis_failure_taxonomy_revision_codes WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'taxonomy deletion requires project erasure'); END;
CREATE TRIGGER analysis_taxonomy_finalizations_immutable BEFORE UPDATE ON analysis_taxonomy_finalizations BEGIN SELECT RAISE(ABORT,'immutable taxonomy evidence'); END;
CREATE TRIGGER analysis_taxonomy_finalizations_erase BEFORE DELETE ON analysis_taxonomy_finalizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'taxonomy deletion requires project erasure'); END;
