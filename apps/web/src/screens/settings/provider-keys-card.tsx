import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { deleteJudgeKey, fetchJudgeKeys, fetchJudgeProviders, setJudgeKey } from "@/lib/api";
import type { JudgeKeyProvider, JudgeProviderKey } from "@rubrist/shared";
import { settingsInput, useSettingsFormState, type SettingsFormProps } from "./form-state.js";

const PROVIDERS: Array<{ provider: JudgeKeyProvider; label: string }> = [
  { provider: "anthropic", label: "Anthropic" }, { provider: "openai", label: "OpenAI" },
  { provider: "openrouter", label: "OpenRouter" }, { provider: "custom", label: "Custom OpenAI-compatible" },
  { provider: "typesafe", label: "TypeSafe" }
];

export function ProviderKeysCard({ canEdit, reportState }: SettingsFormProps) {
  const [keys, setKeys] = useState<JudgeProviderKey[]>([]);
  const [providers, setProviders] = useState(PROVIDERS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<Partial<Record<JudgeKeyProvider, boolean>>>({});
  const [drafts, setDrafts] = useState<Partial<Record<JudgeKeyProvider, string>>>({});
  const [busy, setBusy] = useState<JudgeKeyProvider | null>(null);
  const pending = useRef(false);
  const [feedback, setFeedback] = useState<{ provider: JudgeKeyProvider; error: boolean; text: string } | null>(null);
  useSettingsFormState("providers", Object.values(drafts).some(Boolean), busy !== null, reportState);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadError(null);
    void fetchJudgeKeys().then((rows) => { if (!cancelled) setKeys(rows); })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    void fetchJudgeProviders().then((availability) => {
      if (cancelled) return;
      const rows = availability.providers.filter((row) => row.provider !== "mock" && row.credentialSource !== "built_in");
      if (rows.length) setProviders(rows.map((row) => ({ provider: row.provider as JudgeKeyProvider, label: row.label })));
    }).catch(() => { /* The complete fallback inventory remains available. */ });
    return () => { cancelled = true; };
  }, [attempt]);

  async function mutate(provider: JudgeKeyProvider, action: "save" | "remove") {
    if (!canEdit || pending.current || loading || loadError) return;
    const value = (drafts[provider] ?? "").trim();
    if (action === "save" && !value) return;
    const label = providers.find((row) => row.provider === provider)?.label ?? provider;
    if (action === "remove" && !window.confirm(`Remove the ${label} key from this project? Calls will use a configured platform key if one exists, or fail without a key.`)) return;
    pending.current = true; setBusy(provider); setFeedback(null);
    try {
      if (action === "save") {
        const stored = await setJudgeKey(provider, value);
        setKeys((current) => [...current.filter((key) => key.provider !== provider), stored]);
      } else {
        await deleteJudgeKey(provider);
        setKeys((current) => current.filter((key) => key.provider !== provider));
      }
      setDrafts((current) => ({ ...current, [provider]: "" }));
      setEditing((current) => ({ ...current, [provider]: false }));
      setFeedback({ provider, error: false, text: `${label} project key ${action === "save" ? "saved" : "removed"}.` });
    } catch (err) { setFeedback({ provider, error: true, text: err instanceof Error ? err.message : String(err) }); }
    finally { pending.current = false; setBusy(null); }
  }

  return <Card><CardHeader><div><CardTitle>Judge provider keys</CardTitle>
    <CardDescription>Credentials Rubrist uses to call your chosen LLM provider or TypeSafe. These apply to this project; model choices belong to evaluator versions.</CardDescription>
  </div></CardHeader><CardContent className="space-y-4">
    <p className="max-w-[80ch] text-[12px] text-ink-3">Saved keys are encrypted and cannot be viewed again. An invalid project key fails the call. Removing it allows a configured platform key to be used; it does not switch providers.</p>
    {loading ? <p role="status" className="text-[12px]">Loading provider keys…</p> : loadError ? <div><p role="alert" className="text-[12px] text-signal">{loadError}</p><Button type="button" onClick={() => setAttempt((n) => n + 1)}>Retry provider keys</Button></div> :
      <div className="divide-y divide-rule-soft">{providers.map(({ provider, label }) => {
        const stored = keys.find((key) => key.provider === provider);
        const message = feedback?.provider === provider ? feedback : null;
        return <div key={provider} data-judge-key-row={provider} className="space-y-3 py-4 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h3 className="text-[13px] font-medium">{label}</h3><p className="mt-1 text-[12px] text-ink-3">{stored ? <><code>{stored.keyDisplay}</code> · saved {new Date(stored.createdAt).toLocaleDateString()}</> : "No project key saved"}</p></div>
            {canEdit && !editing[provider] ? <div className="flex gap-2">
              <Button type="button" disabled={busy !== null} onClick={() => { setEditing((current) => ({ ...current, [provider]: true })); setFeedback(null); }}>{stored ? "Replace key" : "Add key"}</Button>
              {stored ? <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => void mutate(provider, "remove")}>Remove…</Button> : null}
            </div> : null}
          </div>
          {canEdit && editing[provider] ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void mutate(provider, "save"); }}>
            <label htmlFor={`provider-key-${provider}`} className="block text-[12.5px]">{label} API key</label>
            <input id={`provider-key-${provider}`} type="password" autoComplete="off" spellCheck={false} className={`${settingsInput} max-w-lg`}
              value={drafts[provider] ?? ""} disabled={busy !== null} aria-invalid={Boolean(message?.error)} aria-describedby={message ? `provider-feedback-${provider}` : undefined}
              onChange={(event) => { setDrafts((current) => ({ ...current, [provider]: event.target.value })); setFeedback(null); }} />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={busy !== null || !(drafts[provider] ?? "").trim()}>{busy === provider ? "Saving…" : "Save key"}</Button>
              <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => { setDrafts((current) => ({ ...current, [provider]: "" })); setEditing((current) => ({ ...current, [provider]: false })); setFeedback(null); }}>Cancel</Button>
              {drafts[provider] ? <span className="text-[12px] text-ink-3">Unsaved key</span> : null}
            </div>
          </form> : null}
          {message ? <p id={`provider-feedback-${provider}`} role={message.error ? "alert" : "status"} className={`text-[12px] ${message.error ? "text-signal" : "text-ink-2"}`}>{message.text}</p> : null}
          {busy === provider && !editing[provider] ? <p role="status" className="text-[12px]">Removing key…</p> : null}
        </div>;
      })}</div>}
  </CardContent></Card>;
}
