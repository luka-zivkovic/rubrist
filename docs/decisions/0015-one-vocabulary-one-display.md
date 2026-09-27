# ADR-0015: One product vocabulary and one display with a help layer

Status: **Proposed**

Date: 2026-09-26

Decision owner: Luka Živković (founder).

- **Decided by the founder on 2026-09-26:** one vocabulary that is not
  simplified for beginners, with friendly explanations for people new to
  evaluation; and, after reviewing a two-mode design the same day, one display
  with a help layer instead of display modes.
- **Awaiting founder review:** the term mapping below and the
  [open questions](#open-questions-for-the-founder).

Nothing in this ADR is implemented until it is accepted.

## Context

Rubrist currently speaks two vocabularies:

- The onboarding contract's product language table gives beginner words (Run,
  Check, Result, Review guide, Protected example). It keeps technical terms
  "exact on Technical surfaces and in evidence"
  (`docs/beginner-onboarding-journey.md` › Product language).
- The README's Concepts section says the Guided view uses the beginner words
  and the Technical view uses the rest.

The web app has three display modes: Guided (the default), Technical, and
Summary. They are stored per browser (`apps/web/src/hooks/use-mode.ts`) and
differ in a few places. Technical shows raw ids, the judge call's raw request
and response, and more navigation items. Summary trims the navigation and
changes one Overview button. The UX audits in `docs/ux-audit/` found that
Guided does not keep its promise to hide technical details on at least two
pages. They also found that hiding pages by mode creates dead ends: the review
queue links Guided users to a page their navigation does not list.

The same audits found one thing named four to seven ways: four names for the
evaluator on the Overview, and seven for the review queue along the triage
flow. Their first proposals paired a Guided name with a Technical name for
each concept. Two names per concept, or two versions of each screen, would
show people on the same project different products depending on a
per-browser setting. It would also double the copy, help text, screenshots,
and tests.

The founder expects Rubrist's users to be mostly technical (ASSUMPTION, the
founder's statement on 2026-09-26). The onboarding contract is written for
people who may not know what an eval, rubric, or judging skill is
(`docs/beginner-onboarding-journey.md:7-9`). If most users are technical,
simplified words make the product less precise for most of them. People new
to evaluation need explanations, and what they do not know varies by
concept, so a single beginner switch fits them poorly. `docs/glossary.md`
already defines precise shared terms for most of these concepts.

## Decision

### One vocabulary

Every surface uses one term per concept: the app, the README, help text, and
API-facing copy. API-facing copy is the user-visible text the API returns,
such as error messages the app shows. Before any API message is reworded,
client code must stop matching it by text and match an error `code` instead.
Terms follow `docs/glossary.md` where it defines them.

| Concept | Term | Replaces today |
| --- | --- | --- |
| One named quality dimension | criterion | "one thing to Check" |
| The automated evaluation of one criterion | evaluator; a prompted LLM judging skill and a typed-question evaluator are its current types | Check, Skill, judge |
| One immutable version of it | evaluator version | skill version, Check version |
| The evaluator's written grading instructions | rubric | Review guide, guide |
| The model prompt around the rubric | prompt | Judge instructions |
| The question a typed-question evaluator's model answers | typed question | — |
| Which answer to that question counts as pass | polarity | — |
| The probability cut-off that maps the answer to pass or fail | decision threshold | — |
| The required output shape | output contract | Result format |
| Exactly what is sent to the model | execution binding | Binding, model binding |
| The unit an evaluator assesses | case: one imported trace, or one dataset example in a bench project | Run, and trace or example used as the unit |
| The result of applying an evaluator to cases, and its per-case value | assessment; its per-case pass, fail, or ambiguous value is the assessment label | Result, verdict, "Skill said", evaluator opinion |
| A label a reviewer records while seeing the assessment | ungoverned human label, recorded by "Accept assessment" or "Correct assessment" | human verdict, ruling; "Correct this result" in the onboarding contract |
| A reviewed human label or adjudicated result with rater and provenance information | human truth | — |
| A person judging a case without seeing its assessment | blind human review (open question 3) | "Independent human review" in the onboarding contract |
| How often an evaluator matches human truth on a named set of cases | human agreement (open question 3) | "Agreement with people" in the onboarding contract |
| Cases waiting for a person | review queue | Exceptions, Needs a human, Waiting on a person, Humans next |
| Curated cases that guard against regressions | golden set, whose members are golden cases | Protected examples, regression references |
| The golden-set run on each new evaluator version | regression check (open question 2) | gate, known-failure check, check |

When copy talks about a source system, it uses that system's word for the
source and Rubrist's word for the result, for example "12 LangSmith traces
imported as 12 cases".

### One display

- Guided, Technical, and Summary are removed. Everyone sees the same screens,
  words, data, and navigation. Actions still follow each person's role, so an
  owner-only action stays owner-only.
- Bulky internals, such as raw request and response bodies and digests, sit in
  collapsed sections.
- If stakeholders need a status view, the job Summary approximated, it is a
  page or a shareable report, not a display setting.

### A help layer

- Every product term has on-demand help that shows its definition.
- Explanations also appear where the need is predictable: the first-run
  journey, empty states, and the first time a concept appears for a person.
  Each can be dismissed, concept by concept.
- One personal preference, "Show explanations", turns the proactive
  explanations off; on-demand help stays. It is on for new accounts, so
  onboarding does not ask people to rate their own experience.
- The onboarding contract's "Consequence to explain" column is a source for
  these explanations.

### What stays

The onboarding journey's steps and its truth and safety rules stay, including
"A successful run is not called calibration, accuracy, approval, or trust."

## Consequences

- When accepted, this supersedes the onboarding contract's beginner words
  wherever it uses them as product copy, and its Guided-display word rules:
  - its Beginner mental model (`docs/beginner-onboarding-journey.md:36-48`);
  - its Product language section (`:56-77`), which is rewritten as a table of
    terms with their explanations;
  - step copy such as "Create this Check" (`:104`);
  - references to Guided display (for example `:298`), which become
    references to the help layer.
- The README's Concepts and "Your first Check" sections are rewritten in this
  vocabulary, and its description of the Guided and Technical views is
  removed.
- `apps/web/src/lib/display-mode.ts` and `apps/web/src/hooks/use-mode.ts` give
  way to the "Show explanations" preference. Content marked `.dev-only`
  becomes visible to everyone, navigation filtering by mode is removed, and
  stored mode values are ignored.
- Terms used here but not defined in `docs/glossary.md` (case, review queue,
  regression check, golden set, golden case, ungoverned human label, and the
  answers to open question 3) are added to all three vendored copies of the
  glossary together.
- Route paths and API names, such as `/skill`, `/exceptions`, and the
  `verdicts` endpoints, are unchanged by this ADR. Renaming them is a separate
  change.
- The UX audits in `docs/ux-audit/` write their proposals in this vocabulary
  and display, and mark which of their decisions wait for this ADR.

## Open questions for the founder

1. **The term mapping.** Accept the table as written, or change individual
   terms before acceptance.
2. **"Regression check" and "regression".** The glossary defines a
   regression as a paired case whose accepted baseline passed and whose
   candidate failed (`docs/glossary.md:78-79`). CURRENT: the regression check
   counts a case as regressed whenever the new evaluator version disagrees
   with the golden label (`apps/api/src/repository/golden-helpers.ts`), with
   no baseline pass required. Should the UI word follow the check's meaning,
   with the glossary extended, or should the check's counts change to match
   the glossary?
3. **New terms.** "Blind human review" and "human agreement" are proposed here
   for concepts the glossary does not name. Keep them, or choose others.
