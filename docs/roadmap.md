# Roadmap: open work

Status: **open-work register**, last reviewed 2026-09-27.

This file lists work that is known and not done. It is not product
authority: `PRODUCT.md` and accepted ADRs define intent, and
[implementation batches](implementation-batches.md) track delivery. Each item
is labelled:

- **TARGET**: an accepted ADR, or a batch exit gate under one, requires it
  and it isn't built or verified yet;
- **PROPOSED**: an idea with a recommended design and no ADR yet. It needs a
  founder decision (an ADR, and a charter change where the item says so)
  before any work starts;
- **CURRENT gap**: a known limit of what is built, with no decision yet on
  whether to change it.

## 1. Carry the capability check into the resolution record (implemented; verification in progress)

**Source.** ADR-0014 section 4: "When the author saves, the check's outcomes
become the binding's resolution record."

**Now (CURRENT).** Authoring checks are retained server-side for one hour.
Resolution carries compatible probes into its record and still sends the
exact saved request for confirmation. Matching includes project, provider,
endpoint, model/version, output limit, routing, credential source and a digest
of the actual credential. Rotation invalidates reuse. Governed re-checks still
make fresh calls.

**Design.**
- Keep each check's probes server-side, per project, with the probed model
  (provider, endpoint, model id and version, output token limit, routing)
  and the credential source.
- At resolution after save, pass the project's newest matching check, within
  a short carry window (one hour is the draft's choice), to
  `resolveExecutionBinding`. It already accepts a `check` and keeps only
  probes that describe the saved binding with the same credential source.
- Keep the picker's temperature classifications (`classifyTemperature`)
  with the check they extend, since they answer for reasoning selected after
  it.
- When a project keeps a new check, prune its checks older than the carry
  window.
- The current store supports decision 12 classifications. A new full check
  supersedes older checks; subsequent classifications extend it. Resolution
  selects bounded probes for the saved protocol and temperature's exact
  reasoning/topP, preserving the existing evidence contract limits. Raw check
  history is ephemeral; the resolution is not a total authoring-cost ledger.

**Authorization.** The founder approved the provider/setup completion route
on 2026-09-29. Migration `0004_capability_check_carry.sql` adds the short-lived
store without changing baseline bytes or existing hosted reviews. Delivery
verification is pending; this item does not imply the first-project picker
gap below is closed.

## 2. Close the loop: finding → change → verdict (PROPOSED)

**Idea.** Record which finding led to which change in the system under test,
and whether the change worked, so the next change can learn from the last.
The founder raised it on 2026-09-27, after AutoDesign (arXiv 2608.13560). In
that paper a coding agent improves an agent harness in rounds. Each round
records:
- the harness state, the runs and their scores;
- the one component changed, which keeps credit assignment interpretable;
- the plan;
- whether the change was accepted;
- a snapshot of the code.

The record feeds the next round. A change is accepted only if it improves on
the training tasks and doesn't decline on a held-out development set the
proposer never sees.

**What exists (CURRENT).**
- **Rubrist's own evaluators** already have this loop: a trace leads to a
  failure code, a criterion, an evaluator candidate and activation, which
  records the version it replaced, with validation evidence at each step.
- **Dailies' release decision** already works like the paper's acceptance
  gate: it compares each item's outcome with its declared baseline label and
  can use a held-out scope (`sealed_representative_evaluation`).
- **Production monitoring** already groups outcomes by model and question
  set, and flags a model change.
- **Held-out data:** Rubrist's sealed revisions and exposure history keep
  human truth away from evaluator authors and record every exposure. They
  aren't yet a held-out set for changes to the system under test: Dailies
  reports record dataset revision and exposure as `not_provided`.

**Gaps (CURRENT).**
- No live contract records the version of the system under test as a whole.
  Production decision records carry the model and question set; Dailies'
  candidate identity covers only how it is invoked (URL or command), so two
  app versions behind one URL look the same.
- No finding has an identity that other products can reference, and nothing
  links a change to the findings it addresses.
- Dailies writes each report to a fixed `report.json` with no id; a later
  run in the same output directory replaces it, and Dailies keeps no
  history.

**Recommended design.**
- **Three records.**
  - A **finding**: something observed wrong, with a stable id and a pointer
    to its evidence. Examples: a failing trace test, a failed item, a
    review verdict, a Dailies block, or a Casefile lock drift.
  - A **change**: a new version of the system under test. It records the
    version (a git commit), the component changed (prompt, model, tools,
    code, orchestration, memory, or evaluator), the findings it addresses, a
    short plan, and whether a person or an agent made it.
  - A **verdict**:
    - a re-run of the addressed findings' cases on the new version;
    - a held-out scope;
    - Dailies' decision;
    - later, production outcomes for that version, kept as ungoverned
      feedback and shown apart from the verdicts above.
- **Where changes are recorded.**
  - **Git trailers** (`Addresses: <finding id>`) in the customer's commits,
    read by the Dailies GitHub Action. This gives an exact version identity
    at little cost to the author (ASSUMPTION).
  - **Dailies runs** carry the version and the addressed findings, and
    issue a decision id. The verdict comes from the run.
  - **Rubrist** would store the records and show the history, recording
    Dailies' decisions without making them. Its charter (`PRODUCT.md`)
    lists neither change records for the system under test nor a history of
    release decisions, so this needs a charter amendment as well as ADRs;
    the alternative is Dailies keeping the history.
  - **Model changes** are recorded automatically from production monitoring.
  - **Coding agents** read and write the record through Rubrist's MCP
    server, in a second phase.
- **Re-running a changed app.** Rubrist can't replay one; Dailies can.
  Failing trace tests become Dailies inputs keyed by their trace-test id, so a
  run on a new commit re-checks exactly those cases.
- **Evaluators too.** The same records cover Rubrist's own evaluators, with
  "evaluator" as the component. That also needs an explicit parent version,
  since today the predecessor is chosen by creation time.

**Timing.** Dailies' formats restarted at v1 for launch (Dailies ADR-0008
and ADR-0010).
Adding the version, addressed findings, and a decision id to its
configuration and report before launch avoids a v2 afterwards.

**Waiting on.** Founder decisions, recorded as ADRs in Rubrist and Dailies:
- ownership, recommended as Rubrist storing the records with Dailies feeding
  them, which also needs a `PRODUCT.md` amendment;
- the first phase, recommended as:
  - finding ids in Rubrist;
  - version, addressed findings, and decision id in Dailies v1;
  - git trailers through the Dailies Action;
  - a history view in Rubrist;
  - agent tools and evaluator changes second.

## 3. Live OpenRouter exit-gate checks (TARGET)

**Source.** The Batch 8 exit gate: "A `claude-opus-5-5`, `claude-sonnet-5`,
and OpenRouter binding each resolve, judge, and run sealed calibration with
one physical call per item."

**Now.**
- The Claude and TypeSafe bindings passed live on 2026-09-27.
- OpenRouter is covered only by tests that stub it. No test runs a
  successful OpenRouter resolution or sealed calibration end to end.
- Fireworks, reachable through the `custom` provider, serves many of the
  same open models, but a custom binding doesn't satisfy this bullet.

**Waiting on.** An OpenRouter key with credits. The Batch 8 live checks can
then be repeated for an OpenRouter binding, and `tools/temperature-study.mjs`
can run OpenRouter targets from a targets file.

## 4. Which hosts a custom endpoint may name (CURRENT gap)

**Now.** A custom endpoint may name any http(s) host. A capability check or
call sends the project's key to the URL the owner names, as the saved
binding's calls would. Nothing restricts private or internal addresses.

**Waiting on.** A decision on an allow or deny policy for custom endpoint
hosts, for example refusing private networks in hosted deployments.

## 5. Smaller known gaps (CURRENT)

- **Capability reads aren't counted.** For Anthropic and OpenRouter
  bindings, every resolution and re-check also reads the provider's
  published capabilities once (Anthropic's `GET /v1/models/{id}`,
  OpenRouter's model list). ADR-0014's call counts cover probes only. The
  read isn't recorded as a probe: a resolution keeps only its snapshot
  digest, and a re-check keeps nothing of it.
- **First-project setup has no picker.** If it falls back from the seeded
  provider to another one, temperature starts unset. For a model that lets
  the author choose temperature, a governed gate then asks for a new version
  that states one.
- **The ignored-temperature table rests on documentation.** Its DeepSeek
  entries cite DeepSeek's documentation as read on 2026-09-27. Re-check them,
  and look for new cases, with `tools/temperature-study.mjs`.

## Tracked elsewhere

These are open but have their own records:

- #102, uncertainty selection for governed review, which needs a decision on
  ADR-0008 selection provenance (see
  [implementation batches](implementation-batches.md));
- ADR-0013's follow-ups: drift and model-change notifications, Ironside
  ingest, and governed-review routing of production samples;
- `choice` and `score` typed questions, which wait for ADR-0004 categorical
  and scalar calibration;
- the comparative benchmarks' owners, sampling frames, budgets, and stopping
  rules (decision gate 5).
