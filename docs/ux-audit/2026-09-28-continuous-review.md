# Continuous review follow-up

CURRENT: bounded implementation of triage continuity after the founder completed the eight-case development queue. ADR-0015 remains Proposed; vocabulary, display modes, and evidence classes are unchanged.

Queue titles, row clicks, and Review actions enter the same ordered filtered selection at the chosen case. The URL retains case IDs, exact criterion-definition pins, filters, and the selected item. Legacy state-only selections become explicit URLs before dashboard refresh can change them. Persisted queue position uses item identity, including separate criteria on one case.

A successful save stays visible after advancing, with Change ruling returning to that case and opening an append-only correction. Navigation cannot turn browser-modified keyboard shortcuts into review writes. Skip for now records no ruling; the summary distinguishes session activity from saved queue progress and can resume unfinished work. Completed saved queues can reopen an explicitly linked item. Queue/selection changes reset session UI and reject stale callbacks; failed progress refresh shows Retry without hiding the successful save.

This does not complete all of audit slice 6: test creation placement, reviewer-disagreement presentation, and the remaining gated wording remain separate. Ad-hoc activity counts are session-local; durable rulings remain on cases. A reload restores the selected position, not an invented persisted session tally.

Validation: focused navigation/component tests, full suite, typecheck and production build, followed by independent exact-diff review and read-only staging checks. Final results are recorded in the PR.
