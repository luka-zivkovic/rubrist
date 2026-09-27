import type { IgnoredTemperatureEntry, ReasoningSettings } from "./evaluator-execution.js";

// The dated, versioned table of model and reasoning combinations that accept
// temperature without applying it (Rubrist ADR-0014 decision 12). Each entry
// cites the provider's own documentation; a spread test can support an
// entry, but never lists one alone. For a listed combination the picker hides
// temperature, the governed gates refuse a stated one, and the check,
// resolution, and re-check send no temperature probe. The server matches an
// entry through the binding's endpoint digest, so a base URL spelled
// differently doesn't match. A resolution record keeps the version and the
// entry it matched, and the gates read those, so a new version applies from
// the next resolution. Changing an entry is a new table version;
// tools/temperature-study.mjs reproduces the probes behind it.

export const IGNORED_TEMPERATURE_VERSION = "rubrist-ignored-temperature/v1" as const;

// Per DeepSeek's documentation as reviewed on 2026-09-27: thinking mode is on
// by default, "does not support the temperature ... parameters" and setting
// them "will not trigger an error but will also have no effect".
// reasoning_effort sets its effort (minimal and low map to low, medium and
// high to high), and the pricing page names the models and the base URL.
const DEEPSEEK_SOURCES = [
  "https://api-docs.deepseek.com/guides/thinking_mode",
  "https://api-docs.deepseek.com/quick_start/pricing"
] as const;

function deepSeekThinking(modelId: string, reasoning: ReasoningSettings | null): IgnoredTemperatureEntry {
  return {
    endpoint: { kind: "custom", baseUrl: "https://api.deepseek.com" },
    modelId,
    reasoning,
    sources: [...DEEPSEEK_SOURCES],
    reviewedOn: "2026-09-27"
  };
}

const IGNORED_TEMPERATURE_V1: readonly IgnoredTemperatureEntry[] = [
  deepSeekThinking("deepseek-flash", null),
  deepSeekThinking("deepseek-flash", { family: "openai", effort: "minimal" }),
  deepSeekThinking("deepseek-flash", { family: "openai", effort: "low" }),
  deepSeekThinking("deepseek-flash", { family: "openai", effort: "medium" }),
  deepSeekThinking("deepseek-flash", { family: "openai", effort: "high" }),
  deepSeekThinking("deepseek-v4-pro", null),
  deepSeekThinking("deepseek-v4-pro", { family: "openai", effort: "minimal" }),
  deepSeekThinking("deepseek-v4-pro", { family: "openai", effort: "low" }),
  deepSeekThinking("deepseek-v4-pro", { family: "openai", effort: "medium" }),
  deepSeekThinking("deepseek-v4-pro", { family: "openai", effort: "high" })
];

/** Every entry of the current table, for matching on the server and for review. */
export function ignoredTemperatureTable(): readonly IgnoredTemperatureEntry[] {
  return IGNORED_TEMPERATURE_V1;
}
