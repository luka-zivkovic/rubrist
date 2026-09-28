# Single workspace and navigation

Scope authorized by the founder on 2026-09-28: consolidate workspace displays
and clarify the sidebar. The vocabulary mapping and help-preference design in
proposed ADR-0015 remain deferred; this slice does not accept that ADR wholesale.
Settings refactoring is a separate batch.

## Behavior contract

TARGET: one navigation and action surface independent of browser display
preferences. Role permissions and the separation of governed human truth from
operational review remain binding under PRODUCT.md and ADR-0008/0013.

CURRENT before this change: Guided/Technical/Summary filter routes and raw
metadata. Bench projects omit saved review sessions even in Technical display.
The display selector is repeated in the sidebar and header.

| Input/state | Required result / positive fixture | Negative fixture |
| --- | --- | --- |
| No `rubrist.mode`, pm, dev, exec, or invalid value | Same navigation and Overview action | No hidden destinations or display selector |
| Bench project | Examples & runs and Review sessions available | No live-trace feed substituted for dataset entry |
| Tracing project | Live traces, Saved datasets, and Review sessions available | No loss of existing destinations |
| Saved review session detail | Review sessions active; criterion retained in links | Needs a human not falsely selected |
| Member/owner | Same navigation; existing authorization controls unchanged | Display preference cannot grant privileges |
| Assigned governed reviewer | Existing restricted review layout | No evaluator payload added to blind review |
| Technical payload present | Expandable request/response, initially collapsed | No globally enabled Technical display needed |
| Raw identifiers | Local disclosure, keyboard operable | No IDs dominating main reading flow |
| Mobile navigation | Existing inert background, Escape, close-on-navigation | No second navigation inventory |

CURRENT implementation in this batch: neutral workflow groups replace numbered
sidebar completion markers; Overview retains its existing onboarding and next
steps. Evaluator navigation, known-failure references, governed lifecycle and
ungoverned diagnostics remain distinct. Stored display preferences are ignored;
project evidence-source and demo/Postgres runtime modes are unchanged. Routes,
query pins, API contracts, evaluator selection, and stored evidence are unchanged.

Validation: rendered navigation fixtures, disclosure interaction tests, existing
route/role/mobile checks, full local tests, typecheck/build/repository guards,
independent diff review, and browser inspection. Hosted verification preserves
all saved queues, evaluator pins and human reviews. No migration or model call
is required.

## Verification record

CURRENT verification (2026-09-28): 1,939 local tests passed, with 159
database-backed tests reserved for CI; 34 tool checks passed. Typecheck, build,
repository boundaries and shared-contract checks passed. The large-file report
retains four pre-existing review entries. A real-browser mobile check verified
drawer navigation, inert background, Escape focus restoration, active saved
session links, and no horizontal overflow at 390px. Browser reloads with every
historical display preference produced identical navigation. Desktop native
Brave inspection verified Overview and the saved review destination. Independent
review found and resolved identifier-click propagation into row navigation.
