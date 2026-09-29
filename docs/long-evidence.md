# Retained trace evidence

TARGET: judgment and review must use the retained evidence without silently
shortening a policy or tool result. Sensitive-key redaction and explicit
exclusions still apply. Historical evidence is never reconstructed or rewritten.

CURRENT contract for this repair:

| Input / operation | Result |
| --- | --- |
| Accepted trace, no configured string cap | Preserve every retained string in full |
| Explicit integration `maxStringChars` | Retain the configured prefix and a truncation marker; do not split a surrogate pair |
| Later default reader redaction | Scrub sensitive keys without imposing a new string cap |
| Existing clipped string | Preserve its existing bytes; show that a truncation marker is present |
| HTTP request over its existing size limit | Reject before importing/evaluating; do not enlarge limits |

The review warning detects recorded `…[TRUNCATED]` markers in input, output or
steps. It is a content warning, not verified completeness provenance: arbitrary
source text can itself contain the marker. No warning does not certify that
upstream evidence was complete. Preview-only traces retain their existing
limitations. No migration, historical payload rewrite or evaluator rerun is
part of this change.

Some older assessments may have received read-clipped text even where an
explicit ingestion cap retained longer strings. Showing that retained text now
does not revalidate those assessments or prove what their provider received.
Only a new assessment can establish execution under the repaired reader.
Manual/v1 request limits do not describe every external integration's bounds;
those providers retain their existing transport and configured import limits.

Verification covers full policy/tool-response transport through import,
provider reads and case detail in both repository modes; configured exclusions
and limits; Unicode boundaries; historical markers; UI rendering; and existing
oversized-request rejection.
