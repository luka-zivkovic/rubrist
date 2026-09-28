# UX audit: index and plan

Status: **working plan, not product authority.** It gathers the audit
rounds' findings and decisions into one sequence of implementation slices.
Each round stays the record for its own findings; `PRODUCT.md` and the
accepted ADRs stay the product authority.

Last updated: 2026-09-28 · waves 1–2 staged; draft PRs remain unmerged

## Rounds

| Round | Scope | Findings | Record |
|---|---|---|---|
| 1 | App shell and Overview | S1–S9, O1–O14 | [2026-09-26-shell-and-overview.md](2026-09-26-shell-and-overview.md) |
| 2 | Triage flow: Exceptions queue, case page, review player | T1–T10 | [2026-09-26-triage-flow.md](2026-09-26-triage-flow.md) |
| 3 | Evaluator pages: evaluator, editor, versions, compare | C1–C13 | [2026-09-26-check-pages.md](2026-09-26-check-pages.md) |

All three audited code at `2c82321`. Their open questions were settled on
2026-09-26 by taking the recommended options; each round's Decisions section
records them (D1–D11, D1–D6, and D1–D6).

## Direction

Four calls shape every slice:

1. **One vocabulary for everyone** (evaluator, rubric, case, assessment,
   golden set, review queue, regression check), taken from
   `docs/glossary.md` where it defines the term.
   [ADR-0015](../decisions/0015-one-vocabulary-one-display.md) records it, and
   it is **Proposed**.
2. **One display with a help layer.** Guided, Technical, and Summary go away,
   and nothing is hidden or renamed per person. This is also ADR-0015, also
   Proposed.
3. **Components: the middle path.** shadcn/Radix for behavior-heavy
   primitives such as dialogs, sheets, menus, tooltips, tabs, and toasts;
   `components/rubrist/` for product presentation (round 2, "Components in
   the proposals").
4. **Missing evidence never reads as a result.** This is `PRODUCT.md`
   principle 2 applied to the UI (TARGET).

Until ADR-0015 is accepted, the onboarding contract's words stay TARGET and
the display modes stay CURRENT. No slice ships the new vocabulary or removes
a display mode before then.

## Rules every slice applies

These fixes recur across all three rounds, so each slice applies them to the
pages it touches:

1. **Unknown shows as unknown.** "—" for a missing value, a loading state in
   the page's shape, a failure shown in the section that failed with Retry
   when retrying can work, and "not found" only for something that is
   missing.
2. **One name and one location per page.** The nav label, breadcrumb, `h1`,
   and document title agree.
3. **One main action per screen**, placed where the work happens.
4. **Real links, and view state in the URL**, so any destination opens in a
   new tab and survives a reload.
5. **A single-column base on phones**, with no sideways scroll that hides an
   action or a result.
6. **Protect people's work and choices.** Warn before discarding edits,
   never change a setting silently, confirm consequential actions, and don't
   offer an action someone can't complete.

## Gates

These must clear before the slices that depend on them:

| Gate | What | Blocks |
|---|---|---|
| G1 | **Verify O14 in Postgres mode, with a tracing source connected.** The sync code shows no sign-off gate, so provisional assessments may be written back before anyone signs off (ASSUMPTION). Do this first: if confirmed, it is a safety fix. | O12's confirmation copy, and the write-back hold if O14 is confirmed |
| G2 | **Founder acceptance of ADR-0015**, including its open questions. | Slice 9, and the wording and display parts of slices 6–8: round 1's D1, D2, D5, D7, D10, and D11; round 2's D2–D6 wording; round 3's D1 and D6 |
| G3 | **Decide what "Regressions across versions" means.** Today it sums each save's disagreements with the golden labels, so a case wrong in three saves counts three times. ADR-0015's open question 2 is related. | Compare's regressions total in slice 8 |

## Slices

Each slice follows the repository's regular batch flow
(`docs/implementation-batches.md`): tests first, the full suite, CURRENT docs
updated, and an independent review of the exact diff before it is complete.
When a slice ships, the rounds' Implementation status sections record what
changed.

| # | Slice | Findings | Depends on | Status |
|---|---|---|---|---|
| 1 | Missing evidence never reads as a result | C1; C7 except skeletons; C6's count; S4 except the breadcrumb | — | PR #159 |
| 2 | Protect work and choices | C2, C3, C13, O12, and O14's fix if G1 confirms it | G1 for O12's copy and O14 | Implemented in wave 1; staged, PRs #166/#169 |
| 3 | Links and location | S1, S2, S3, T9, T10 | — | Implemented in wave 2; staged, see closeout |
| 4 | Phones | O10, T5, C4 | — | Implemented in wave 2; staged, see closeout |
| 5 | Loading, errors, and waits | S6; C6's elapsed time and long-wait message; C7's skeletons; S4's breadcrumb | — | Implemented in wave 2; staged, see closeout |
| 6 | The triage flow | T1, T2, T3, T4, T6, T7 | Slice 5 for the queue's error state; G2 for wording | Planned |
| 7 | The Overview and shell | O1, O2, O3, O4, O5, O6, O7, O9, O11, O13, S5, S7, S8, S9 | G2 for wording and O7's display part | Planned |
| 8 | The evaluator pages | C5, C8, C9, C10, C11, C12's status labels | G2 for D1 and D6; G3 for the regressions total | Planned |
| 9 | One vocabulary, one display, and the help layer | O8, T8, C12's naming, round 1's D11 naming table, and ADR-0015's consequences: the display modes removed, the help layer built, and the onboarding contract, README, and all three glossary copies updated | G2 | Planned |

### Slice notes

- **Slice 1** also records its known limitations in round 3's Implementation
  status.
- **Slice 2** was prioritized because its findings lose work or mislead about
  permissions (Sev 3), and none of it waits on ADR-0015. O12's confirmation
  names the write-back only once G1 has settled whether it happens.
- **Slices 3 and 4** carry the other Sev 3 findings that don't depend on
  ADR-0015.
- **Slice 5** finishes slice 1's theme. S6 also makes the queue's own error
  state reachable, which slice 6 needs.
- **Slices 6–8** each rebuild one area to its round's blueprint. Parts that
  depend on ADR-0015 wait for it; the rest ships.
- **Slice 9** lands everything ADR-0015 decides, in one pass across the app
  and the docs.

## CURRENT progress (2026-09-28)

Wave 1 is independently reviewed and deployed to the staging app at
`dbcf39d`. Its draft PRs remain unmerged:

- #165: full pinned waiting count, loaded-filter scope, and unavailable
  comparison improvements ([evidence counts](evidence-counts-closeout.md)).
- #166: dirty-editor navigation, member permissions, and preserved execution
  binding ([editor protection](2026-09-28-protect-editor.md)).
- #167/#168: historical review pins and readable full case evidence
  ([historical review](historical-review-closeout.md),
  [readable evidence](2026-09-28-readable-evidence.md)). These close bounded
  correctness gaps in slice 6; they do not complete the triage redesign.
- #169: G1 confirmed and corrected. Unsigned versions' feedback stays held;
  approval releases only that exact version's results, with explicit O12
  confirmation ([feedback recovery](provisional-feedback-closeout.md)).

Wave 2 implements slices 3–5: links/location, phone layouts, and
loading/error/wait recovery. Their individual closeouts bound the scope;
combined testing and browser verification passed before the staging handoff.
See the [wave 2 verification record](2026-09-28-wave2-verification.md).
This does not complete slices 6–8 or the remaining audit rounds.

The founder explicitly deferred vocabulary changes on 2026-09-28. G2 and G3
remain open; ADR-0015 remains Proposed. Existing display modes and terms stay.

## Remaining audit rounds

In order, from the rounds' "Next rounds" sections:

1. First run, end to end (`/skill/edit?first=1` → `/first-result`), checked
   against the onboarding contract's steps.
2. Traces list and import.
3. Analyze and Human truth, the governed paths. These need Postgres 17.
4. Settings, the only place to sign out.

Each new round adds its findings to this plan.

## Tooling

The rounds cite the `ux-craft` skills in the overclock repository. The
skills were added in overclock PR #37 at `e08b2e0`. The tuning these rounds
drove is on overclock's `claude/app-layout-dashboard-audit-ywvz9j` branch, not
yet in a pull request:

- shadcn-aware page structure and a review mode;
- a rebuilt label scanner with domain glossaries;
- recovery, link, and URL-state checks.

The skills' eval suites are still to do.
