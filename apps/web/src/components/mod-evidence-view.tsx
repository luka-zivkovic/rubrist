import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Chip } from "@/components/rubrist";

import {
  VIEW_MOD_CONTRACT,
  ViewModPinError,
  declaredEvidenceView,
  installedViewMods,
  loadViewModDocument,
  parseViewModRequest,
  viewModFor,
  viewModSkipText,
  type InstalledViewMods,
  type ViewModEvidenceMessage,
  type ViewModManifest
} from "../lib/view-mods.js";
import { declaredViewEvidence } from "../lib/view-spec.js";
import { CopyTextButton } from "./copy-text-button.js";
import { DeclaredEvidenceView } from "./declared-evidence-view.js";

// Host tokens a frame mod may use to match the app. Values are copied, so the
// mod never reads the host document.
const THEME_TOKENS = [
  "--paper", "--paper-2", "--card-raw", "--card-2", "--rule", "--rule-soft", "--rule-strong",
  "--ink", "--ink-2", "--ink-3", "--signal", "--signal-tint", "--signal-wash"
];

function hostTheme(): ViewModEvidenceMessage["theme"] {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const token of THEME_TOKENS) {
    const value = style.getPropertyValue(token).trim();
    if (value) tokens[token] = value;
  }
  return { scheme: document.documentElement.classList.contains("dark") ? "dark" : "light", tokens };
}

type FrameMod = Extract<ViewModManifest, { kind: "frame" }>;
interface ViewProps { input: unknown; output: unknown; steps?: unknown; metadata: unknown; evaluatorFailingStep: number | null }

// The frame has an opaque origin (scripts only, no same-origin) and no device
// permissions, so it has no session, no API access and no reach into this page.
function FrameView({ manifest, input, output, steps, metadata, evaluatorFailingStep }: ViewProps & { manifest: FrameMod }) {
  const [state, setState] = useState<{ document: string } | { error: string } | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const message = useRef<Omit<ViewModEvidenceMessage, "theme">>(null!);
  message.current = {
    type: "rubrist:evidence", contract: VIEW_MOD_CONTRACT,
    evidence: { input, output, steps: steps ?? null, metadata }, evaluatorFailingStep
  };

  useEffect(() => {
    let current = true;
    void loadViewModDocument(manifest).then(
      document => ({ document }),
      error => ({ error: error instanceof ViewModPinError ? `This view is not shown because ${viewModSkipText(error.reason)}.` : String(error) })
    ).then(result => { if (current) setState(result); });
    return () => { current = false; };
  }, [manifest]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const request = parseViewModRequest(event.data);
      if (request?.type === "rubrist:resize") setHeight(request.height);
      // The frame's origin is opaque, so "*" is the only addressable target.
      else if (request?.type === "rubrist:ready") frame.current.contentWindow?.postMessage({ ...message.current, theme: hostTheme() }, "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (state === null) return null;
  if ("error" in state) return <p className="text-[12px] text-signal">{state.error}</p>;
  return <iframe
    ref={frame}
    title={`${manifest.name} (view mod)`}
    sandbox="allow-scripts"
    allow=""
    referrerPolicy="no-referrer"
    srcDoc={state.document}
    className="block w-full rounded-sm border border-rule-soft bg-card-2"
    style={{ height: height ?? manifest.height }}
  />;
}

function DeclaredView({ manifest, input, output, steps, metadata, evaluatorFailingStep }: ViewProps & { manifest: Extract<ViewModManifest, { kind: "declared" }> }) {
  const blocks = useMemo(() => declaredViewEvidence(manifest.views, { input, output, steps: steps ?? null, metadata }), [manifest, input, output, steps, metadata]);
  return <DeclaredEvidenceView blocks={blocks} evaluatorFailingStep={evaluatorFailingStep} />;
}

type Tab = "view" | "recorded" | "raw";
const TABS: { id: Tab; label: string }[] = [{ id: "view", label: "Custom view" }, { id: "recorded", label: "Recorded evidence" }, { id: "raw", label: "Raw JSON" }];

// SPIKE: an added, display-only view of the same recorded evidence, beside the
// ordinary recorded view (`children`) and the raw JSON. All three stay mounted;
// the tabs only choose which one is shown, so an evaluator's message reference
// can still land in the recorded view.
export function ModEvidenceView({ children, inspected, targetPrefix, ...props }: ViewProps & {
  children: ReactNode; inspected: { index: number } | null; targetPrefix: string;
}) {
  const view = declaredEvidenceView(props.metadata);
  const [installed, setInstalled] = useState<InstalledViewMods | null>(null);
  const [tab, setTab] = useState<Tab>("view");
  const pendingScroll = useRef<number | null>(null);
  const raw = useMemo(() => JSON.stringify({ input: props.input, output: props.output, steps: props.steps, metadata: props.metadata }, null, 2) ?? "", [props.input, props.output, props.steps, props.metadata]);

  useEffect(() => {
    let current = true;
    if (view !== null) void installedViewMods().then(result => { if (current) setInstalled(result); });
    return () => { current = false; };
  }, [view]);

  // A reference into the recorded messages opens that tab and lands on it once.
  useEffect(() => {
    if (!inspected) return;
    pendingScroll.current = inspected.index;
    setTab("recorded");
  }, [inspected]);
  useEffect(() => {
    if (tab !== "recorded" || pendingScroll.current === null) return;
    const target = document.getElementById(`${targetPrefix}-${pendingScroll.current}`);
    pendingScroll.current = null;
    target?.scrollIntoView({ block: "start", behavior: "instant" });
    target?.focus({ preventScroll: true });
  }, [tab, inspected, targetPrefix]);

  if (view === null || installed === null) return <>{children}</>;
  const manifest = viewModFor(props.metadata, installed.mods);
  if (!manifest) {
    return <>
      <p className="rounded-sm border border-rule-soft p-3 text-[12px] text-ink-3 [overflow-wrap:anywhere]">
        This case declares the view <code>{view}</code>. No installed view mod draws it, so only the recorded evidence is shown.
        {installed.skipped.map(skipped => ` The view mod ${skipped.id} is not loaded because ${viewModSkipText(skipped.reason)}.`).join("")}
      </p>
      {children}
    </>;
  }
  return <Card className="min-w-0" data-testid="mod-evidence-view">
    <CardHeader>
      <div className="min-w-0">
        <CardTitle>{manifest.name}</CardTitle>
        <CardDescription>
          {tab === "view"
            ? manifest.kind === "declared"
              ? "Rubrist drew this from the recorded evidence, following a view description. It is another way to read the same case, not a separate record."
              : "A view mod drew this from the recorded evidence. It cannot record a label or change the case; check the recorded evidence before you rely on it."
            : tab === "recorded" ? "The recorded evidence as Rubrist ordinarily shows it." : "The recorded input, output, steps and metadata of this case, as stored."}
        </CardDescription>
      </div>
      <div className="flex-1" />
      <Chip>view mod · {manifest.id} {manifest.version} · {manifest.kind === "declared" ? "declared" : "sandboxed HTML"}</Chip>
    </CardHeader>
    <CardContent className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Evidence view">
        {TABS.map(item => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}
          className={`inline-flex h-7 cursor-pointer items-center rounded-sm border px-2.5 text-[12px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${tab === item.id ? "border-ink bg-ink text-paper" : "border-rule-soft text-ink-2 hover:bg-paper-3"}`}>
          {item.label}
        </button>)}
        {tab === "raw" ? <><span className="flex-1" /><CopyTextButton text={raw} /></> : null}
      </div>
      <div role="tabpanel" hidden={tab !== "view"} className="min-w-0">
        {manifest.kind === "declared" ? <DeclaredView {...props} manifest={manifest} /> : <FrameView {...props} manifest={manifest} />}
      </div>
      <div role="tabpanel" hidden={tab !== "recorded"} className="min-w-0 flex flex-col gap-5">{children}</div>
      <div role="tabpanel" hidden={tab !== "raw"} className="min-w-0">
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-sm bg-card-2 p-3 font-mono text-[11.5px] leading-5">{raw}</pre>
      </div>
    </CardContent>
  </Card>;
}
