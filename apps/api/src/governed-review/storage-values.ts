import { createHash } from "node:crypto";

/** Stable governed artifact identity, shared by storage backends. */
export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 48)}`;
}

export const ALLOWED_LABELS = ["pass", "fail", "cannot_determine"] as const;

export const MAX_BLIND_VIEW_BYTES = 2 * 1024 * 1024;

export function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}
