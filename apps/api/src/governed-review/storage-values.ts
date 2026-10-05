import { createHash } from "node:crypto";

/** Stable governed artifact identity, shared by storage backends. */
export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 48)}`;
}
