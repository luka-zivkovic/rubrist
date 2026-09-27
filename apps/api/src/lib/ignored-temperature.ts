import {
  ignoredTemperatureTable,
  type ExecutionBinding,
  type IgnoredTemperatureEntry,
  type ReasoningSettings
} from "@rubrist/shared";
import { canonicalJson } from "./canonical-json.js";
import { endpointBaseUrlDigest } from "./evaluator-identity.js";

// The ignored-temperature table matched on the server (ADR-0014 decision 12),
// where the endpoint digest can be computed: an entry names a managed
// provider's endpoint, or a custom endpoint whose base URL, exactly as
// written, digests to the one the binding names. A base URL spelled
// differently doesn't match.

type ListedBinding = Pick<ExecutionBinding, "provider" | "endpoint" | "modelId">;

function sameEndpoint(entry: IgnoredTemperatureEntry, binding: ListedBinding): boolean {
  return entry.endpoint.kind === "managed"
    ? binding.endpoint.kind === "managed" && binding.provider === entry.endpoint.provider
    : binding.endpoint.kind === "custom" && binding.endpoint.baseUrlDigest === endpointBaseUrlDigest(entry.endpoint.baseUrl);
}

/** The entries listing this model at this endpoint, with any reasoning. */
export function ignoredTemperatureEntries(
  binding: ListedBinding,
  table: readonly IgnoredTemperatureEntry[] = ignoredTemperatureTable()
): IgnoredTemperatureEntry[] {
  return table.filter((entry) => entry.modelId === binding.modelId && sameEndpoint(entry, binding));
}

/** The entry listing this model at this endpoint with exactly this reasoning (`null` for unset), or `null`. */
export function ignoredTemperatureEntryFor(
  binding: ListedBinding,
  reasoning: ReasoningSettings | null,
  table: readonly IgnoredTemperatureEntry[] = ignoredTemperatureTable()
): IgnoredTemperatureEntry | null {
  return ignoredTemperatureEntries(binding, table).find((entry) => canonicalJson(entry.reasoning) === canonicalJson(reasoning)) ?? null;
}
