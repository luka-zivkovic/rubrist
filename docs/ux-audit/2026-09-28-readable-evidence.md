# Readable recorded evidence

Status: **CURRENT implementation change**, bounded triage work following the
historical-review repair. Existing vocabulary and display modes are retained;
this does not accept proposed ADR-0015 or complete the triage redesign.

## Behavior

The evidence/claim payload used by the WiCE experiment now shows the complete
claim, the context reserved for resolving references, and every supplied
source entry as readable text. Entries retain their original order and content,
including source metadata and empty entries; the long source area scrolls.
Raw input/output JSON is available in a closed disclosure. The renderer is
conservative: additional fields or unfamiliar evidence shapes keep the existing
full generic payload view rather than hiding potentially relevant evidence.
All content renders as escaped text, never interpreted HTML.

For a TypeSafe call, the question comes only from the recorded request whose
prompt ID matches the displayed evaluator version. The recorded binary question
is validated against the accepted schema. A native probability is named as the
probability that the answer is **true**, never generic confidence or accuracy.
True means pass under ADR-0014. The displayed threshold comes from the recorded
response, and the probability must agree with the saved score and the inclusive
threshold's label. Missing or inconsistent metadata remains explicitly
unverified rather than borrowing the currently configured evaluator.

The UI states that a typed evaluator supplies no explanation. It does not
generate one. Empty exception notes no longer offer a Full note button; a newer
recorded note can still be expanded when the original has no explanation.

Each history item now names its observed model when recorded and its exact
evaluator version ID. The current version's human-readable version number is
shown only when its recorded prompt ID matches. Missing historical model names
stay “not recorded”; one call's observed model is never borrowed for another.

## Verification and scope

Focused tests cover 700 complete source entries, reference-only context, raw
payload retention, HTML escaping, unknown payload fields, observed model names,
exact version attribution, zero and threshold-boundary probabilities,
inconsistent call metadata, absent explanations, and empty-note controls.
Existing review-player tests continue to verify human-write attribution.

This changes presentation only. No provider is called, no reference labels or
human verdicts are created, and neither the blinded governed-review payload nor
the operational review write path changes. Review-action ordering and the
trace-to-test banner remain later work. Full integrated validation, independent
review, and browser verification are the integrating batch's exit checks.
