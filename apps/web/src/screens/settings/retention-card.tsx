import { useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { pruneExpiredTraces, updateProjectSettings } from "@/lib/api";
import type { ProjectSettings, RetentionPruneResult } from "@rubrist/shared";
import { settingsInput, useSettingsFormState, type SettingsFormProps } from "./form-state.js";

export function parseRetentionDraft(draft: string): number | null | undefined {
  if (!draft.trim()) return null;
  if (!/^\d+$/.test(draft.trim())) return undefined;
  const value = Number(draft);
  return Number.isInteger(value) && value >= 1 && value <= 3650 ? value : undefined;
}

export function RetentionCard({ settings, canEdit, reportState }: SettingsFormProps & { settings: ProjectSettings }) {
  const [saved, setSaved] = useState(settings.traceRetentionDays);
  const [draft, setDraft] = useState(saved === null ? "" : String(saved));
  const [busy, setBusy] = useState<"save" | "prune" | null>(null);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<RetentionPruneResult | null>(null);
  const dirty = draft !== (saved === null ? "" : String(saved));
  useSettingsFormState("retention", dirty, busy !== null, reportState);

  async function save() {
    if (!canEdit || pending.current || !dirty) return;
    const days = parseRetentionDraft(draft);
    if (days === undefined) { setError("Enter a whole number from 1 to 3650, or leave blank to keep indefinitely."); return; }
    pending.current = true; setBusy("save"); setError(null); setMessage(null);
    try {
      const updated = await updateProjectSettings({ traceRetentionDays: days });
      setSaved(updated.traceRetentionDays);
      setDraft(updated.traceRetentionDays === null ? "" : String(updated.traceRetentionDays));
      setMessage("Retention period saved. No traces were deleted."); setResult(null);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { pending.current = false; setBusy(null); }
  }
  async function prune() {
    if (!canEdit || pending.current || dirty || saved === null) return;
    if (!window.confirm(`Delete eligible traces older than ${saved} days and their cases and verdicts from ${settings.name}? Protected evidence is skipped. This cannot be undone.`)) return;
    pending.current = true; setBusy("prune"); setError(null); setMessage(null); setResult(null);
    try { setResult(await pruneExpiredTraces()); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { pending.current = false; setBusy(null); }
  }
  return <Card>
    <CardHeader><div><CardTitle>Trace retention</CardTitle>
      <CardDescription>Choose which ordinary traces are eligible for manual deletion. Saving a period does not delete data or schedule a sweep.</CardDescription>
    </div></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-[13px] text-ink-2">Saved period: <strong>{saved === null ? "Keep indefinitely" : `${saved} days`}</strong></p>
      {canEdit ? <form noValidate onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-3">
        <div className="max-w-sm">
          <label htmlFor="trace-retention-days" className="mb-1.5 block text-[12.5px] font-medium">Keep traces for (days)</label>
          <input id="trace-retention-days" inputMode="numeric" className={settingsInput} value={draft} disabled={busy !== null}
            aria-describedby={`retention-help${error ? " retention-error" : ""}`} aria-invalid={Boolean(error)}
            onChange={(event) => { setDraft(event.target.value); setError(null); setMessage(null); }} placeholder="Keep indefinitely" />
          <p id="retention-help" className="mt-1.5 text-[12px] text-ink-3">1–3650 days. Leave blank to keep indefinitely.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!dirty || busy !== null}>{busy === "save" ? "Saving…" : "Save period"}</Button>
          <Button type="button" variant="ghost" disabled={!dirty || busy !== null} onClick={() => { setDraft(saved === null ? "" : String(saved)); setError(null); setMessage(null); }}>Discard changes</Button>
          {dirty ? <span className="text-[12px] text-ink-3">Unsaved changes</span> : null}
        </div>
      </form> : null}
      {error ? <p id="retention-error" role="alert" className="text-[12.5px] text-signal">{error}</p> : null}
      {message ? <p role="status" className="text-[12.5px] text-ink-2">{message}</p> : null}
      <div className="space-y-3 border-t border-rule-soft pt-4">
        <div><h3 className="text-[13px] font-medium">Delete expired traces</h3>
          <p className="mt-1 max-w-[76ch] text-[12px] text-ink-3">Permanently deletes eligible cases, their verdicts and raw traces using the saved period. Original data in your tracing platform is unaffected.</p>
        </div>
        <details className="text-[12px] text-ink-3"><summary className="cursor-pointer">What is protected?</summary>
          <p className="mt-2">Active golden cases, cases in immutable dataset revisions, receipt cases, and cases pinned to saved review tasks or with task-attributed reviews are skipped. Production outcome records have separate retention controls in Production calibration.</p>
        </details>
        {canEdit ? <><Button type="button" variant="outline" onClick={() => void prune()} disabled={busy !== null || dirty || saved === null}>
          {busy === "prune" ? "Deleting…" : "Delete expired traces…"}
        </Button><p className="text-[12px] text-ink-3">{dirty ? "Save or discard your changes before deleting expired traces." : saved === null ? "No traces expire while the saved period is indefinite." : `Uses the saved ${saved}-day period. You will confirm before deletion.`}</p></> : null}
        {result ? <p role="status" className="text-[12.5px] text-ink-2">
          Latest action this session: {result.deletedCases} cases and {result.deletedRawTraces} raw traces deleted; {result.skippedActiveGoldenCases} active golden cases, {result.skippedImmutableRevisionCases} immutable-evidence cases and {result.skippedReviewCases} saved-review cases skipped.
        </p> : null}
      </div>
    </CardContent>
  </Card>;
}
