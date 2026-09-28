import type { Skill } from "@rubrist/shared";
import { fetchCurrentSkill } from "@/lib/api";
import { ApiError } from "../lib/api/transport.js";
import { useSectionRead, type SectionRead } from "@/hooks/use-section-read";
import { SectionLoadError, SectionLoading } from "@/components/rubrist";

// Read selection separately from the latest saved version: a governed lineage
// can have history without any version eligible for implicit execution.
export function useCurrentDefault(skill: Skill | null, criterionId: string | null, readKey: string | null) {
  return useSectionRead(readKey && skill ? `${readKey}:${skill.id}` : null, skill ? async () => {
    try {
      const current = await fetchCurrentSkill(criterionId ?? undefined);
      if (current.id !== skill.id) throw new Error("The default belongs to a different evaluator. Refresh to read the current selection.");
      return current.currentVersion;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && error.body && typeof error.body === "object"
        && "code" in error.body && ["no_current_evaluator", "criterion_not_found"].includes(String(error.body.code))) return null;
      throw error;
    }
  } : null);
}

type DefaultRead = ReturnType<typeof useCurrentDefault>;

export function defaultVersionLabel(read: SectionRead<Skill["currentVersion"] | null>, versionId: string): string {
  if (read.status === "failed") return "Default unavailable";
  if (read.status !== "loaded") return "Loading default…";
  if (!read.data) return "No current default";
  return read.data.id === versionId ? "Current default" : "Saved version";
}

export function EvaluatorDefault({ read, versionId }: { read: DefaultRead; versionId?: string }) {
  if (read.status === "failed") return <SectionLoadError className="mb-5" title="Couldn't load the current default." failure={read.failure} retrying={read.retrying} onRetry={read.retry} />;
  if (read.status !== "loaded") return <SectionLoading className="mb-5" label="Loading the current default…" />;
  const selected = read.data;
  const other = selected && versionId && selected.id !== versionId;
  return (
    <section aria-label="Default selection" className="mb-5 rounded-sm border border-rule-strong bg-paper-2 px-4 py-3">
      <p className="text-[14px] font-medium text-ink">
        {other ? "Saved version · " : ""}{selected ? `Current default: v${selected.version}` : "No current default"}
      </p>
      <p className="mt-1 max-w-[88ch] text-[12px] leading-5 text-ink-2">
        {selected
          ? `${other ? "This saved version is not the default. " : ""}New runs that do not pin a version use v${selected.version}. Default selection does not establish accuracy or calibration.`
          : "Saved versions remain available to inspect. No version is currently eligible for runs that do not pin a version."}
      </p>
    </section>
  );
}
