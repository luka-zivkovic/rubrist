# Readable recorded case evidence

CURRENT: the ordinary case and review-player evidence pane uses a display-only
projection of stored input/output. This changes no input, assessment, human label,
evaluator version, API contract or stored record. Governed blind-review screens
keep their existing rendering and exposure boundaries.

## Display contract

- A nonempty `input.messages` array is shown in source array order. Known roles
  are displayed literally; malformed entries and unrecognized roles remain
  visible as recorded data. No timestamps are used to reorder messages.
- All messages are visible in chronological source order, with entry numbers.
  System/developer instructions remain expandable. Tool responses are visible
  alongside their calls; only unique matching call IDs in adjacent entries are
  grouped. Missing or ambiguous pairings remain independent entries. On wide
  screens the conversation scrolls within its panel, keeping the assessment
  and review actions beside it.
- The existing LangTracer pilot's explicit `userRequestPreview` /
  `precedingTurns` input shape receives a preview view: earlier turns, current
  request, supplied trajectory and the separately recorded output. Preview-only
  limitations remain prominent; formatting cannot recover clipped content.
- Supplied tool steps remain expandable, with recorded indices, source input /
  output, metadata, evaluator-highlighted failing step and dataset expectations.
  Their display precedes the output; this is not an inferred timing guarantee.
- The recorded case output is retained separately from the input history. Generic
  cases make no claim that only the final response is assessed. Unknown input
  shapes are labeled input/output, never invented conversation turns.
- Original field paths and values are available in source details. Additional
  fields are explicitly disclosed. The complete recorded input/output/steps are
  available together as JSON. No arbitrary stringified payload is guessed into
  a schema. The explicit AgentProcessBench import encodings (whole-trajectory/v1
  and whole-trajectory-v2-lossless-text-blocks) have a bounded display adapter:
  the exact assessmentScope must also match; source prefixes must agree with
  array index and role. Ordered pure text blocks reconstruct the imported text,
  and validated imported tool-call arrays get a readable function/arguments
  display only when JSON round-trips losslessly (ignoring whitespace outside
  strings). Imported tool-result objects use a field list under the same guard;
  otherwise valid JSON gets whitespace-only formatting of its original tokens.
  Duplicate keys, unsafe numbers and numeric spelling are never normalized away.
  Malformed or unknown source content stays literal.
- Only that explicit whole-trajectory import displays “Whole conversation” and
  places its separate source answer in an expandable source-output section.
  No final assistant response is inferred from the last message.
- Singular “message N” references in assessment prose link only to an explicitly
  recorded source index. Unresolved references remain plain text. Clicking opens
  referenced instructions if needed, focuses the message and highlights it as
  an evaluator reference, not a verified failure. The saved rationale is not
  rewritten or augmented with generated findings. Generic entry numbering does
  not establish the numbering convention intended by an evaluator.
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
