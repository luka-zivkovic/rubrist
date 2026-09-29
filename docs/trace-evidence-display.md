# Readable recorded case evidence

CURRENT: the ordinary case and review-player evidence pane uses a display-only
projection of stored input/output. This changes no input, assessment, human label,
evaluator version, API contract or stored record. Governed blind-review screens
keep their existing rendering and exposure boundaries.

## Display contract

- A nonempty `input.messages` array is shown in source array order. Known roles
  are displayed literally; malformed entries and unrecognized roles remain
  visible as recorded data. No timestamps are used to reorder messages.
- The last six input entries are initially visible. Earlier entries can be
  expanded together, with their original indices retained. This does not select
  an assessment target or remove evidence from the evaluator.
- The existing LangTracer pilot's explicit `userRequestPreview` /
  `precedingTurns` input shape receives a preview view: earlier turns, current
  request, supplied trajectory and the separately recorded output. Preview-only
  limitations remain prominent; formatting cannot recover clipped content.
- Supplied tool steps remain expandable, with recorded indices, source input /
  output, metadata, evaluator-highlighted failing step and dataset expectations.
  Their display precedes the output; this is not an inferred timing guarantee.
- The recorded case output is always separate from the input history. Generic
  cases make no claim that only the final response is assessed. Unknown input
  shapes are labeled input/output, never invented conversation turns.
- Original field paths and values are available in source details. Additional
  fields are explicitly disclosed. The complete recorded input/output/steps are
  available together as JSON. No stringified payload is guessed into a schema.
- Content is escaped text; HTML, Markdown images and remote attachments are not
  executed or fetched. Non-text content blocks retain their recorded data.
- The existing evidence/claim benchmark view is unchanged. Expansion state resets
  when the review player changes cases.

TARGET boundary: preserve exact recorded evidence, distinguish context from the
captured output, and keep missing evidence explicit. This UI does not repair
source completeness, infer human truth or implement Jev cascade.

Validation covers malformed/mixed messages, missing/null/empty values, multimodal
blocks, hostile markup, long histories, preview/source order, extra fields,
output separation, disclosure behavior, existing review attribution and WiCE
claim rendering. Browser checks include desktop and narrow-screen use.
