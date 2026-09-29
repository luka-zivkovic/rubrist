import { useEffect, useId, useState } from "react";
import type { Skill, SkillVersion } from "@rubrist/shared";
import { fetchSkillVersions } from "@/lib/api";

export function useReviewEvaluator(skill: Skill | null) {
  const [versions, setVersions] = useState<SkillVersion[]>(skill ? [skill.currentVersion] : []);
  const [versionId, setVersionId] = useState(skill?.currentVersion.id ?? "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setVersions(skill ? [skill.currentVersion] : []);
    setVersionId(skill?.currentVersion.id ?? "");
    setError(null);
    if (skill) void fetchSkillVersions(skill.id).then((rows) => {
      if (!cancelled) setVersions(rows);
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [skill?.id]);
  const scopedVersions = versions.filter((version) => version.skillId === skill?.id);
  return { versions: scopedVersions, versionId, setVersionId, error,
    selected: scopedVersions.find((version) => version.id === versionId) };
}

export function ReviewEvaluatorPicker({ selection, disabled, previewPinned = false }: {
  selection: ReturnType<typeof useReviewEvaluator>;
  disabled?: boolean;
  previewPinned?: boolean;
}) {
  const id = useId();
  return <div className="flex flex-col gap-1.5">
    <label htmlFor={id} className="eyebrow">Evaluator version to review</label>
    <select id={id} value={selection.versionId} disabled={disabled} onChange={(e) => selection.setVersionId(e.target.value)} className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 text-sm">
      {selection.versions.map((version) => <option key={version.id} value={version.id}>v{version.version} · {version.id}</option>)}
    </select>
    <p className="text-xs text-ink-3">{previewPinned ? "Saves the exact results shown in this suggestion." : "Saves the latest existing result from this version for each case."} Later runs cannot replace saved results. Every case must already have a result.</p>
    {selection.error ? <p role="alert" className="text-xs text-signal">Could not load version history: {selection.error}</p> : null}
  </div>;
}
