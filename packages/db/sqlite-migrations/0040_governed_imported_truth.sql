CREATE TABLE governed_imported_truth (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 criterion_version_id TEXT NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,
 source_artifact_bytes BLOB NOT NULL CHECK(length(source_artifact_bytes)<=10485760),
 source_artifact_digest TEXT NOT NULL,
 transport_provenance TEXT CHECK(transport_provenance IS NULL OR json_valid(transport_provenance)),
 verification_evidence TEXT CHECK(verification_evidence IS NULL OR json_valid(verification_evidence)),
 instructions_provenance TEXT CHECK(instructions_provenance IS NULL OR json_valid(instructions_provenance)),
 rater_provenance TEXT CHECK(rater_provenance IS NULL OR json_valid(rater_provenance)),
 adjudication_provenance TEXT CHECK(adjudication_provenance IS NULL OR json_valid(adjudication_provenance)),
 blind_attestation TEXT CHECK(blind_attestation IS NULL OR json_valid(blind_attestation)),
 verification_method TEXT NOT NULL CHECK(verification_method IN('none','self_attested','verified_signature','independently_verified_transport')),
 identity_basis TEXT NOT NULL CHECK(identity_basis='input-identity/v1'),input_digest TEXT NOT NULL,
 payload_snapshot TEXT NOT NULL CHECK(json_valid(payload_snapshot)),label TEXT NOT NULL CHECK(label IN('pass','fail','cannot_determine')),
 rationale TEXT NOT NULL,failure_codes TEXT NOT NULL CHECK(json_valid(failure_codes) AND json_type(failure_codes)='array'),
 evidence_class TEXT NOT NULL CHECK(evidence_class IN('unverified','imported_self_attested')),
 provenance_digest TEXT NOT NULL,content_digest TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,imported_at TEXT NOT NULL,
 UNIQUE(project_id,id),UNIQUE(project_id,idempotency_key),
 FOREIGN KEY(project_id,criterion_version_id) REFERENCES criterion_versions(project_id,id),
 CHECK(length(issuer)>0 AND length(CAST(issuer AS BLOB))<=4096),
 CHECK(length(subject)>0 AND length(CAST(subject AS BLOB))<=4096),
 CHECK(length(rationale)>0 AND length(CAST(rationale AS BLOB))<=32768),
 CHECK(length(idempotency_key)>0 AND length(CAST(idempotency_key AS BLOB))<=1024),
 CHECK(length(source_artifact_digest)=71 AND substr(source_artifact_digest,1,7)='sha256:' AND substr(source_artifact_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(input_digest)=71 AND substr(input_digest,1,7)='sha256:' AND substr(input_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(provenance_digest)=71 AND substr(provenance_digest,1,7)='sha256:' AND substr(provenance_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TRIGGER governed_imported_truth_insert BEFORE INSERT ON governed_imported_truth BEGIN
 SELECT CASE WHEN NEW.imported_at IS NOT sqlite_command_time() THEN RAISE(ABORT,'imported truth requires command time') END;
 SELECT CASE WHEN NEW.source_artifact_digest IS NOT governed_bytes_v1_digest(NEW.source_artifact_bytes) THEN RAISE(ABORT,'imported source artifact digest mismatch') END;
 SELECT CASE WHEN json_array_length(NEW.failure_codes)>100 OR EXISTS(SELECT 1 FROM json_each(NEW.failure_codes) WHERE type<>'text' OR length(value)=0 OR length(CAST(value AS BLOB))>1024) OR (SELECT coalesce(sum(length(CAST(value AS BLOB))),0) FROM json_each(NEW.failure_codes))>65536 THEN RAISE(ABORT,'invalid imported failure codes') END;
 SELECT CASE WHEN governed_jsonb_octets_v1(NEW.transport_provenance)>262144 OR governed_jsonb_octets_v1(NEW.verification_evidence)>262144 OR governed_jsonb_octets_v1(NEW.instructions_provenance)>262144 OR governed_jsonb_octets_v1(NEW.rater_provenance)>262144 OR governed_jsonb_octets_v1(NEW.adjudication_provenance)>262144 OR governed_jsonb_octets_v1(NEW.blind_attestation)>262144 OR governed_jsonb_octets_v1(NEW.payload_snapshot)>2097152 THEN RAISE(ABORT,'imported provenance or payload exceeds byte bounds') END;
 SELECT CASE WHEN NEW.evidence_class='imported_self_attested' AND (NEW.verification_method<>'self_attested' OR NEW.transport_provenance IS NULL OR json_type(NEW.transport_provenance)='null' OR NEW.instructions_provenance IS NULL OR json_type(NEW.instructions_provenance)='null' OR NEW.rater_provenance IS NULL OR json_type(NEW.rater_provenance)='null' OR NEW.adjudication_provenance IS NULL OR json_type(NEW.adjudication_provenance)='null' OR NEW.blind_attestation IS NULL OR json_type(NEW.blind_attestation)='null') THEN RAISE(ABORT,'self-attested truth requires complete claims') END;
 SELECT CASE WHEN NEW.provenance_digest IS NOT governed_content_v1_digest('governed-imported-truth-provenance/v1',json_object('adjudication',json(NEW.adjudication_provenance),'blindAttestation',json(NEW.blind_attestation),'instructions',json(NEW.instructions_provenance),'issuer',NEW.issuer,'raters',json(NEW.rater_provenance),'sourceArtifactDigest',NEW.source_artifact_digest,'subject',NEW.subject,'transport',json(NEW.transport_provenance),'verificationEvidence',json(NEW.verification_evidence),'verificationMethod',NEW.verification_method)) THEN RAISE(ABORT,'imported truth provenance digest mismatch') END;
 SELECT CASE WHEN NEW.content_digest IS NOT governed_content_v1_digest('governed-imported-truth/v1',json_object('criterionVersionId',NEW.criterion_version_id,'evidenceClass',NEW.evidence_class,'failureCodes',json(NEW.failure_codes),'identityBasis',NEW.identity_basis,'inputDigest',NEW.input_digest,'label',NEW.label,'payloadSnapshot',json(NEW.payload_snapshot),'provenanceDigest',NEW.provenance_digest,'rationale',NEW.rationale)) THEN RAISE(ABORT,'imported truth content digest mismatch') END;
END;
CREATE TRIGGER governed_imported_truth_immutable BEFORE UPDATE ON governed_imported_truth BEGIN SELECT RAISE(ABORT,'immutable imported truth'); END;
CREATE TRIGGER governed_imported_truth_erase BEFORE DELETE ON governed_imported_truth WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'imported truth deletion requires project erasure'); END;
