# Links, page location, and headings

Status: **CURRENT implementation change**, bounded Slice 3 addressing S1–S3
and T9–T10. Existing vocabulary/display choices remain; this does not accept
proposed ADR-0015 or claim vocabulary consolidation is complete.

Route metadata distinguishes versions, editing, comparisons, analysis, governed
human-truth creation/resolution, cases, test creation/evidence, and saved/ad-hoc
review. Trailing slashes do not create fictitious child pages. Breadcrumb parent
links retain criterion scope and relevant case pins. The active sidebar follows
the relevant parent; when saved sessions are hidden in Guided, their existing
exception parent stays active. Navigation visibility itself is unchanged.

Page titles are semantic h1 headings; cards use h2, and supplied Markdown starts
at h3 rather than competing with the page heading. The live page heading drives
the document title and final breadcrumb. Review players expose Case N of M and
the queue name, with the case heading below at h2. Technical case IDs follow the
existing dev-only display convention. This slice does not introduce a persisted
review cursor or change blind-review evidence.

Triage navigation uses actual links for Review all, row Review, rubric/compare
links, case Back, test-entry actions, and ad-hoc completion navigation. A Review
all URL carries the exact filtered case selection, criterion identity, and each
available recorded definition pin. Common pins and short index overrides keep a
50-case/50-distinct-pin UUID example below 6 KB; copying/reloading the URL needs
no router state. Old single-case URLs and router-state links remain readable.
Actual mutation/retry/expand/reopen/pause controls remain buttons.

Test-entry links carry the displayed evaluator version; the builder honors the
explicit pin and returns to the same case/context. Its initial saved-draft load
still gates the entry action, and a failed draft lookup offers Retry.

Verification: focused tests cover specificity/trailing slashes, parent links,
criterion and exact pins, 50-case URL length/roundtrip, absent pins, live heading
updates, queue position, cleanup, semantic Markdown, actual row anchors, case
Back/test-entry URLs, and historical human-review attribution. Typecheck passes.
Full integration and browser verification belong to the integrating batch.
No provider calls, hosted changes, or human labels were created.
