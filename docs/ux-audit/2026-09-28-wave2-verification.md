# UX wave 2 verification

Status: **CURRENT staging verification**, 2026-09-28. The bounded
links/location, phone, and loading/recovery changes are deployed at
`06c6f389cb5c149798d35195c60a7f55b3cbc134`. Draft PRs remain unmerged:
[#170](https://github.com/luka-zivkovic/rubrist/pull/170) (phones),
[#171](https://github.com/luka-zivkovic/rubrist/pull/171) (recovery), and
[#172](https://github.com/luka-zivkovic/rubrist/pull/172) (links/location).
This record does not accept ADR-0015 or complete later slices 6–9.

## Review and automated checks

Independent reviews cleared navigation `54edc9f`, phone/layout plus CURRENT
progress `43861ac`, and recovery `3be41a8` (scope clarified in `85b4b85`).
The combined review of `40cbc13` found an unpinned legacy review URL could
still wait indefinitely after a dashboard error. The follow-up `d06274f`
(integrated as `06c6f38`) fixes that path and was independently re-reviewed.
Fully pinned selections continue loading without the dashboard.

The final integration passed 1,819 unit/component/repository tests and 29
tooling checks, TypeScript checking, the web production build, repository
boundaries, shared-contract guards, and diff whitespace checks. The web
subset has 459 tests. A first concurrent run hit one repository-guard timeout
and outdated integration test assumptions; the corrected complete suite
passed with four workers and no concurrent build. The existing Vite large
chunk advisory remains.

No API, worker, schema, or shared contract changed in this wave. Database-only
tests were not rerun; wave 1 had passed 153 disposable PostgreSQL 17 checks.
This wave instead verified the live existing data and read paths below.

## Browser and deployment checks

Native Brave UI checks on the staged build covered:

- At 390 CSS pixels: stacked waiting-case records, visible result/note/Review
  controls, working full-note expansion, evaluator history, recorded comparison
  fields, and the saved review-session heading/navigation.
- The full 50-case Review all selection opened via the browser's New Tab
  action and survived reload with its criterion and historical definition pin.
- Saved-session titles changed from Case 1 of 8 to Case 2 of 8; the completed
  count remained zero. Breadcrumb parents and desktop navigation rendered.
- An offline version-history refresh rendered a recoverable failure. Restoring
  normal connectivity and clicking Retry restored the recorded history.
  Offline simulation was disabled, temporary tabs were closed, and the original
  tab was left on the eight-case queue with developer tools closed.

Coolify's deployment finished; web, API, and PostgreSQL containers were healthy.
The build contexts are pinned to the exact commit above. A private pre-deploy
service snapshot and database backup remain available for recovery.

## Benchmark preservation and limits

Before/after sorted-row fingerprints match for all 250 cases, 500 verdicts,
500 judge runs, 250 dataset items, and zero golden entries. The saved queue
still has eight pending cases and is byte-for-byte unchanged in its API view.
All eight expose complete claim/evidence and their recorded Jev version/model;
a requested evaluator version with no result still returns 404 instead of
falling back. The queue reports 171 waiting cases and 50 loaded cases.
No provider calls, human labels, evaluator saves, or reference-label edits were
made for verification.

This is bounded browser coverage, not a full assistive-technology audit.
One-time-key placement and override/busy states have component coverage, not
new credentials or overridden versions created in staging. Detailed comparison
and resolved-history tables retain their existing scrollable layout. Elapsed
wait and dashboard 401/server-failure branches have rendered automated coverage;
the live failure injection covered a transport error in version history.
Vocabulary/display consolidation, broader triage/Overview/evaluator redesign,
and the remaining audit rounds stay open.
