import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/rubrist";
import { ConnectAgentPanel } from "@/components/connect-agent-panel";
import { createApiKey, fetchApiKeys, revokeApiKey } from "@/lib/api";
import { purgeProductionApiKeyRecords } from "@/lib/production-calibration-api";
import { copyTextToClipboard } from "../../lib/clipboard.js";
import type { ApiKey, ApiKeyCapability, CreatedApiKey } from "@rubrist/shared";
import { settingsInput, useSettingsFormState, type SettingsFormProps } from "./form-state.js";

const CAPABILITIES: Record<ApiKeyCapability, string> = { judge: "Judge and read", production_ingest: "Production ingest only" };

export function ApiKeysCard({ canEdit, reportState }: SettingsFormProps) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(canEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [capability, setCapability] = useState<ApiKeyCapability>("judge");
  const [busy, setBusy] = useState<string | null>(null);
  const pending = useRef(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  // This marks only server-confirmed revocations, without inventing a server timestamp.
  const [revoked, setRevoked] = useState<Set<string>>(() => new Set());
  const [purged, setPurged] = useState<Set<string>>(() => new Set());
  useSettingsFormState("api-keys", Boolean(name) || capability !== "judge" || (created !== null && !copied), busy !== null, reportState);
  useEffect(() => {
    if (!canEdit) return;
    let cancelled = false;
    setLoading(true); setLoadError(null);
    void fetchApiKeys().then((rows) => { if (!cancelled) setKeys(rows); })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [canEdit, attempt]);

  async function create() {
    if (!canEdit || pending.current || loading || loadError || !name.trim() || created) return;
    pending.current = true; setBusy("create"); setError(null); setMessage(null);
    try {
      const result = await createApiKey(name.trim(), capability);
      const { key: _plaintext, ...metadata } = result;
      setKeys((current) => [metadata, ...current]);
      setCreated(result); setCopied(false); setName(""); setCapability("judge");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { pending.current = false; setBusy(null); }
  }
  async function act(key: ApiKey, action: "revoke" | "purge") {
    if (!canEdit || pending.current || loading || loadError) return;
    const isRevoked = key.revokedAt !== null || revoked.has(key.id);
    if ((action === "revoke" && isRevoked) || (action === "purge" && (!isRevoked || key.capability !== "production_ingest" || purged.has(key.id)))) return;
    const question = action === "revoke"
      ? `Revoke ${key.name}? Applications using this key will lose access. Existing records are retained.`
      : `Delete every production decision record sent by ${key.name}? This cannot be undone.`;
    if (!window.confirm(question)) return;
    pending.current = true; setBusy(key.id); setError(null); setMessage(null);
    try {
      if (action === "revoke") {
        await revokeApiKey(key.id);
        setRevoked((current) => new Set([...current, key.id]));
        if (created?.id === key.id) setCreated(null);
        setMessage(`${key.name} revoked. Existing records were retained.`);
      } else {
        const counts = await purgeProductionApiKeyRecords(key.id);
        setPurged((current) => new Set([...current, key.id]));
        setMessage(`${key.name}: ${counts.decisions} decisions, ${counts.actions} actions and ${counts.outcomes} outcomes deleted.`);
      }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { pending.current = false; setBusy(null); }
  }

  return <Card><CardHeader><div><CardTitle>Rubrist API keys</CardTitle>
    <CardDescription>Credentials other applications use to access this project. These are separate from model-provider keys.</CardDescription>
  </div></CardHeader><CardContent className="space-y-4">
    {!canEdit ? <p className="text-[12.5px] text-ink-3">Only project owners in a connected workspace can view or manage Rubrist API keys.</p> : <>
      <p className="max-w-[80ch] text-[12px] text-ink-3">Judge-and-read keys can evaluate and read project data. Production-ingest keys can only append production records; they cannot judge or read. Neither records governed human truth.</p>
      {loading ? <p role="status" className="text-[12px]">Loading API keys…</p> : loadError ? <div><p role="alert" className="text-[12px] text-signal">{loadError}</p><Button type="button" onClick={() => setAttempt((n) => n + 1)}>Retry API keys</Button></div> : <>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label htmlFor="api-key-name" className="mb-1.5 block text-[12.5px] font-medium">Key name</label>
              <input id="api-key-name" className={settingsInput} value={name} disabled={busy !== null || created !== null} placeholder="e.g. support-workflow" onChange={(event) => { setName(event.target.value); setError(null); }} />
            </div>
            <div><label htmlFor="api-key-capability" className="mb-1.5 block text-[12.5px] font-medium">Access</label>
              <select id="api-key-capability" className={settingsInput} value={capability} disabled={busy !== null || created !== null} onChange={(event) => { setCapability(event.target.value as ApiKeyCapability); setError(null); }}>
                <option value="judge">Judge and read</option><option value="production_ingest">Production ingest only</option>
              </select>
            </div>
          </div>
          <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy !== null || created !== null || !name.trim()}>{busy === "create" ? "Creating…" : "Create key"}</Button>
            <Button type="button" variant="ghost" disabled={busy !== null || (!name && capability === "judge")} onClick={() => { setName(""); setCapability("judge"); setError(null); }}>Discard changes</Button>
          </div>
        </form>
        {created ? <div className="space-y-3 rounded-sm border border-rule bg-paper-2 p-4">
          <p className="text-[13px] font-medium">Copy this key now — it will not be shown again.</p>
          <code className="block break-all text-[12px]">{created.key}</code>
          <div className="flex flex-wrap gap-2"><Button type="button" onClick={() => void copyTextToClipboard(created.key).then(() => setCopied(true)).catch(() => setError("Could not copy the key. Select and copy it manually."))}>{copied ? "Copied" : "Copy key"}</Button>
            <Button type="button" variant="ghost" onClick={() => setCreated(null)}>Hide key</Button></div>
          {created.capability === "judge" ? <details><summary className="cursor-pointer text-[12.5px]">Connect your agent</summary><div className="mt-3"><ConnectAgentPanel apiKey={created.key} /></div></details>
            : <p className="text-[12px] text-ink-3">Use this key with POST /api/v1/production-decisions. It cannot be used with judge endpoints or the agent judging tools.</p>}
        </div> : <details className="text-[12.5px]"><summary className="cursor-pointer">Connect an agent with a judge-and-read key</summary><div className="mt-3"><ConnectAgentPanel apiKey={null} /></div></details>}
        {keys.length === 0 ? <p className="text-[12px] text-ink-3">No API keys yet.</p> : <div className="divide-y divide-rule-soft">{keys.map((key) => {
          const isRevoked = key.revokedAt !== null || revoked.has(key.id);
          return <div key={key.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0"><h3 className="break-words text-[13px] font-medium">{key.name} <Chip variant="outline">{CAPABILITIES[key.capability]}</Chip> {isRevoked ? <Chip variant="outline">revoked</Chip> : null}</h3>
              <p className="mt-1 text-[12px] text-ink-3"><code>{key.keyPrefix}</code> · created {new Date(key.createdAt).toLocaleDateString()}{key.lastUsedAt ? ` · last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : ""}</p></div>
            {!isRevoked ? <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => void act(key, "revoke")}>{busy === key.id ? "Revoking…" : "Revoke…"}</Button>
              : key.capability === "production_ingest" ? <Button type="button" variant="ghost" disabled={busy !== null || purged.has(key.id)} onClick={() => void act(key, "purge")}>{busy === key.id ? "Deleting…" : purged.has(key.id) ? "Records purged" : "Purge records…"}</Button> : null}
          </div>;
        })}</div>}
      </>}
      {error ? <p role="alert" className="text-[12.5px] text-signal">{error}</p> : null}
      {message ? <p role="status" className="text-[12.5px] text-ink-2">{message}</p> : null}
    </>}
  </CardContent></Card>;
}
