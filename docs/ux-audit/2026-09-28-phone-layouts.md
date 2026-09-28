# Phone layout follow-up — CURRENT

Scope: the presentation portion of round-three O10, T5, and C4, based on the
completed first-wave UX changes. This records CURRENT implementation, not new
product authority. Existing vocabulary, display modes, evaluator semantics,
historical provenance, and human-write behavior are unchanged.

## Changes

- Overview setup and journey actions can wrap. The journey uses one column on
  phones; setup actions follow their description instead of squeezing it. The
  provisional banner wraps its action group, including buttons and links.
- Both day-zero Overview variants place the one-time project key before the
  heading and setup steps, matching the established later Overview states. Key
  and first-result cards use one column below the small breakpoint.
- Waiting cases, evaluator history, and recorded comparison runs have an opt-in
  stacked table presentation below 768px. Every result/action column remains in
  the same DOM record with a visible label; column headers and explicit table
  roles remain available. The case record has one note toggle and one Review
  action, with the existing handlers and historical context. Desktop tables are
  unchanged. Existing exception filters wrap; this slice adds no filter sheet.
- Evaluator definition content appears before its ancillary sidebar on phones.
  The override action can wrap, model bindings break long words, and terminal
  action rows wrap. No editor/save/override state logic changes.
- Review-player queue titles, identifiers, and navigation can wrap; trace detail
  columns and typed-question definition tracks can shrink within the viewport.

## Verification

- Web typecheck and production build passed (existing large-bundle warning).
- 87 focused tests passed across 12 files. Added rendered interaction coverage
  checks that the stacked case retains verdict/note/actions, its note expands,
  and Review fires once without opening the containing row. Added both welcome
  variants' key-before-heading-and-setup ordering checks.
- No provider calls or human/evaluator writes were used.

## Remaining validation / limits

Actual 390px browser geometry and interaction checks belong to the parent
integration pass; DOM tests do not demonstrate viewport fit. This is a bounded
layout change, not a redesign of every table: resolved/disagreement and detailed
per-case comparison tables retain their existing scroll behavior. Filters retain
existing controls rather than introducing the audit's suggested sheet. Mobile
screen-reader traversal should be checked against the explicit table roles and
retained headers during accessibility QA.
