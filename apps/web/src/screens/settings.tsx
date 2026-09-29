import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { LogOut, RefreshCcw, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SectionHead } from "@/components/rubrist";
import { fetchProjectSettings, selectProject } from "@/lib/api";
import { authClient, useSession } from "@/lib/auth-client";
import { forgetFirstProjectKey } from "@/lib/journey";
import { useAppMode } from "@/lib/app-mode";
import type { ProjectSettingsView } from "@rubrist/shared";
import { contextualHref } from "../lib/route-metadata.js";
import { InlineDetails } from "../components/rubrist/inline-details.js";
import { RetentionCard } from "./settings/retention-card.js";
import { ProviderKeysCard } from "./settings/provider-keys-card.js";
import { ApiKeysCard } from "./settings/api-keys-card.js";
import { DeleteConfirm } from "./settings/delete-confirm.js";
import { useSettingsNavigationGuard, type FormState } from "./settings/form-state.js";

export function SettingsScreen() {
  const session = useSession();
  const location = useLocation();
  const { demoMode } = useAppMode();
  const [settings, setSettings] = useState<ProjectSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const request = useRef(0);
  const [forms, setForms] = useState<Record<string, FormState>>({});
  const [showDelete, setShowDelete] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const dirty = Object.values(forms).some((form) => form.dirty);
  const busy = Object.values(forms).some((form) => form.busy) || showDelete || signingOut;
  const { confirmDiscard, allowExit } = useSettingsNavigationGuard(dirty, busy);
  const reportState = useCallback((section: string, state: FormState) => {
    setForms((current) => current[section]?.dirty === state.dirty && current[section]?.busy === state.busy ? current : { ...current, [section]: state });
  }, []);
  const load = useCallback(async () => {
    const generation = ++request.current;
    setLoading(true); setError(null);
    try {
      const value = await fetchProjectSettings();
      if (generation !== request.current) return;
      setSettings(value); setForms({}); setRevision((current) => current + 1);
    } catch (err) {
      if (generation !== request.current) return;
      setSettings(null); setError(err instanceof Error ? err.message : String(err));
    } finally { if (generation === request.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(); return () => { request.current++; }; }, [load]);
  const canEdit = !demoMode && settings?.viewerRole === "owner" && !loading;

  async function signOut() {
    if (signingOut || !confirmDiscard()) return;
    setSigningOut(true); setSignOutError(null);
    forgetFirstProjectKey();
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message ?? "Sign-out failed. Try again.");
      // Reload to clear every component's in-memory credential draft and project data.
      allowExit();
      window.location.assign("/");
    } catch (err) { setSignOutError(err instanceof Error ? err.message : String(err)); setSigningOut(false); }
  }

  return <div className="fadeUp max-w-[1040px] space-y-7">
    <SectionHead eyebrow="Workspace admin" title="Settings"
      sub="Project configuration, credentials and your account, each with a clear scope."
      right={<Button type="button" variant="ghost" onClick={() => { if (confirmDiscard()) void load(); }} disabled={loading || busy}><RefreshCcw />{loading ? "Refreshing…" : "Refresh"}</Button>} />
    <nav aria-label="Settings sections" className="flex flex-wrap gap-x-5 gap-y-2 border-b border-rule-soft pb-3 text-[13px]">
      <a href="#settings-project" className="underline-offset-4 hover:underline">Project</a>
      <a href="#settings-connections" className="underline-offset-4 hover:underline">Connections</a>
      <a href="#settings-account" className="underline-offset-4 hover:underline">Your account</a>
    </nav>
    {loading && !settings ? <p role="status">Loading project settings…</p> : null}
    {error ? <div role="alert" className="space-y-2 rounded-sm border border-rule p-4"><p>Could not load project settings: {error}</p><Button type="button" onClick={() => void load()} disabled={loading}>Retry settings</Button></div> : null}
    {settings ? <fieldset disabled={signingOut} key={`${settings.projectId}-${revision}`} className="space-y-8">
      <p role="status" className="rounded-sm border border-rule-soft bg-paper-2 px-4 py-3 text-[12.5px] text-ink-2">
        {demoMode ? "Demo workspace — settings are read-only here. Use a connected workspace to manage configuration and credentials."
          : settings.viewerRole === "owner" ? `You are an owner of ${settings.name}. Project changes affect everyone in this workspace.`
          : `You are a member of ${settings.name}. Project settings are read-only; ask an owner to make changes.`}
      </p>
      <section id="settings-project" aria-labelledby="settings-project-title" className="scroll-mt-36 sm:scroll-mt-24 space-y-4">
        <h2 id="settings-project-title" className="font-serif text-[20px] font-medium">Project</h2>
        <Card><CardContent className="space-y-3"><div><p className="text-[12px] text-ink-3">Project name</p><p className="mt-1 text-[14px] font-medium">{settings.name}</p></div>
          <p className="text-[12px] text-ink-3">{settings.mode === "bench" ? "Dataset-first workspace" : "Trace workspace"}</p>
          <InlineDetails label="Project ID">{settings.projectId}</InlineDetails>
        </CardContent></Card>
        <RetentionCard settings={settings} canEdit={canEdit} reportState={reportState} />
        {canEdit ? <details className="rounded-sm border border-rule-soft p-4"><summary className="cursor-pointer text-[13px] text-signal">Delete this project</summary>
          <p className="my-3 max-w-[76ch] text-[12.5px] text-ink-3">Permanently removes this project's Rubrist data, including evaluations, reviews, credentials and saved evidence. Original data in your tracing platform is unaffected.</p>
          <Button type="button" variant="outline" disabled={dirty || busy} onClick={() => setShowDelete(true)}><Trash2 /> Delete project…</Button>
          {dirty ? <p className="mt-2 text-[12px] text-ink-3">Save or discard your changes first.</p> : null}
        </details> : null}
      </section>
      <section id="settings-connections" aria-labelledby="settings-connections-title" className="scroll-mt-36 sm:scroll-mt-24 space-y-4">
        <h2 id="settings-connections-title" className="font-serif text-[20px] font-medium">Connections</h2>
        <p className="text-[12.5px] text-ink-3">Manage credentials here. Configure trace sources in <Link className="underline" to={contextualHref("/integrations", location.search)}>Integrations</Link>; choose models and evaluator settings in <Link className="underline" to={contextualHref("/skill", location.search)}>Rubric</Link>.</p>
        <ProviderKeysCard canEdit={canEdit} reportState={reportState} />
        <ApiKeysCard canEdit={canEdit} reportState={reportState} />
      </section>
    </fieldset> : null}
    <section id="settings-account" aria-labelledby="settings-account-title" className="scroll-mt-36 sm:scroll-mt-24 space-y-4">
      <h2 id="settings-account-title" className="font-serif text-[20px] font-medium">Your account</h2>
      <Card><CardHeader><div><CardTitle>Signed-in account</CardTitle><CardDescription>This session belongs to you, across your projects.</CardDescription></div></CardHeader>
        <CardContent className="space-y-3"><p className="text-[14px] font-medium">{session.data?.user?.name ?? "Demo operator"}</p>
          <p className="break-all text-[12.5px] text-ink-3">{session.data?.user?.email ?? "No authenticated account in demo mode."}</p>
          {!demoMode ? <Button type="button" disabled={busy} onClick={() => void signOut()}><LogOut />{signingOut ? "Signing out…" : "Sign out"}</Button> : null}
          {signOutError ? <p role="alert" className="text-[12.5px] text-signal">{signOutError}</p> : null}
        </CardContent></Card>
    </section>
    {showDelete && settings ? <DeleteConfirm projectName={settings.name} onCancel={() => setShowDelete(false)} onDeleted={() => { allowExit(); selectProject(null); window.location.assign("/"); }} /> : null}
  </div>;
}
