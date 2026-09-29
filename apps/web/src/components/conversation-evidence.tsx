import { useState, type ReactNode } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { additionalFields, conversationEvidence, evidenceObject, evidenceText, messageRole } from "../lib/trace-evidence.js";

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

function Message({ value, path }: { value: unknown; path: string }) {
  const record = evidenceObject(value);
  const role = messageRole(record?.role);
  const known = role !== "Unrecognized message" && record !== null && Object.hasOwn(record, "content");
  const body = <>
    {known ? <Content value={record.content} /> : <RawValue value={value} />}
    {known ? <ExtraFields record={record} known={["role", "content"]} path={path} /> : null}
    <Source path={path} value={value} />
  </>;
  return role === "Tool" || role === "Function" ? <details className="rounded-sm border border-rule-soft p-3">
    <summary className="cursor-pointer text-[12px] font-medium">{role}{typeof record?.name === "string" ? ` · ${record.name}` : ""}</summary>
    <div className="mt-3 space-y-2">{body}</div>
  </details> : <section className={`min-w-0 border-l-2 pl-3 ${role === "Assistant" ? "border-rule-strong" : "border-rule-soft"}`}>
    <h4 className="mb-2 text-[12px] font-semibold">{role}</h4>
    <div className="space-y-2">{body}</div>
  </section>;
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

export function ConversationEvidence({ input, output, steps, trajectory }: {
  input: unknown; output: unknown; steps?: unknown; trajectory?: ReactNode;
}) {
  const projection = conversationEvidence(input);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const earlierCount = projection?.kind === "messages" ? Math.max(0, projection.messages.length - 6) : 0;
  const preview = projection?.kind === "preview";
  return <Card className="min-w-0">
    <CardHeader><div className="min-w-0">
      <CardTitle>{projection ? "Conversation" : "Case evidence"}</CardTitle>
      <CardDescription>{projection ? "Recorded context, followed by this case’s output. Expand source details to inspect the original fields." : "Recorded input and output. No conversation structure is assumed."}</CardDescription>
    </div></CardHeader>
    <CardContent className="min-w-0 space-y-5">
      {preview ? <aside className="rounded-sm border border-amber-300 bg-amber-50 p-3 text-[12px] leading-5 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
        <p className="font-semibold">Preview-only evidence</p>
        <p>Messages and tool results may be clipped. Missing content is not evidence of failure.</p>
        {typeof projection.record.evidenceLimitations === "string" ? <details className="mt-2"><summary className="cursor-pointer">Recorded source limitations</summary><p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{projection.record.evidenceLimitations}</p></details> : null}
      </aside> : null}
      {projection?.kind === "messages" ? <section className="space-y-4" aria-label="Conversation context">
        <h3 className="text-[13px] font-semibold">Conversation context · {projection.messages.length} recorded entries</h3>
        {earlierCount > 0 ? <div>
          <button type="button" aria-expanded={earlierOpen} onClick={() => setEarlierOpen(!earlierOpen)} className="cursor-pointer rounded-sm border border-rule-soft px-3 py-2 text-[12px] hover:bg-card-2">{earlierOpen ? "Hide" : "Show"} {earlierCount} earlier entries</button>
          {earlierOpen ? <div className="mt-4 space-y-4">{projection.messages.slice(0, earlierCount).map((message, index) => <Message key={index} value={message} path={`input.messages[${index}]`} />)}</div> : null}
        </div> : null}
        {projection.messages.slice(earlierCount).map((message, index) => <Message key={earlierCount + index} value={message} path={`input.messages[${earlierCount + index}]`} />)}
        <ExtraFields record={projection.record} known={["messages"]} path="input" />
      </section> : preview ? <>
        {projection.turns.length > 0 ? <details className="rounded-sm border border-rule-soft p-3">
          <summary className="cursor-pointer text-[12px] font-medium">Earlier context · {projection.turns.length} recorded {projection.turns.length === 1 ? "turn" : "turns"}</summary>
          <div className="mt-4 space-y-4">{projection.turns.map((turn, index) => <PreviewTurn key={index} value={turn} index={index} />)}</div>
        </details> : null}
        <section><h3 className="mb-2 text-[13px] font-semibold">Request for this response · preview</h3><Content value={projection.request} /><Source path="input.userRequestPreview" value={projection.request} /></section>
        <ExtraFields record={projection.record} known={["precedingTurns", "userRequestPreview", ...(typeof projection.record.evidenceLimitations === "string" ? ["evidenceLimitations"] : [])]} path="input" />
      </> : <section><h3 className="mb-2 text-[13px] font-semibold">Input</h3><Content value={input} /></section>}
      {trajectory}
      <section className="min-w-0 rounded-sm border-l-4 border-ink bg-card-2 p-4" aria-label="Recorded output">
        <h3 className="mb-1 text-[14px] font-semibold">{preview ? "Response being assessed · preview" : "Recorded output · this case"}</h3>
        <p className="mb-3 text-[12px] text-ink-3">{preview ? "Earlier assistant replies above are context. This is the response captured for this case." : "Shown separately from context. The evaluator can assess the full case, including supplied steps."}</p>
        <Content value={output} />
        <Source path="output" value={output} />
      </section>
      <details className="border-t border-rule-soft pt-3">
        <summary className="cursor-pointer text-[12px] text-ink-3">Raw recorded input, output and steps</summary>
        <div className="mt-2"><RawValue value={{ input, output, ...(steps !== undefined ? { steps } : {}) }} /></div>
      </details>
    </CardContent>
  </Card>;
}
