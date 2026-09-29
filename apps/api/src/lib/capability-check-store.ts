import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ExecutionBinding } from "@rubrist/shared";
import type { CapabilityCheckResult } from "./evaluator-resolution.js";
import { canonicalJson, sha256Digest } from "./canonical-json.js";

/** Ephemeral authoring assistance, never a resolution or permission to execute. */
export const CAPABILITY_CHECK_CARRY_MS = 60 * 60 * 1000;
export interface StoredCapabilityCheck {
  projectId: string;
  contextDigest: string;
  checkedAt: Date;
  classification: boolean;
  check: CapabilityCheckResult;
}
export interface CapabilityCheckStore {
  put(entry: StoredCapabilityCheck): Promise<void>;
  get(projectId: string, contextDigest: string, now: Date, binding: ExecutionBinding): Promise<CapabilityCheckResult | null>;
}

/** Match the actual credential as well as its source; never persist the key. */
export function capabilityCheckContext(check: Pick<CapabilityCheckResult, "base" | "credentialSource">, apiKey: string | null): string {
  return sha256Digest({ version: 1, base: check.base, credentialSource: check.credentialSource,
    credentialDigest: apiKey === null ? null : sha256Digest(apiKey) });
}

function combined(entries: StoredCapabilityCheck[], binding: ExecutionBinding): CapabilityCheckResult | null {
  if (entries.length === 0) return null;
  // A fresh full check supersedes earlier checks. Keep raw calls in the short
  // lived store; carry only the bounded evidence relevant to this binding.
  const lastFullEntry = [...entries].reverse().find((entry) => !entry.classification);
  const lastFull = lastFullEntry ? entries.indexOf(lastFullEntry) : -1;
  const current = entries.slice(Math.max(0, lastFull));
  const sameReasoning = (reasoning: unknown) => canonicalJson(reasoning) === canonicalJson(binding.reasoning);
  const all = current.flatMap((entry) => entry.check.probes)
    .filter((probe) => probe.verdictProtocol === binding.verdictProtocol && probe.sent.topP === binding.sampling.topP);
  // Newest outcomes supersede an older classification, including a failed
  // classification. Do not accumulate temperature probes from other settings.
  const temperatureCheck = [...current].reverse().find((entry) => sameReasoning(entry.check.probedReasoning) &&
    entry.check.protocol === binding.verdictProtocol);
  const temperatures = temperatureCheck?.check.probes.filter((probe) => probe.purpose === "temperature" &&
    probe.verdictProtocol === binding.verdictProtocol && probe.sent.topP === binding.sampling.topP && sameReasoning(probe.sent.reasoning)) ?? [];
  const reasoning = new Map<string, typeof all[number]>();
  for (const probe of all) if (probe.purpose === "reasoning") reasoning.set(canonicalJson(probe.sent), probe);
  const strength = (probe: typeof all[number]) => probe.outcome === "accepted" ? 3 :
    probe.outcome === "error" ? 0 : probe.rejection === "unattributed" ||
      (probe.rejection === "value" && probe.rejectedParameter === "reasoning") ? 2 : 1;
  // Keep the selected baseline and the strongest other answer. Discarding a
  // later accepted mode could otherwise turn "adjustable" into "unsupported".
  const reasoningProbes = [...reasoning.values()].sort((a, b) =>
    Number(sameReasoning(b.sent.reasoning)) - Number(sameReasoning(a.sent.reasoning)) || strength(b) - strength(a)).slice(0, 2);
  const protocol = [...all].reverse().find((probe) => probe.purpose === "protocol");
  return { ...current.at(-1)!.check, probes: [...(protocol ? [protocol] : []), ...reasoningProbes, ...temperatures] };
}

export class MemoryCapabilityCheckStore implements CapabilityCheckStore {
  private entries: StoredCapabilityCheck[] = [];
  async put(entry: StoredCapabilityCheck): Promise<void> {
    this.entries = this.entries.filter((existing) => existing.checkedAt.getTime() > entry.checkedAt.getTime() - CAPABILITY_CHECK_CARRY_MS);
    this.entries.push(structuredClone(entry));
  }
  async get(projectId: string, contextDigest: string, now: Date, binding: ExecutionBinding): Promise<CapabilityCheckResult | null> {
    const entries = this.entries.filter((entry) => entry.projectId === projectId && entry.contextDigest === contextDigest &&
      entry.checkedAt.getTime() > now.getTime() - CAPABILITY_CHECK_CARRY_MS && entry.checkedAt <= now)
      .sort((a, b) => a.checkedAt.getTime() - b.checkedAt.getTime());
    return structuredClone(combined(entries, binding));
  }
}

export class PgCapabilityCheckStore implements CapabilityCheckStore {
  constructor(private readonly pool: Pool) {}
  async put(entry: StoredCapabilityCheck): Promise<void> {
    // Separate statements are safe: pruning is only storage housekeeping;
    // reads enforce expiry even if this process exits before pruning.
    await this.pool.query(`insert into evaluator_capability_checks
      (id, project_id, context_digest, checked_at, classification, check_result)
      values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [randomUUID(), entry.projectId, entry.contextDigest, entry.checkedAt, entry.classification, JSON.stringify(entry.check)]);
    await this.pool.query(`delete from evaluator_capability_checks where checked_at <= $1`,
      [new Date(entry.checkedAt.getTime() - CAPABILITY_CHECK_CARRY_MS)]);
  }
  async get(projectId: string, contextDigest: string, now: Date, binding: ExecutionBinding): Promise<CapabilityCheckResult | null> {
    const result = await this.pool.query<{ checked_at: Date; classification: boolean; check_result: CapabilityCheckResult }>(
      `select checked_at, classification, check_result from evaluator_capability_checks
       where project_id=$1 and context_digest=$2 and checked_at > $3 and checked_at <= $4
       order by checked_at, sequence`,
      [projectId, contextDigest, new Date(now.getTime() - CAPABILITY_CHECK_CARRY_MS), now]);
    return combined(result.rows.map((row) => ({ projectId, contextDigest, checkedAt: row.checked_at,
      classification: row.classification, check: row.check_result })), binding);
  }
}
