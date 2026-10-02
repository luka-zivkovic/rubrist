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

## Simulation evidence

**ASSUMPTION, 2026-10-02:** a simulation called `suggestReviewBatch` directly on
771 public AgentRewardBench web-agent runs, judged by a Jev typed-question
evaluator, with reviewers simulated by the dataset's expert labels. After each
round of reviews the threshold was chosen again from the reviewed cases, and
accuracy was scored on 531 held-out runs. It is public data and simulated
review, not the pilot. Details: `luka-zivkovic/experiments`, branch
`claude/jev-agent-judge`, `jev-in-rubrist/loop/RESULTS.md`.

- **As triage it worked.** On task success, the threshold chosen after 50
  suggested reviews raised held-out balanced accuracy from 0.741 to 0.804
  (median of 30 seeds). Another 50 reviews added nothing (0.801).
- **As a sample it was skewed.** Each 100 reviews held 80 flagged and 20
  passing results. Thresholds chosen from them ran low (median 0.105, against
  0.185 from random review). On a criterion failing on about 6% of runs, they
  lowered balanced accuracy in all 30 seeds (0.598 to a median of 0.498).
- **Random review did best overall,** and it was the only representative rule.
  Reviewing the cases nearest the current threshold never moved a wrong
  threshold on success.

So reviews of suggested batches find evaluator errors, but they shouldn't be
used to choose a threshold or to compare evaluator versions. Whether each
batch should also carry a random share is an open product decision.

## Delivery verification

**CURRENT, 2026-09-29:** [PR 185](https://github.com/luka-zivkovic/rubrist/pull/185)
merged with automated and isolated PostgreSQL checks passing. A local browser
flow covered saving a suggested queue and reviewing its pinned results. Hosted
verification checked read-only suggestions and reasons for pilot and benchmark
cases, with completed reviews excluded. Existing reviews and saved tasks were
preserved. That hosted verification did not create a new queue; subsequent
pilot work is separate evidence.

The [repeated-use check](repeated-use-verification.md) additionally exercises
saved pins and review history across import batches and evaluator changes in a
disposable database. Neither check validates the 20% passing-result reserve or
establishes human review accuracy.
