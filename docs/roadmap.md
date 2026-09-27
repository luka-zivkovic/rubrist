# Roadmap: open work

Status: **open-work register**, last reviewed 2026-09-27.

This file lists work that is known and not done. It is not product
authority: `PRODUCT.md` and accepted ADRs define intent, and
[implementation batches](implementation-batches.md) track delivery. Each item
is labelled:

- **TARGET**: an accepted ADR requires it and it isn't built yet;
- **PROPOSED**: an idea with a recommended design, which needs a founder
  decision (an ADR) before any work starts;
- **CURRENT gap**: a known limit of what is built, with no decision yet on
  whether to change it.

## 1. Carry the capability check into the resolution record (TARGET)

**Source.** ADR-0014 section 4: "When the author saves, the check's outcomes
become the binding's resolution record."

**Now (CURRENT).** The check records nothing. Resolution after save builds
the record from its own probes (`resolveBinding` in
`apps/api/src/lib/binding-resolution.ts` passes `check: null`).
So resolution repeats probes the check already sent, and the temperature
failure suggestion of decision 12 ("leave temperature unset" or "choose
another value") can't be reached, because a failed record holds only its
confirming probe.

**Design.**
- Keep each check's probes server-side, per project, with the probed model
  (provider, endpoint, model id and version, output token limit, routing)
  and the credential source.
- At resolution after save, pass the project's newest matching check, within
  a short carry window (one hour is the draft's choice), to
  `resolveExecutionBinding`. It already accepts a `check` and keeps only
  probes that describe the saved binding with the same credential source.
- Prune older checks when a project keeps a new one.
- A draft exists (a `CapabilityCheckStore` on `BindingResolutionServices`
  and an `evaluator_capability_checks` table). It must be updated for
  decision 12's probe schema.

**Waiting on.** Approval to finish the draft, which changes the API's
service wiring in `apps/api/src/app.ts` and `apps/api/src/index.ts`.

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

The record feeds the next round. A change is accepted only if it improves the
tasks it targeted and doesn't decline on a held-out set the proposer never
sees.

**What exists (CURRENT).**
- **Rubrist's own evaluators** already have this loop: a trace leads to a
  failure code, a criterion, an evaluator candidate and activation, which
  records the version it replaced, with validation evidence at each step.
- **Dailies' release decision** already works like the paper's acceptance
  gate: it compares a candidate with a baseline per item and can use a held-out
  scope (`sealed_representative_evaluation`).
- **Production monitoring** already groups outcomes by model and question
  set, and flags a model change.
- **Held-out data:** Rubrist's sealed data and exposure accounting are the
  held-out set the proposer never sees.

**Gaps (CURRENT).**
- No live contract records the version of the system under test. Dailies'
  candidate identity covers only how it is invoked (URL or command), so two
  app versions behind one URL look the same.
- No finding has an identity that other products can reference, and nothing
  links a change to the findings it addresses.
- Dailies reports have no id and no history; each run overwrites the last.

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
    - later, production outcomes for that version.
- **Where changes are recorded.**
  - **Git trailers** (`Addresses: <finding id>`) in the customer's commits,
    read by the Dailies GitHub Action. This gives an exact version identity
    at no cost to the author.
  - **Dailies runs** carry the version and the addressed findings, and
    issue a decision id. The verdict comes from the run.
  - **Rubrist** stores the records and shows the history. It records
    Dailies' decisions without making them, which keeps within its charter.
  - **Model changes** are recorded automatically from production monitoring.
  - **Coding agents** read and write the record through Rubrist's MCP
    server, in a second phase.
- **Re-running a changed app.** Rubrist can't replay one; Dailies can.
  Failing trace tests become Dailies inputs keyed by their trace-test id, so a
  run on a new commit re-checks exactly those cases.
- **Evaluators too.** The same records cover Rubrist's own evaluators, with
  "evaluator" as the component. That also needs an explicit parent version,
  since today the predecessor is chosen by creation time.

**Timing.** Dailies' formats restarted at v1 for launch (Dailies ADR-0010).
Adding the version, addressed findings, and a decision id to its
configuration and report before launch avoids a v2 afterwards.

**Waiting on.** Founder decisions, recorded as ADRs in Rubrist and Dailies:
- ownership, recommended as Rubrist storing the records with Dailies feeding
  them;
- the first phase, recommended as:
  - finding ids in Rubrist;
  - version, addressed findings, and decision id in Dailies v1;
  - git trailers through the Dailies Action;
  - a history view in Rubrist;
  - agent tools and evaluator changes second.

## 3. Live OpenRouter exit-gate checks (CURRENT gap)

**Source.** The Batch 8 exit gate: "A `claude-opus-5-5`, `claude-sonnet-5`,
and OpenRouter binding each resolve, judge, and run sealed calibration with
one physical call per item."

**Now.**
- The Claude and TypeSafe bindings passed live on 2026-09-27.
- OpenRouter is covered only by tests that stub it. No test runs a
  successful OpenRouter resolution or sealed calibration end to end.
- Fireworks, used through the `custom` provider, reaches many of the same
  open models but doesn't satisfy this bullet.

**Waiting on.** OpenRouter credits. The exit-gate harness and
`tools/temperature-study.mjs` can then run OpenRouter targets.

## 4. Which hosts a custom endpoint may name (CURRENT gap)

**Now.** A custom endpoint may name any http(s) host. A capability check or
call sends the project's key to the URL the owner names, as the saved
binding's calls would. Nothing restricts private or internal addresses.

**Waiting on.** A decision on an allow or deny policy for custom endpoint
hosts, for example refusing private networks in hosted deployments.

## 5. Smaller known gaps (CURRENT)

- **Capability reads aren't counted.** Every resolution and re-check also
  reads the provider's published capabilities once (`GET /v1/models/...`).
  ADR-0014's call counts cover probes only. The read isn't recorded as a
  probe; only its snapshot digest is kept.
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
  ADR-0008 selection provenance ([implementation batches](implementation-batches.md));
- ADR-0013's follow-ups: drift and model-change notifications, Ironside
  ingest, and governed-review routing of production samples;
- `choice` and `score` typed questions, which wait for ADR-0004 categorical
  and scalar calibration;
- the comparative benchmarks' owners, sampling, and stopping rules (decision
  gate 5).
