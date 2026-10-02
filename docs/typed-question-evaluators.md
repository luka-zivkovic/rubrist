# Typed-question evaluators

A guide for criterion authors. It says what a typed-question evaluator is,
when the #101 spike and later experiments suggest one fits, and what Rubrist
records for it.

- **CURRENT:** everything except the "When to use one" section and the
  advice marked ASSUMPTION under "Choosing the threshold" describes the
  implementation (Batch 8E), as decided in
  [ADR-0014](decisions/0014-model-agnostic-evaluator-execution.md) section 5
  and its founder decisions 8–11.
- **ASSUMPTION:** "When to use one" reports the #101 spike and later
  experiments. The spike's numbers are in ADR-0014 under "ASSUMPTION: the
  #101 spike"; the later ones are in the experiments repositories named
  there. All come from public data, not governed truth.

## What it is

A typed-question evaluator asks a TypeSafe typed-question model, such as Jev
(`jev-1.13.0`), one yes-or-no (`noul`) question about a trace. The model
answers with the probability that the answer to the question is true. Rubrist
reads true as pass, and the item passes when that probability is at or above
the evaluator's decision threshold.

Its definition is:

- **the question**: instructions, plus what a true and a false answer mean;
- **polarity**: true means pass;
- **a decision threshold** strictly between 0 and 1. It is required, has no
  default, and is part of the evaluator's identity;
- **a fixed output contract**: a probability, and no rationale.

The version stores the question's text, and its identity names the question
by digest.

The model is shown the question and the trace's input and output, plus each
step's name, input, and output when there are steps. It sees nothing else: no
trace id, no metadata, and no rubric or policy document.

A typed-question evaluator never abstains and never states a rationale. Its
verdict records `rationaleStatus: "not_provided"` instead of text, and its
probability is the verdict's `native_probability` score. That score is
uncalibrated.

Only binary questions are supported. Choice and score questions wait for
[ADR-0004](decisions/0004-calibration-semantics.md)'s categorical and scalar
calibration.

## When to use one

What the #101 spike showed, and didn't:

- **Short, self-contained criteria.** On ChaosMNLI and MT-Bench, McNemar
  found no accuracy difference between Jev and Sonnet 4.6, Sonnet 5, or
  Opus 5.5 (p ≥ 0.065). That is "no difference detected", not equivalence.
  On original-order MT-Bench the paired bootstrap put Jev ahead of Sonnet 5.
  On these sets Jev cost about 1% of Haiku 4.5 per trace, with a median
  latency about a tenth of Haiku's.
- **Whole-agent-run criteria.** On tau-bench trajectories, Jev was at chance,
  as were Haiku 4.5 and Sonnet 4.6; Sonnet 5 was only slightly above. Opus 5.5
  was not at chance. The run couldn't tell whether trace length, task type,
  reasoning, or model capability explains the gap.
- **Prompt injection wasn't tested.**

What later experiments showed, from 2026-09-30 to 2026-10-02. They used public
benchmark labels, and the AgentRewardBench runs sent Rubrist's exact
typed-question/v1 requests. Sources: `luka-zivkovic/experiments`, branches
`claude/jev-agent-judge` (`jev-in-rubrist/`) and `claude/jev-rubrist-roles`,
and `luka-zivkovic/lodestone`.

- **Whole-run success depends on whether the outcome shows in the trace.**
  - On AgentRewardBench web-agent runs with expert labels, Jev read success at
    AUC 0.885 [0.849, 0.920] on 531 held-out runs, and "no looping" at 0.917.
    A second lab measured 0.917 for success on 1,290 of the same runs with
    another wording, above GPT-4o's binary verdict (0.855).
  - On tau2-bench telecom, AUC 0.94.
  - On tau-bench retail, AUC 0.71 against Opus 5.5's 0.86 on the same 109
    runs; on airline, 0.43 to 0.51. There the error usually isn't in the
    transcript: in 7 of 9 real wrong-replacement failures, the customer never
    named the right item.
- **The criterion's definition is the biggest lever.**
  - "No side effects" as first worded was at chance (AUC 0.54). Defining a
    side effect as an unrequested change to stored data raised it to 0.79.
    That is one rewrite by one author.
  - A reworded success question added 0.18 AUC on tau-bench retail.
- **Where refusing is often right, a fulfilment question inverts.** On
  airline, about half the right outcomes were "change nothing". Write one
  criterion for runs where an action was owed, and another that nothing
  forbidden was done.
- **The threshold is often far from 0.5.** On AgentRewardBench, good
  thresholds for success and looping were about 0.07 to 0.25. In a
  simulation of Rubrist's review loop, thresholds chosen from suggested review
  batches ran lower than ones chosen from random review (median 0.105 against
  0.185). On a criterion failing on about 6% of runs, choosing from those
  batches lowered balanced accuracy in all 30 simulated seeds.
- **Re-asking isn't exact.** Identical requests flipped about 1–4% of verdicts
  at a 0.5 threshold.
- **What didn't help:**
  - graded examples in the question text, which did no better than the same
    examples with their labels swapped;
  - one question per quoted user request (AUC −0.17 on tau-bench retail);
  - repeated calls, several views of one trace, and score readouts;
  - combining many questions, which needed 200–400 labels from the same domain
    and didn't transfer to another.
- **The user's goal in the trace's input** raised AUC by 0.08–0.12 on
  tau-bench and telecom. There the goal was the benchmark's script for its
  simulated user, so the gain with goals that real systems record is
  unmeasured.
- **Not yet tested:** narrow criteria over long agent runs, against labels for
  those criteria.

So a typed-question evaluator for a criterion over whole agent runs needs its
own calibration evidence before anyone relies on it. Rubrist has no automatic
trace-length gate; one waits until an effect is measured.

## Writing the question

- State one property of the trace, for example of the agent's reply, in the
  instructions.
- Say concretely what makes it true and what makes it false. Both criteria
  are required.
- Make true the passing answer. Polarity is fixed, so a question whose "yes"
  means failure must be reworded.
- Put everything the model needs in the question or the trace. It sees only
  those, so a question about a policy works only if the question states the
  policy or the trace carries it.
- Any change to the question's text is a new evaluator version.

## Choosing the threshold

- Choose it on nonsealed data, never on sealed calibration data. For example,
  save a version with a provisional threshold, run it over development cases,
  read each verdict's `evaluatorScore` (its `native_probability`) from the
  verdict export (`/api/projects/verdicts/export?format=jsonl`), and save the
  threshold you choose as a new version.
- **ASSUMPTION:** choose it from a random sample of development cases, and
  don't start from 0.5. A suggested review batch is triage, not a sample; see
  "When to use one" for how far thresholds landed and how batch-chosen ones
  skewed.
- The threshold is part of the evaluator's identity, not release policy. A
  different threshold is a different evaluator, with its own calibration.

## Binding and credentials

- Bind the `typesafe` provider with `typed-question/v1` and a pinned model,
  such as `jev-1.13.0`. TypeSafe takes no sampling, reasoning, or token-limit
  settings, so every such field is `null`.
- A mutable alias such as `jev-latest` can be saved, but it is refused at
  every governed gate: candidates, activation, and sealed calibration.
- Credentials come from a project's TypeSafe key (Settings, "Judge provider
  keys") or the platform's `TYPESAFE_API_KEY`. The project key wins.
- Resolution confirms the binding with one probe, which asks a fixed question
  about a fixed trace. The probe sends no project data.

## Saving one

In the web app, a project owner edits the evaluator and chooses **TypeSafe**
as the provider. That needs a TypeSafe key, from the project or the platform.
The review guide and judge instructions then give way to the typed question:

- the question;
- what makes its answer true, and what makes it false;
- the decision threshold, which has no default.

Enter the model by name, such as `jev-1.13.0`. TypeSafe takes no sampling,
reasoning or token-limit settings, so the binding shows only its one
protocol. The version page and the skill page show a typed version's
question, criteria and threshold in place of a guide and instructions.

The first-project setup works from prompted starter templates, so it doesn't
offer TypeSafe; author a typed question from the evaluator editor afterwards.

A project owner can also save a version through the API:

```http
POST /api/skills/{skillId}/versions
content-type: application/json

{
  "typedQuestion": {
    "type": "noul",
    "instructions": "Does the reply answer in the language the user wrote in?",
    "criteria": {
      "true": "The reply is in the user's language.",
      "false": "The reply is in another language."
    }
  },
  "decisionThreshold": 0.62,
  "executionBinding": {
    "provider": "typesafe",
    "endpoint": { "kind": "managed" },
    "modelId": "jev-1.13.0",
    "modelVersion": "jev-1.13.0",
    "sampling": { "temperature": null, "topP": null },
    "reasoning": null,
    "outputTokenLimit": null,
    "verdictProtocol": "typed-question/v1",
    "routing": null
  }
}
```

- A typed-question version takes no `rubricMarkdown` or `prompt`, and its
  verdict kind is binary. Leave `outputSchema` out: the fixed probability
  contract is filled in, and it is the only one accepted.
- Saving runs the regression gate over the criterion's golden set through
  TypeSafe, so it needs a TypeSafe key (without one the save answers 503) and
  sends those traces' projections to TypeSafe. A `timeScope` of `existing` or
  `both` also judges the project's existing cases. Every run and calibration
  sends each judged trace's projection the same way.
- Governed candidates take the same `typedQuestion` and `decisionThreshold`
  fields in place of `rubricMarkdown` and `prompt`.

## What the evidence shows

- **Receipts** carry, for each item with an outcome, pass or fail and its
  `native_probability` score, never a rationale. A call that failed records
  its failure kind instead.
- **Sealed calibration** records pass or fail for each answered attempt. A
  typed-question trial never abstains; a failed provider call is recorded as
  a failure.
- **skill-format/v1 exports** carry the question's text beside the identity,
  which names the question only by its digest.
- **Feedback sync** sends the label and score, never a rationale. LangSmith
  and Ironside get no comment; Langfuse's comment is the label alone.
