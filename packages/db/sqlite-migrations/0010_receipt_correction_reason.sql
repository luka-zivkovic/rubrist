-- Match the command's ECMAScript whitespace policy without rewriting applied history.
-- Trigger-only validation preserves plain-connection integrity checks and backups.
CREATE TRIGGER receipt_correction_reason_validate BEFORE INSERT ON assessment_receipt_artifacts
WHEN NEW.source_kind = 'correction'
BEGIN
  SELECT CASE WHEN sqlite_correction_reason_valid(NEW.correction_reason) IS NOT 1
    THEN RAISE(ABORT, 'receipt correction reason required') END;
END;
