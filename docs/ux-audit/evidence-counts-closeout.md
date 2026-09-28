# Evidence counts closeout

Status: **CURRENT implementation**, 2026-09-28. This patch changes no product
vocabulary decisions, evaluator execution, or human-truth authority.

## Full backlog versus loaded cases

`GET /api/dashboard` now adds `exceptionsTotal`: the full count of unresolved
exceptions for the selected criterion definition revision. The existing
`exceptions` payload remains bounded to 50 cases, newest pinned failure first.
The SQL counts the same pinned population before applying its limit, then
loads raw response and trace JSON only for those 50 rows. The total and rows
come from one statement, so concurrent arrivals cannot split their snapshots.

An exception remains the first unresolved non-pass result after the last
human/adjudicated ruling. A later evaluator pass does not resolve it. Golden
cases, release evidence, and gate scaffolding retain their exclusions. A
ruling or golden entry for another criterion cannot resolve this criterion.

Overview, header, provisional overview, and queue use the total. Overview
separates its five-row preview and 50-case review action from that total.
Category counts and local filters explicitly describe the loaded cases. Older
responses without the optional added field display an unavailable total in
the overview/header/queue instead of treating the payload length as a total.

The queue still loads at most 50 cases. Reviewing cases and returning to the
queue makes room for older waiting cases; a PostgreSQL regression test verifies
that replenishment. Arbitrary paging and server-side category filtering are
not implemented by this patch. A steady influx can still delay older cases;
that is a remaining triage workflow limitation, not a completeness claim.

## Comparison improvements

A comparison table row displays an unknown improvement count when the prior
save did not measure a usable baseline, matching the summary above the table.
A recorded zero alone no longer claims zero improvements in that situation.
Regression counts retain their independent measurement semantics.

## Verification

- Rendered comparison reproduces an unmeasured baseline and asserts the row
  and summary both show unknown.
- Rendered overview distinguishes 137 waiting cases, 50 loaded review cases,
  and its five-case preview; an absent total stays unknown.
- PostgreSQL 17 fixture verifies 55 eligible cases versus 50 loaded; criterion
  isolation; unresolved historical failure despite a later pass; golden,
  human-resolution, and release-evidence exclusions; replenishment; and zero.
- Focused repository, demo, route, and web tests and TypeScript checking pass.

The WiCE benchmark inputs, outputs, labels, and provider settings are untouched.
These regression fixtures make no provider calls and create no human judgments
in the hosted application.
