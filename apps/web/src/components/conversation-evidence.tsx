import { type ReactNode } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { additionalFields, conversationEvidence, evidenceObject, evidenceText, messageRole } from "../lib/trace-evidence.js";

import { formattedRecordedJson, losslessJson, isRecordedTrajectory, messageGroups, type messageEvidence } from "../lib/message-evidence.js";

import { EvidenceTruncationWarning } from "./evidence-truncation-warning.js";

const TEXT = "whitespace-pre-wrap [overflow-wrap:anywhere] text-[13px] leading-6 text-ink-2";
const JSON_TEXT = "max-h-[420px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-sm bg-card-2 p-3 font-mono text-[11.5px] leading-5";

function RawValue({ value }: { value: unknown }) {
  return <pre className={JSON_TEXT}>{evidenceText(value)}</pre>;
}

// Source text is never interpreted as HTML or loaded as remote media.
function Content({ value }: { value: unknown }) {
  if (typeof value === "string") return <p className={TEXT}>{value.length ? value : <em>Empty text</em>}</p>;
  if (Array.isArray(value) && value.length > 0) return <div className="space-y-3">{value.map((part, index) => {
    const block = evidenceObject(part);
    return block?.type === "text" && typeof block.text === "string" && Object.keys(block).every(key => key === "type" || key === "text")
      ? <p key={index} className={TEXT}>{block.text || <em>Empty text</em>}</p>
      : <div key={index}><p className="mb-1 text-[11px] text-ink-3">Content block {index + 1} · recorded data</p><RawValue value={part} /></div>;
  })}</div>;
  return <RawValue value={value} />;
}

function Source({ path, value }: { path: string; value: unknown }) {
  return <details className="mt-2 text-[11px] text-ink-3">
    <summary className="cursor-pointer">Source details</summary>
    <code className="my-2 block [overflow-wrap:anywhere]">{path}</code>
    <RawValue value={value} />
  </details>;
}

function ExtraFields({ record, known, path }: { record: Record<string, unknown>; known: string[]; path: string }) {
  const extra = additionalFields(record, known);
  return Object.keys(extra).length > 0 ? <details className="rounded-sm border border-rule-soft p-3">
    <summary className="cursor-pointer text-[12px] font-medium">Additional recorded fields · {Object.keys(extra).join(", ")}</summary>
    <p className="my-2 text-[11px] text-ink-3 [overflow-wrap:anywhere]">{path}</p>
    <RawValue value={extra} />
  </details> : null;
}

function ToolCalls({ value }: { value: unknown }) {
  if (!Array.isArray(value) || value.length === 0) return <RawValue value={value} />;
  return <div className="space-y-3">{value.map((call, index) => {
    const record = evidenceObject(call), fn = evidenceObject(record?.function);
    return fn && typeof fn.name === "string" ? <div key={index}>
      <p className="font-mono text-[13px] font-semibold [overflow-wrap:anywhere]">{fn.name}</p>
      <div className="mt-1"><RawValue value={fn.arguments} /></div>
      <ExtraFields record={record!} known={["function", "id", "type"]} path={`tool_calls[${index}]`} />
      <ExtraFields record={fn} known={["name", "arguments"]} path={`tool_calls[${index}].function`} />
    </div> : <RawValue key={index} value={call} />;
  })}</div>;
}

function ToolResult({ value, imported }: { value: unknown; imported: boolean }) {
  let record = evidenceObject(value);
  if (imported && typeof value === "string") {
    record = evidenceObject(losslessJson(value));
    if (!record) {
      const formatted = formattedRecordedJson(value);
      return formatted === null ? <Content value={value} /> : <RawValue value={formatted} />;
    }
  }
  if (!record || Object.keys(record).length === 0) return <Content value={value} />;
  return <dl className="text-[12px] leading-5">{Object.entries(record).map(([key, item]) => <div key={key} className="grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-3 border-b border-rule-soft py-1.5 last:border-0">
    <dt className="font-mono text-ink-3 [overflow-wrap:anywhere]">{key}</dt>
    <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{evidenceText(item)}</dd>
  </div>)}</dl>;
}

function Message({ entry, targetPrefix, selectedIndex, selectionOrigin }: {
  entry: ReturnType<typeof messageEvidence> & { value: unknown; index: number };
  targetPrefix: string; selectedIndex?: number | null; selectionOrigin?: "evaluator" | "navigation" | undefined;
}) {
  const { record, content, calls, name, sourceIndex, index, value } = entry;
  const path = `input.messages[${index}]`;
  const role = messageRole(record?.role);
  const known = role !== "Unrecognized message" && record !== null && (Object.hasOwn(record, "content") || calls !== undefined);
  const tool = role === "Tool" || role === "Function";
  const selected = selectedIndex === index;
  const recordedError = tool && typeof content === "string" && content.startsWith("Error:");
  const heading = `${sourceIndex !== null ? `Message ${sourceIndex}` : `Entry ${index + 1}`} · ${role}${name ? ` · ${name}` : ""}`;
  const body = <>
    {calls !== undefined ? <div><p className="mb-2 text-[11px] font-medium text-ink-3">Recorded tool calls</p><ToolCalls value={calls} /></div> : null}
    {known ? (calls !== undefined && (content === "" || content === null || content === undefined) ? null : tool ? <ToolResult value={content} imported={sourceIndex !== null} /> : <Content value={content} />) : <RawValue value={value} />}
    {known ? <ExtraFields record={record} known={["role", "content", "tool_calls", "name", "tool_call_id"]} path={path} /> : null}
    <Source path={path} value={value} />
  </>;
  return <section id={`${targetPrefix}-${index}`} tabIndex={-1} data-message-index={index}
    className={`min-w-0 scroll-mt-48 xl:scroll-mt-24 rounded-sm border-l-2 p-3 focus-visible:outline-2 focus-visible:outline-offset-2 ${selected ? "border-amber-600 bg-amber-50 dark:border-amber-400 dark:bg-amber-950/30" : recordedError ? "border-red-300 bg-red-50/60 dark:border-red-800 dark:bg-red-950/20" : tool ? "border-rule-strong bg-card-2" : "border-rule-soft"}`}>
    {selected ? <p className="mb-2 text-[11px] font-medium text-amber-900 dark:text-amber-200">{selectionOrigin === "navigation" ? "Selected message" : "Referenced by the evaluator · check its interpretation"}</p> : null}
    {role === "System" || role === "Developer" ? <details>
      <summary className="cursor-pointer text-[12px] font-semibold">{heading} · instructions</summary>
      <div className="mt-3 space-y-2">{body}</div>
    </details> : <>
      <h4 className="mb-2 text-[12px] font-semibold [overflow-wrap:anywhere]">{heading}{tool ? " · response" : ""}</h4>
      <div className="space-y-2">{body}</div>
    </>}
  </section>;
}

function AvailableTools({ value }: { value: unknown }) {
  return <details className="rounded-sm border border-rule-soft p-3">
    <summary className="cursor-pointer text-[12px] font-medium">Available tools{Array.isArray(value) ? ` · ${value.length} recorded definitions` : " · recorded data"}</summary>
    <div className="mt-3 space-y-2">{Array.isArray(value) ? value.map((tool, index) => {
      const record = evidenceObject(tool), fn = evidenceObject(record?.function);
      const name = fn?.name ?? record?.name;
      return <details key={index} className="border-t border-rule-soft pt-2">
        <summary className="cursor-pointer font-mono text-[12px] [overflow-wrap:anywhere]">{typeof name === "string" ? name : `Definition ${index + 1}`}</summary>
        <RawValue value={tool} />
      </details>;
    }) : <RawValue value={value} />}</div>
  </details>;
}

function PreviewTurn({ value, index }: { value: unknown; index: number }) {
  const record = evidenceObject(value);
  const path = `input.precedingTurns[${index}]`;
  if (!record) return <section><p>Unrecognized context entry {index + 1}</p><RawValue value={value} /><Source path={path} value={value} /></section>;
  return <section className="space-y-3 border-b border-rule-soft pb-4">
    <h4 className="text-[12px] font-semibold">Earlier turn · {typeof record.turnIndex === "number" ? `source index ${record.turnIndex}` : `entry ${index + 1}`}</h4>
    <div><p className="mb-1 text-[11px] font-semibold text-ink-3">User · preview</p><Content value={record.userMessagePreview} /></div>
    {Array.isArray(record.toolCallsInSourceOrder) ? record.toolCallsInSourceOrder.map((tool, toolIndex) => {
      const fields = evidenceObject(tool);
      return <details key={toolIndex} className="rounded-sm border border-rule-soft p-3">
        <summary className="cursor-pointer text-[12px] font-medium">Tool {toolIndex + 1} · {typeof fields?.name === "string" ? fields.name : "unnamed"}{typeof fields?.status === "string" ? ` · ${fields.status}` : ""} · preview</summary>
        <div className="mt-3 space-y-3">
          {fields ? <><div><p className="text-[11px] font-semibold">Input preview</p><Content value={fields.inputPreview} /></div><div><p className="text-[11px] font-semibold">Output preview</p><Content value={fields.outputPreview} /></div>
            <ExtraFields record={fields} known={["name", "inputPreview", "outputPreview"]} path={`${path}.toolCallsInSourceOrder[${toolIndex}]`} /></> : <RawValue value={tool} />}
          <Source path={`${path}.toolCallsInSourceOrder[${toolIndex}]`} value={tool} />
        </div>
      </details>;
    }) : <RawValue value={record.toolCallsInSourceOrder} />}
    <div><p className="mb-1 text-[11px] font-semibold text-ink-3">Assistant · preview</p><Content value={record.assistantResponsePreview} /></div>
    <ExtraFields record={record} known={["turnIndex", "userMessagePreview", "toolCallsInSourceOrder", "assistantResponsePreview"]} path={path} />
    <Source path={path} value={value} />
  </section>;
}

export function ConversationEvidence({ input, output, steps, trajectory, metadata, targetPrefix = "conversation-message", selectedIndex, selectionOrigin }: {
  input: unknown; output: unknown; steps?: unknown; trajectory?: ReactNode; metadata?: unknown; targetPrefix?: string; selectedIndex?: number | null; selectionOrigin?: "evaluator" | "navigation" | undefined;
}) {
  const projection = conversationEvidence(input);
  const wholeTrajectory = projection?.kind === "messages" && isRecordedTrajectory(input, metadata);
  const preview = projection?.kind === "preview";
  return <Card className="min-w-0">
    <CardHeader><div className="min-w-0">
      <CardTitle>{projection ? "Conversation" : "Case evidence"}</CardTitle>
      <CardDescription>{projection ? "Read messages and tool responses in recorded order. Source details retain the original fields." : "Recorded input and output. No conversation structure is assumed."}</CardDescription>
    </div></CardHeader>
    <CardContent className={`min-w-0 space-y-5 ${projection?.kind === "messages" ? "xl:max-h-[70vh] xl:overflow-y-auto" : ""}`}>
      <EvidenceTruncationWarning input={input} output={output} steps={steps} />
      {preview ? <aside className="rounded-sm border border-amber-300 bg-amber-50 p-3 text-[12px] leading-5 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
        <p className="font-semibold">Preview-only evidence</p>
        <p>Messages and tool results may be clipped. Missing content is not evidence of failure.</p>
        {typeof projection.record.evidenceLimitations === "string" ? <details className="mt-2"><summary className="cursor-pointer">Recorded source limitations</summary><p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{projection.record.evidenceLimitations}</p></details> : null}
      </aside> : null}
      {projection?.kind === "messages" ? <section className="space-y-4" aria-label="Conversation context">
        <h3 className="text-[13px] font-semibold">{wholeTrajectory ? "Whole conversation" : "Conversation context"} · {projection.messages.length} recorded messages</h3>
        {wholeTrajectory ? <p className="text-[12px] text-ink-3">Assessment scope: the entire recorded trajectory. Message numbers follow the source, starting at 0.</p> : null}
        {Object.hasOwn(projection.record, "availableTools") ? <AvailableTools value={projection.record.availableTools} /> : null}
        <div className="space-y-4">{messageGroups(projection.messages, wholeTrajectory).map(group => <div key={group[0]!.index}
          className={group.length > 1 ? "space-y-1 rounded-sm border border-rule-soft p-1" : ""}>
          {group.map(entry => <Message key={entry.index} entry={entry} targetPrefix={targetPrefix} selectedIndex={selectedIndex ?? null} selectionOrigin={selectionOrigin} />)}
        </div>)}</div>
        <ExtraFields record={projection.record} known={["messages", "availableTools", ...(wholeTrajectory ? ["assessmentScope"] : [])]} path="input" />
      </section> : preview ? <>
        {projection.turns.length > 0 ? <details className="rounded-sm border border-rule-soft p-3">
          <summary className="cursor-pointer text-[12px] font-medium">Earlier context · {projection.turns.length} recorded {projection.turns.length === 1 ? "turn" : "turns"}</summary>
          <div className="mt-4 space-y-4">{projection.turns.map((turn, index) => <PreviewTurn key={index} value={turn} index={index} />)}</div>
        </details> : null}
        <section><h3 className="mb-2 text-[13px] font-semibold">Request for this response · preview</h3><Content value={projection.request} /><Source path="input.userRequestPreview" value={projection.request} /></section>
        <ExtraFields record={projection.record} known={["precedingTurns", "userRequestPreview", ...(typeof projection.record.evidenceLimitations === "string" ? ["evidenceLimitations"] : [])]} path="input" />
      </> : <section><h3 className="mb-2 text-[13px] font-semibold">Input</h3><Content value={input} /></section>}
      {trajectory}
      {wholeTrajectory ? <details className="rounded-sm border border-rule-soft p-3" aria-label="Recorded output">
        <summary className="cursor-pointer text-[12px] font-medium">Source output field</summary>
        <p className="my-3 text-[12px] text-ink-3">The import records this separately as its source answer. The assessment covers the entire conversation above; this field does not identify its final message.</p>
        <Content value={output} /><Source path="output" value={output} />
      </details> : (
      <section className="min-w-0 rounded-sm border-l-4 border-ink bg-card-2 p-4" aria-label="Recorded output">
        <h3 className="mb-1 text-[14px] font-semibold">{preview ? "Response being assessed · preview" : "Recorded output · this case"}</h3>
        <p className="mb-3 text-[12px] text-ink-3">{preview ? "Earlier assistant replies above are context. This is the response captured for this case." : "Shown separately from context. The evaluator can assess the full case, including supplied steps."}</p>
        <Content value={output} />
        <Source path="output" value={output} />
      </section>
      )}
      <details className="border-t border-rule-soft pt-3">
        <summary className="cursor-pointer text-[12px] text-ink-3">Raw recorded input, output and steps</summary>
        <div className="mt-2"><RawValue value={{ input, output, ...(steps !== undefined ? { steps } : {}) }} /></div>
      </details>
    </CardContent>
  </Card>;
}
