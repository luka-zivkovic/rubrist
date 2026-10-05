-- Exact input ownership survives ordinary case retention and prevents a later
-- sealed intake from reusing previously visible evidence (and vice versa).
CREATE TABLE governed_input_identity_claims (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 input_digest TEXT NOT NULL CHECK(length(input_digest)=71 AND substr(input_digest,1,7)='sha256:' AND substr(input_digest,8) NOT GLOB '*[^0-9a-f]*'),
 usage_class TEXT NOT NULL CHECK(usage_class IN ('nonsealed','sealed')),
 created_at TEXT NOT NULL,
 PRIMARY KEY(project_id,input_digest)
) STRICT;
CREATE TEMP TABLE input_claim_seed_check(ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO input_claim_seed_check SELECT NOT EXISTS(
 SELECT project_id,input_digest FROM (
  SELECT project_id,input_digest,'nonsealed' usage_class FROM case_input_identity_records
  UNION ALL
  SELECT i.project_id,i.input_digest,CASE WHEN r.role='sealed_validation' THEN 'sealed' ELSE 'nonsealed' END
   FROM dataset_revision_items i JOIN dataset_revisions r ON r.project_id=i.project_id AND r.id=i.revision_id
 ) GROUP BY project_id,input_digest HAVING count(DISTINCT usage_class)>1
);
DROP TABLE input_claim_seed_check;
INSERT INTO governed_input_identity_claims
 SELECT project_id,input_digest,usage_class,min(created_at) FROM (
  SELECT project_id,input_digest,'nonsealed' usage_class,created_at FROM case_input_identity_records
  UNION ALL
  SELECT i.project_id,i.input_digest,CASE WHEN r.role='sealed_validation' THEN 'sealed' ELSE 'nonsealed' END,i.created_at
   FROM dataset_revision_items i JOIN dataset_revisions r ON r.project_id=i.project_id AND r.id=i.revision_id
 ) GROUP BY project_id,input_digest,usage_class;
CREATE TRIGGER governed_input_claim_insert BEFORE INSERT ON governed_input_identity_claims BEGIN
 SELECT CASE WHEN NEW.created_at<>sqlite_command_time() THEN RAISE(ABORT,'input claim requires command time') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM governed_input_identity_claims WHERE project_id=NEW.project_id AND input_digest=NEW.input_digest AND usage_class<>NEW.usage_class)
  THEN RAISE(ABORT,'input identity already claimed by opposite evidence class') END;
END;
CREATE TRIGGER governed_input_claim_update BEFORE UPDATE ON governed_input_identity_claims WHEN
 NEW.project_id<>OLD.project_id OR NEW.input_digest<>OLD.input_digest OR NEW.usage_class<>OLD.usage_class OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable governed input identity claim'); END;
CREATE TRIGGER governed_input_claim_delete BEFORE DELETE ON governed_input_identity_claims WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'input identity claims survive until project erasure'); END;
CREATE TRIGGER case_identity_claim_nonsealed BEFORE INSERT ON case_input_identity_records BEGIN
 INSERT INTO governed_input_identity_claims(project_id,input_digest,usage_class,created_at)
 VALUES(NEW.project_id,NEW.input_digest,'nonsealed',sqlite_command_time()) ON CONFLICT(project_id,input_digest) DO NOTHING;
END;
CREATE TRIGGER dataset_revision_identity_claim BEFORE INSERT ON dataset_revision_items BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM dataset_revisions WHERE project_id=NEW.project_id AND id=NEW.revision_id)
  THEN RAISE(ABORT,'input identity requires its revision project') END;
 INSERT INTO governed_input_identity_claims(project_id,input_digest,usage_class,created_at)
 SELECT NEW.project_id,NEW.input_digest,CASE WHEN role='sealed_validation' THEN 'sealed' ELSE 'nonsealed' END,sqlite_command_time()
 FROM dataset_revisions WHERE project_id=NEW.project_id AND id=NEW.revision_id
 ON CONFLICT(project_id,input_digest) DO NOTHING;
END;
