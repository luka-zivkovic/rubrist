# Editor protection: C2, C3, C13

Status: **CURRENT implementation**, bounded portion of UX slice 2. This does
not accept ADR-0015 or complete O12/O14, which still depend on G1.

- The ordinary evaluator editor keeps the provider, model ID, model version,
  settings, and custom endpoint it loaded, including when credentials are
  unavailable or a catalog read fails. Catalog reads cannot replace a saved
  model version. The unavailable provider is visible and blocks saving; the
  owner may add credentials in Settings or explicitly choose another provider
  and model. Reset preserves the saved binding too.
- Raw draft fields are compared with the opened form, including invalid input.
  Router navigation, reset, and template replacement ask before discarding
  changes. Reload/close uses the browser's unload warning. Failed saves retain
  the draft and protection; a successful recorded save clears it before
  navigating to its exact version. The whole editor is disabled during the
  create request so later typing cannot be discarded by an earlier receipt.
  Returning from a recorded result to its clean editor does not ask to discard.
  Reverting every changed field is clean.
- Members get a read-only entry point on all six previously ungated surfaces.
  A direct editor URL explains that an owner must save and links to the saved
  evaluator. It does not offer editable fields, capability checks, or overrides.
  Saving also checks the currently loaded owner role.

## Validation and remaining boundaries

Rendered interaction tests exercise the editor state with a real data router:
missing credentials, custom endpoint preservation, changed/empty/failed catalogs,
explicit model selection, member access, canceled and confirmed discards,
invalid draft reload warnings, reverting edits, failed/successful saves, a
deferred save with controls disabled, and blocked-result return to editing.
Provider calls are mocked; these tests do not consume model requests.

Discard confirmation currently uses the native browser confirmation dialog.
The planned styled Radix alert dialog is not added in this bounded fix. Browser
unload warnings are subject to browser interaction requirements. This is not
persistent draft recovery after a crash. First-run onboarding retains its
existing saved-draft and initial provider-selection behavior.

The member URL shows an explanation and a link to the saved evaluator rather
than duplicating that read-only page inside the editor. Existing vocabulary
and display modes remain unchanged. Full-suite validation and independent
review are recorded by the integrating batch; this change makes no claim
that all of slice 2 or the overall UX plan is complete.
