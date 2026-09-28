-- Preserve the hosted evidence under ADR-0011's preservation exception.
-- Older values may be implicit defaults; do not reinterpret them as declarations.
ALTER TABLE skill_versions
  ADD COLUMN rubric_provenance_declared boolean NOT NULL DEFAULT false,
  ALTER COLUMN rubric_provenance SET DEFAULT 'unspecified',
  DROP CONSTRAINT skill_versions_rubric_provenance_check,
  ADD CONSTRAINT skill_versions_rubric_provenance_check
    CHECK (rubric_provenance IN ('human-authored', 'agent-drafted', 'unspecified')),
  ADD CONSTRAINT skill_versions_authorship_declaration_check
    CHECK (NOT rubric_provenance_declared OR rubric_provenance <> 'unspecified');

CREATE FUNCTION preserve_skill_version_authorship() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rubric_provenance IS DISTINCT FROM OLD.rubric_provenance
     OR NEW.rubric_provenance_declared IS DISTINCT FROM OLD.rubric_provenance_declared THEN
    RAISE EXCEPTION 'skill-version authorship is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER skill_versions_preserve_authorship
BEFORE UPDATE ON skill_versions
FOR EACH ROW EXECUTE FUNCTION preserve_skill_version_authorship();
