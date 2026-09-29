# Suggested operational review batches

The founder selected better review prioritization on 2026-09-29.

**TARGET for this slice:** from the existing saved-queue flow, suggest ten cases
for one exact evaluator version. Mix flagged and ambiguous results with a
reserved share of passing-result spot checks. Show why each case was selected,
then let the owner save that list with its exact recorded results pinned.

**CURRENT boundary:** saved queues expose evaluator opinions and produce
ungoverned development feedback. This slice does not implement #102's governed
uncertainty selection or change ADR-0008. No representative, calibration,
probability-of-error, release, or human-truth claim follows from this selection.

## Selection contract: review-priority/v1

- Consider the newest result per ordinary case for the selected project and
  evaluator version; exclude release/gate scaffolding, reviewed results and
  results already pending in an open saved queue.
- Consider at most the newest 1,000 eligible results and report when capped.
  This is a bounded work list, not a frozen population or prevalence estimate.
- Shuffle deterministically within each verdict bucket using a fresh server
  seed. Reserve 20% of the requested budget (rounded up) for passing-result
  spot checks when available. Alternate flagged and ambiguous results for the
  remaining slots, then fill unused slots from remaining eligible cases.
- Reasons describe recorded verdicts, not calibrated uncertainty. No model
  calls or LLM confidence thresholds are involved.
- Selection creates no labels. Saving validates all case/result/evaluator pins
  against project scope and retains the previewed results even if a newer
  assessment arrives. Existing manual queue creation remains supported.
- The preview is temporary, not a governed selection artifact. Saved queue
  membership and evidence pins use the existing immutable task contract.

**ASSUMPTION to test in the pilot:** ten cases with two passing spot checks
reduce review effort while still exposing confidently wrong evaluators. The
ratio is a starting heuristic, not a statistically validated optimum.
