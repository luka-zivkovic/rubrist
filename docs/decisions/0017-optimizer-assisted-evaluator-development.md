# ADR-0017: Optimizer-assisted evaluator development

Status: **Proposed**

Date: 2026-10-07

Decision owner: Luka Živković (founder). This record was drafted at the
founder's request after an assessment of `microsoft/skillopt` on 2026-10-07.
It is a recommendation awaiting founder review. No runtime behavior depends
on it yet, and none may be built until it is accepted (AGENTS.md).

## Context

### The question

Rubrist's loop expects a quality owner to tune an evaluator's rubric and
judge instructions against iterative-development data until it agrees well
enough with human truth to deserve sealed validation. Today that tuning is
manual: the editor seeds a new version from the latest one, shows a
before/after of the definition, and the owner reads disagreement cases and
rewrites text by hand.

SkillOpt (Microsoft Research, MIT licence, Python, arXiv 2605.23904) is an
open-source loop that automates exactly this kind of text tuning for a
different object. It treats a Markdown "skill" document as the trainable
state of a frozen model: roll the model out over a batch of scored tasks,
have a separate optimizer model read the failed trajectories and propose
bounded add/insert/replace/delete edits, apply the top-k edits, re-score the
candidate on a held-out selection split, and accept it only when its score is
strictly higher. Its `EnvAdapter` and `SplitDataLoader` contracts make a new
environment roughly two hundred lines of Python.

The mapping to Rubrist inverts the roles. In SkillOpt the skill belongs to
the agent under test. In Rubrist the text worth tuning is the evaluator's
own rubric and judge instructions, so the judge becomes SkillOpt's target.

| SkillOpt concept | Rubrist equivalent |
| --- | --- |
| Skill document | Prompted evaluator definition: rubric and judge instructions |
| Target model | The evaluator's execution binding (ADR-0014) |
| Task item and ground truth | One case and its resolved human-truth label |
| `hard` score | Evaluator label equals the human label |
| Train split | An iterative-development revision |
| Selection split | A second, disjoint iterative-development revision |
| Test split | None inside the optimizer. Sealed validation stays in Rubrist |
| `best_skill.md` | Input to governed candidate creation |

This is dated external context, not product authority. The question for
this record is whether, and under what rules, Rubrist should support it.

### TARGET (PRODUCT.md and accepted ADRs)

- Iterative-development data is "cases used repeatedly to tune an
  evaluator's rubric, prompt, examples, model choice, or implementation"
  (`docs/glossary.md`). The loop this record automates is already the
  charter's intended use of that role.
- Principle 8: alignment "improves the rubric or resolves truth while
  preserving independent labels; it never rewrites disagreement out of
  history." An optimizer edits the rubric and never a label.
- Principle 6: "Numeric heuristics from courses or competitors are
  hypotheses to test, not product requirements." An optimizer's gate score
  is such a heuristic.
- Principle 2: missing or failed evaluation is never converted into a
  favorable result. An abstention or execution failure during optimization
  scores as a miss, never as agreement.
- ADR-0007: "Development runs, exports, example selection, prompt or rubric
  tuning, and explicit declassification are disqualifying for later
  evaluator versions" on a sealed revision. Nonsealed content never becomes
  sealed.
- ADR-0009: an evaluator version created or developed after the earliest
  prior final-validation completion on a revision cannot reuse that
  revision. Unknown ordering fails closed.
- ADR-0014: identity is the definition plus the execution binding; verdict
  protocols pin everything injected around the judging skill, and any change
  to injected text is a new evaluator identity.
- Semantic clustering is deferred. Automated rubric optimization is neither
  owned nor excluded by PRODUCT.md and appears in no implementation batch.

### CURRENT, checked on 2026-10-07

- An evaluator version is a `skill_versions` row holding `rubric_markdown`,
  `prompt`, `output_schema`, `execution_binding` and `criterion_version_id`.
  Versions are immutable. Only a stored version can be executed, through
  `POST /api/eval-runs`, the regression gate worker, sealed calibration, or
  `POST /api/v1/judge/batch`.
- The exposure ledger `dataset_exposure_events` already has the activities
  `rubric_authoring`, `prompt_tuning`, `example_selection`,
  `model_selection`, `development_run`, `export` and `exact_overlap`, and
  the subject kinds `evaluator_version`, `activity`, `person`, `api_key` and
  `system`. Ordinary eval runs refuse `sealed_validation` revisions.
- Governed candidate creation (`POST /api/evaluator-lifecycles/candidates`,
  owner session only) requires the exact promoted criterion, a frozen
  governed nonsealed truth batch and at least one resolved pass/fail item.
  In one transaction it creates the version, copies that truth into a new
  `regression_golden` revision, appends a `rubric_authoring` exposure on the
  truth revision, and seeds the `candidate` event.
- Activation requires a complete, currently admissible sealed
  binary-calibration artifact and a complete, nonempty, passed regression
  run on the candidate's pinned regression revision, enforced in the
  database. Candidate creation is the only entry point.
- `skill_versions.rubric_provenance` is one of `human-authored`,
  `agent-drafted` or `unspecified`, with an immutable declaration flag
  (`docs/evaluator-authorship.md`). It describes who drafted the whole
  version and carries no reference to how.
- `docs/evidence-tier-gating.md`, which is explicitly non-authoritative,
  lists as an anti-pattern: "Optimizing a skill against a small golden set
  (Goodhart: the optimizer farms judge wobble, not quality). Optimization
  loops require a large, kappa-stable golden set and an explicit
  return-on-investment gate."
- API keys authenticate only `/api/v1/*` and are read/judge-only. No client
  can create versions or launch revision-bound runs without an owner session.
- Rubrist is a TypeScript/pnpm monorepo. SkillOpt is Python 3.10+ with
  `openai` and Azure SDK dependencies and a 2,500-line trainer whose state
  lives on the filesystem.

### Where the two collide

1. **Harness fidelity.** SkillOpt's chat backends wrap the skill in their
   own system-prompt template and parse answers their own way. A rubric
   tuned under that wrapper is tuned for text Rubrist never sends. Under
   ADR-0014 the only faithful rollout is one that runs through Rubrist's
   verdict protocol with the exact binding the candidate will carry.
2. **No scratch execution.** An optimizer scores dozens of throwaway
   definitions per epoch. Rubrist can execute only stored, immutable
   versions, and storing one through the legacy route enqueues a regression
   gate run. Using versions as scratch state would pollute the lineage.
3. **Regression independence.** Candidate creation copies the truth batch
   into the candidate's own regression revision. If the optimizer trained on
   that truth, the mandatory passed regression run is satisfied by
   construction and measures nothing new. Sealed calibration remains the
   independent check, but the regression run would then be a formality.
4. **Goodhart on small sets.** SkillOpt accepts a candidate on a strictly
   higher accuracy over the selection split. With a nonzero-temperature
   judge and a few dozen items, that accepts noise.
5. **Provenance.** Nothing records that a version's text came out of an
   optimization run, over which revisions, with which optimizer model, and
   through which accept/reject history. `rubric_provenance` says
   `agent-drafted` at best.

## Decision (proposed)

### 1. Scope: ungoverned development tooling, not evidence

Optimizer-assisted evaluator development is Rubrist development tooling in
the same sense as the ordinary eval-run and run-comparison screens. It
produces a **definition proposal** and development exposure records. It
produces no evaluator version, human truth, calibration evidence, regression
result, approval, activation or release outcome. Its gate scores are
development feedback under principle 6 and never appear in receipts,
calibration artifacts, suite manifests or the component measurement view as
evidence.

### 2. Two stages, the second gated on the first

- **Stage A, reflect-only.** Given one finished eval run over an
  iterative-development revision, Rubrist shows the owner a ranked list of
  proposed rubric and instruction edits derived from the disagreement cases,
  with the supporting cases named. The owner edits by hand, as today. No
  candidate is scored and no loop runs. This stage needs no new execution
  path: it reads per-case labels that already exist.
- **Stage B, gated loop.** The full rollout, reflect, edit, select, gate
  cycle over distinct training and selection revisions, producing a
  definition proposal and an optimization-run record.

Stage B is authorized only after Stage A has been used on real projects and
the founder has judged the suggestions worth automating. Stage A alone may be
the whole feature.

### 3. Data boundary

- Training and selection inputs are `iterative_development` revisions only.
  `analysis_authoring`, `regression_golden` and `sealed_validation`
  revisions are refused at the API, in addition to the existing sealed
  refusal.
- The training and selection revisions must be distinct, and an exact item
  overlap between them is refused and recorded as an `exact_overlap`
  exposure on both.
- Every rollout appends a development exposure on the revision it read:
  `kind=development_use`, `exposure_class=development`,
  `activity=prompt_tuning`, `subject_kind=activity`, `subject_id` the
  optimization-run id. Sending resolved human labels or rationales to an
  optimizer model is an `export` exposure on the truth revision with the
  same subject. These exposures are disqualifying under ADR-0007 exactly as
  manual tuning is.
- Human truth used for scoring is the resolved truth revision bound to the
  training and selection revisions. Labels are read, never written.
  Abstentions, failures and `not_attempted` outcomes score as disagreement.

### 4. Execution fidelity: development execution of an unstored definition

Rubrist gains one owner-session capability, provisionally
`POST /api/evaluator-development/executions`, taking a criterion version, a
complete prompted definition, a resolved execution binding, one
`iterative_development` revision and an optimization-run id. It executes
every item through the binding's verdict protocol exactly as a stored
version would, returns per-case outcomes in the ADR-0014 outcome model, and:

- creates no `skill_versions` row, no `eval_runs` row and no receipt;
- appends one row to a new append-only `evaluator_development_executions`
  table holding the definition digest, binding, revision id, optimization
  run id, per-item outcomes, call counts and token usage;
- appends the exposures in decision 3;
- requires the same explicit reasoning and temperature settings that
  governed gates require (ADR-0014 decisions 1 and 12), because a
  definition tuned under a different setting is tuned for a different
  identity;
- is subject to an owner-adjustable per-project call budget, refusing work
  beyond it rather than queueing it.

Typed-question evaluators are out of scope: their trainable text is a
question and a threshold, not a document.

### 5. Entry into governance and provenance

A proposal enters Rubrist only through the existing governed candidate
creation, by an owner, with the full definition as the input. Nothing is
created automatically.

A candidate created from a proposal records `rubric_provenance =
agent-drafted` with the declaration flag set, plus a new immutable
`development_provenance` reference to the optimization-run record. That
record holds: the tool name and version, the optimizer binding, the training
and selection revision ids and item digests, the configuration digest, the
accept/reject history with its selection scores, and the digest of the
proposed definition. Receipts and calibration artifacts remain unchanged;
they already carry the definition digest and not its text.

### 6. Regression independence is made visible

When the governed truth batch that seeds a candidate's `regression_golden`
revision shares exact items with the candidate's optimization-run training
or selection revisions, candidate creation appends an `exact_overlap`
exposure between the regression revision and the optimization run and the
lifecycle projection labels the regression run **development-overlapping**.
The activation rule is unchanged in this proposal, because sealed
calibration is the independent check under ADR-0007 and ADR-0009. Whether
overlap should instead block activation is open question 3.

### 7. Goodhart guard

Stage B refuses to run when the selection revision has fewer resolved items
than a project-level minimum. The proposed default minimum is 100, labelled
`ASSUMPTION`, to be revised from Stage A experience. The gate metric is the
exact-agreement rate, stated in the run record. Candidate acceptance inside
the loop is development feedback only; decision 5 is the only path to a
version.

### 8. Where it lives

The optimizer runs outside the Rubrist runtime as a separate Python tool
that drives the API over HTTP with an owner session, provisionally under
`tools/evaluator-optimizer/`. SkillOpt is a dependency of that tool, not
vendored into the monorepo. Stage A is native TypeScript in the API and web
app, reusing SkillOpt's failure-analysis prompt design rather than its code.

### Non-goals

- No automatic activation, no automatic candidate creation.
- No optimization of typed-question, scalar or categorical evaluators.
- No access to sealed revisions for any purpose, including a final test.
- No semantic clustering of traces or failures. SkillOpt's aggregation
  stage merges proposed edits, not cases; this record relies on that
  reading, labelled `ASSUMPTION`.
- SkillOpt-Sleep (coding-agent transcript harvesting) is out of scope.

## Alternatives considered

- **Throwaway versions through the legacy create route**, one per
  candidate, in a disposable project. Workable as a spike under ADR-0011,
  rejected as product: it pollutes the lineage, enqueues a regression gate
  per candidate, and leaves hundreds of immutable versions behind.
- **Let SkillOpt's own chat backend call the judge model directly.**
  Rejected: the tuned rubric would target SkillOpt's wrapper, not Rubrist's
  verdict protocol, violating ADR-0014's premise.
- **A native TypeScript optimizer instead of SkillOpt.** Deferred. SkillOpt
  is the hypothesis to test first; if Stage B proves valuable, re-implementing
  the loop natively can be a later decision.
- **Automatic candidate creation when the optimizer's gate accepts.**
  Rejected: it would move an ungoverned score into the governed path.
- **Treat optimizer agreement as calibration evidence.** Rejected: it is
  measured on exposed development data by an ungoverned procedure.

## Consequences

- A quality owner can turn disagreement cases into concrete rubric edits
  faster, with every rollout and every label export recorded as exposure.
- Optimized definitions reach governance only through the existing
  candidate, regression and sealed-calibration path, and carry provenance
  that names the run that produced them.
- Rubrist gains one new append-only table and one owner-only execution
  endpoint whose outputs are never evidence.
- The regression run's independence becomes visible rather than assumed.
- Each Stage B run costs roughly (batch size plus selection size) judge
  calls per step plus optimizer calls, across every step and epoch. The
  per-project budget makes that cost explicit.
- Sealed revisions are untouched by construction, so ADR-0009's reuse
  barrier is not triggered by optimization itself.

## Open questions for the founder

1. Is optimizer-assisted development in Rubrist's scope at all, or does it
   belong in a separate tool with no runtime support?
2. Authorize Stage A only, or both stages with Stage B gated as proposed?
3. Should a development-overlapping regression run block activation, or
   only be labelled, as decision 6 proposes?
4. The Stage B minimum selection size (proposed 100) and the per-project
   call budget default.
5. Whether `development_provenance` should be a column on `skill_versions`
   or a separate append-only link table.
6. Where the Python tool lives: `tools/evaluator-optimizer/` in this
   repository, or its own repository.
