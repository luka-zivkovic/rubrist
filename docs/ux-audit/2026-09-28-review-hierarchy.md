# Review-page visual hierarchy

Status: **CURRENT implementation follow-up**, 2026-09-28. This is a bounded
response to the founder's live review feedback, layered on the wave 2 staging
changes. It does not accept ADR-0015 or complete the broader remaining UX plan.

The case detail now leads with the evaluator opinion in reading order, with a
contrasting header and larger verdict. On desktop, the claim and complete
supplied evidence sit beside it, with the review choices directly below the
opinion. On narrow screens, the opinion precedes the evidence and review
choices. A recorded human ruling retains first position and stronger visual
emphasis; the model opinion becomes secondary.

The claim has larger type and a distinct inset. The recorded typed question
and decision threshold sit in a closed native disclosure below review actions.
Judge call diagnostics and the full evaluator version identifier use a second
closed disclosure. Both reset when the case or recorded judge run changes.
The short recorded version remains visible with the opinion. The probability,
threshold mapping, and absence of a Jev rationale remain explicit.

These are presentation changes. Review writes, historical version selection,
provider execution, reference labels, and display-mode behavior are unchanged.
The follow-up below strengthens the review buttons and makes their actions explicit;
the separate golden-set transaction is quieter.

Independent source review found no blocking correctness issues. The complete
suite passed 1,822 tests plus 29 tooling checks; 150 database-only tests were
skipped. This patch changes no API, database schema, or shared contract.
TypeScript checking, the web production build, repository boundaries,
shared-contract guards, and whitespace checks also passed. The existing Vite
large-chunk advisory remains.

Staging deployed `9b5e8ee3d2897a4be3134521c7efcf3aaa729de2` successfully
(Coolify activity 492). Draft [PR #173](https://github.com/luka-zivkovic/rubrist/pull/173)
is stacked on wave 2 and remains unmerged. Native Brave checks covered:

- Desktop result/claim distinction and review controls before diagnostics.
- A completed case with its human ruling first and visually stronger than
  the evaluator output, in both light and dark themes.
- Opening the recorded question and exact call-version details, closing the
  question with Space, and both disclosures resetting on case navigation.
- The result, wrapped review controls, closed disclosures, and expanded
  question at 390 CSS pixels. No horizontal clipping appeared in these views.

Before/after data fingerprints match for cases, verdicts, judge runs, dataset
items, and golden entries. The queue API view is unchanged: three completed
human reviews and five pending items. All eight cases retain their recorded
Jev model/version and full claim/evidence; an explicit evaluator version with
no recorded result still returns 404. No review writes, provider calls, or
reference-label edits were made. The original tab is back on case 4, with
the light theme and developer tools closed.

This is bounded visual and keyboard verification, not a full assistive-technology
audit. The longer source text still requires reading and scrolling; this
change adds no fabricated evidence highlights or Jev explanation.


## Explicit result colors and agreement actions

CURRENT follow-up to founder feedback: PASS has green borders/tint, FAIL red,
and ambiguous amber, including dark-theme variants. Labels remain explicit.
The saved human ruling still takes visual precedence over model output.

The review buttons now say “Agree with evaluator” with “Record PASS/FAIL/AMBIGUOUS
as my ruling,” or “Disagree with evaluator” with “Choose a different ruling and
explain why.” Agreement uses a filled blue button, so agreeing with a FAIL
cannot be confused with a green pass action. Disagreement uses an amber edit
button and opens the existing form without writing. The final form submission
names the selected ruling. The golden-set action sits below that form.

Independent source review found no blocking issue. All 465 web tests passed,
including mocked agreement handler request payloads for pass/fail/ambiguous with the historical
version pin and disagreement opening without a write. Typecheck and production
web build passed. After moving the golden action below the override form,
26 focused tests and the production build passed again; independent rereview
also cleared the final diff.

Staging deployed `a6647992bc101551cd6623e5197b20bc095e8432` successfully
(Coolify activity 493). Native Brave checks in the user's current dark theme
confirmed green PASS and red FAIL cards, the explicit agreement label for
each, and disagreement opening the different-ruling form with submission
disabled until a reason is entered. The form was cancelled without saving.
The result and both action labels fit at 390 CSS pixels. This follow-up did
not switch the user's theme or visually recheck light mode; both theme variants
are included in the compiled production CSS.

Data fingerprints and the queue API view match the new pre-deployment baseline:
three completed reviews and five pending. No human review was submitted and
no provider was called during verification. The temporary tab is closed,
developer tools are closed, and the original tab shows the update on case 4.
