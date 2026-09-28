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
The two human review choices keep equal button weight; the separate golden-set
transaction is quieter.

Independent source review found no blocking correctness issues. The complete
suite passed 1,822 tests plus 29 tooling checks; 150 database-only tests were
skipped. This patch changes no API, database schema, or shared contract.
Native browser and deployment checks remain to be recorded. The fresh staging
baseline contains three completed human reviews and five pending queue items;
those reviews must be preserved.
