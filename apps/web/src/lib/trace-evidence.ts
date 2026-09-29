// Display-only projections. Never parse stringified JSON, infer missing roles,
// sort source records, or pick an assessment target from the last message.
export function evidenceObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function evidenceText(value: unknown): string {
  if (value === undefined) return "Not recorded";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "Not recorded";
}

export function additionalFields(record: Record<string, unknown>, known: string[]) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !known.includes(key)));
}

export function conversationEvidence(input: unknown) {
  const record = evidenceObject(input);
  if (!record) return null;
  // This is the explicit preview format used by the existing LangTracer pilot.
  // Its limitations travel with the evidence, not a guessed source identity.
  if (typeof record.userRequestPreview === "string" && Array.isArray(record.precedingTurns)) {
    return { kind: "preview" as const, record, turns: record.precedingTurns, request: record.userRequestPreview };
  }
  if (Array.isArray(record.messages) && record.messages.length > 0) {
    return { kind: "messages" as const, record, messages: record.messages };
  }
  return null;
}

const ROLES: Record<string, string> = {
  user: "User", assistant: "Assistant", system: "System", developer: "Developer", tool: "Tool", function: "Function"
};
export function messageRole(value: unknown): string {
  return typeof value === "string" && Object.hasOwn(ROLES, value) ? ROLES[value]! : "Unrecognized message";
}
