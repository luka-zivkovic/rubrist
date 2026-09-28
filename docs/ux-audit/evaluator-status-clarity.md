# Evaluator selection and evidence display

CURRENT implementation slice, 2026-09-28. This changes presentation, not selection,
calibration, version eligibility, or stored evidence. Broad ADR-0015 terminology
changes remain deferred.

TARGET: default selection must not imply evaluator validity. A recorded regression
check covers its pinned known-failure cases, not general accuracy or calibration.

| Read / evidence | Display | Must not imply |
| --- | --- | --- |
| Current selector returns this exact version | Current default | Validated or best version |
| Current selector returns another version | Saved version; name current default | This version is current because its status is approved/production |
| Latest lineage exists, selector explicitly reports no eligible evaluator | No current default | Missing version history |
| Selector fails or is still loading | Default unavailable / loading, independently of history | No default or a guessed default |
| Recorded passed run with zero compared cases | No reference cases compared | Passed, clean, or validated |
| Recorded nonempty passed run | Reference check passed; count and scope | Broad accuracy or sealed calibration |
| Recorded error / blocked / override | Preserve that outcome and count | Empty means successful |
| Missing / unreadable / loading run | Not recorded / unavailable / loading | Zero comparisons or pass |

CURRENT legacy saving: a successful check makes the saved version eligible for
automatic default selection, including when no references exist. The latest
eligible version is selected; saving is not evidence that it is better. Backfill
scope does not prevent default selection. Governed lineages retain their separate
candidate/active lifecycle and cannot use the legacy editing path.

Fixtures cover zero and nonempty checks, failed and missing reads, exact current
versus historical version, candidate history without an eligible default, and
save feedback with no comparison. No migration or receipt/schema change is needed.
