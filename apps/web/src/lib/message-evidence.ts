import { evidenceObject } from "./trace-evidence.js";

// Explicit historical import encodings, never a heuristic for arbitrary JSON text.
const ENCODINGS = new Set([
  "whole-trajectory-v2-lossless-text-blocks",
  "whole-trajectory/v1; all released messages and tools retained; hidden goals, reference labels and annotation notes excluded"
]);
export const WHOLE_TRAJECTORY_SCOPE = "Entire recorded trajectory; output repeats the source final answer.";

export function isRecordedTrajectory(input: unknown, metadata: unknown) {
  return ENCODINGS.has(String(evidenceObject(metadata)?.evidenceProjection))
    && evidenceObject(input)?.assessmentScope === WHOLE_TRAJECTORY_SCOPE;
}

function textBlocks(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const blocks = content.map(evidenceObject);
  return blocks.every(block => block?.type === "text" && typeof block.text === "string"
    && Object.keys(block).every(key => key === "type" || key === "text"))
    ? blocks.map(block => block!.text).join("") : null;
}

export function messageEvidence(value: unknown, index: number, imported: boolean) {
  const record = evidenceObject(value);
  let content = record?.content;
  let calls = record?.tool_calls;
  let name = typeof record?.name === "string" ? record.name : null;
  let callId = typeof record?.tool_call_id === "string" ? record.tool_call_id : null;
  let sourceIndex: number | null = null;
  const text = imported ? textBlocks(content) : null;
  const prefix = text?.match(/^\[source message (0|[1-9]\d*); role=(system|developer|user|assistant|tool|function)(?:; tool=([^;\]\n]+))?(?:; call_id=([^;\]\n]+))?\]\n/);
  if (prefix && Number(prefix[1]) === index && prefix[2] === record?.role) {
    sourceIndex = index;
    content = text!.slice(prefix[0].length);
    name = prefix[3] ?? name;
    callId = prefix[4] ?? callId;
    const marker = "\nRecorded tool calls:\n";
    const split = (content as string).lastIndexOf(marker);
    if (record?.role === "assistant" && calls === undefined && split >= 0) {
      try {
        const parsed: unknown = JSON.parse((content as string).slice(split + marker.length));
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(call => {
          const item = evidenceObject(call), fn = evidenceObject(item?.function);
          return item?.type === "function" && typeof item.id === "string"
            && typeof fn?.name === "string" && typeof fn.arguments === "string";
        })) {
          calls = parsed;
          content = (content as string).slice(0, split);
        }
      } catch { /* Malformed source stays literal text. */ }
    }
  }
  return { record, content, calls, name, callId, sourceIndex };
}

// Pair only an adjacent result with a uniquely identified call. Preserve order,
// and leave missing, duplicate or out-of-order results as independent messages.
export function messageGroups(messages: unknown[], imported: boolean) {
  const entries = messages.map((value, index) => ({ value, index, ...messageEvidence(value, index, imported) }));
  const callCounts = new Map<string, number>(), resultCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.callId !== null) resultCounts.set(entry.callId, (resultCounts.get(entry.callId) ?? 0) + 1);
    for (const call of Array.isArray(entry.calls) ? entry.calls : []) {
      const id = evidenceObject(call)?.id;
      if (typeof id === "string") callCounts.set(id, (callCounts.get(id) ?? 0) + 1);
    }
  }
  const groups: (typeof entries)[] = [];
  for (const entry of entries) {
    const previous = groups.at(-1);
    const call = previous?.[0];
    const matches = call && Array.isArray(call.calls)
      ? call.calls.filter(item => evidenceObject(item)?.id === entry.callId) : [];
    const unique = entry.callId !== null && entry.callId.trim().length > 0 && resultCounts.get(entry.callId) === 1 && callCounts.get(entry.callId) === 1;
    if (previous && call?.record?.role === "assistant" && entry.record?.role === "tool" && matches.length === 1 && unique) previous.push(entry);
    else groups.push([entry]);
  }
  return groups;
}

export function sourceMessageIndices(input: unknown, metadata: unknown): number[] {
  const record = evidenceObject(input);
  if (!isRecordedTrajectory(input, metadata) || !Array.isArray(record?.messages)) return [];
  return record.messages.flatMap((value, index) => messageEvidence(value, index, true).sourceIndex === index ? [index] : []);
}
