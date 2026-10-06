import { evidenceObject } from "./trace-evidence.js";
import { parseViewSpecs, type ViewSpec } from "./view-spec.js";

// SPIKE: view mods. A mod adds a display-only view of a case's recorded
// evidence. It is selected only by an explicit declaration on the case, never
// by guessing from the payload shape, and comes in two kinds:
//   - declared: a description (view-spec.ts) that Rubrist draws itself;
//   - frame: one self-contained HTML document drawn inside a sandboxed frame,
//     for views the declared kinds cannot express.
// Every mod file is pinned by its SHA-256, so a file that changed since it
// was pinned is not shown until someone pins it again.
export const VIEW_MOD_CONTRACT = "rubrist/view-mod/v1";
export const VIEW_MOD_INDEX_PATH = "/mods/index.json";

interface ViewModBase {
  id: string;
  name: string;
  version: string;
  contract: typeof VIEW_MOD_CONTRACT;
  renders: string[];
}
export type ViewModManifest =
  | (ViewModBase & { kind: "declared"; views: ViewSpec[] })
  | (ViewModBase & { kind: "frame"; entry: string; entrySha256: string; height: number });

const MOD_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.html$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const VIEW_MOD_MIN_HEIGHT = 120;
export const VIEW_MOD_MAX_HEIGHT = 900;

export function clampViewModHeight(value: unknown, fallback = 420): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(VIEW_MOD_MAX_HEIGHT, Math.max(VIEW_MOD_MIN_HEIGHT, Math.round(value))) : fallback;
}

// The folder name is the identity: a manifest cannot claim another mod's id,
// and a frame entry cannot leave its own folder. A mod is one kind or the
// other, never both.
export function parseViewModManifest(value: unknown, folder: string): ViewModManifest | null {
  const record = evidenceObject(value);
  if (!record || !MOD_ID.test(folder) || record.id !== folder || record.contract !== VIEW_MOD_CONTRACT) return null;
  const { name, version, renders } = record;
  if (typeof name !== "string" || !name.trim() || name.length > 80) return null;
  if (typeof version !== "string" || !version.trim() || version.length > 40) return null;
  if (!Array.isArray(renders) || renders.length === 0 || !renders.every(item => typeof item === "string" && item.length > 0 && item.length <= 120)) return null;
  const base = { id: folder, name: name.trim(), version: version.trim(), contract: VIEW_MOD_CONTRACT, renders: renders as string[] } as const;
  if ((record.views === undefined) === (record.entry === undefined)) return null;
  if (record.views !== undefined) {
    const views = parseViewSpecs(record.views);
    return views ? { ...base, kind: "declared", views } : null;
  }
  const { entry, entrySha256 } = record;
  if (typeof entry !== "string" || !ENTRY.test(entry) || typeof entrySha256 !== "string" || !SHA256.test(entrySha256)) return null;
  return { ...base, kind: "frame", entry, entrySha256, height: clampViewModHeight(record.height) };
}

export function declaredEvidenceView(metadata: unknown): string | null {
  const view = evidenceObject(metadata)?.evidenceView;
  return typeof view === "string" && view.length > 0 ? view : null;
}

// First installed mod wins; installation order is the index order.
export function viewModFor(metadata: unknown, mods: readonly ViewModManifest[]): ViewModManifest | null {
  const view = declaredEvidenceView(metadata);
  return view === null ? null : mods.find(mod => mod.renders.includes(view)) ?? null;
}

// No fetch, socket, image, script or form request, and no base rewriting.
// Inline script and style are the only executable sources, so a frame mod must
// ship as one document. This policy cannot stop the frame navigating itself
// away; the host page's frame policy (applyViewFramePolicy) is what blocks that.
export const VIEW_MOD_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'"
].join("; ");

// The policy precedes every byte the mod supplies, so the mod cannot run
// before it or replace it; a later policy can only narrow it further.
export function sandboxedViewModDocument(modHtml: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VIEW_MOD_CSP}">${modHtml}`;
}

export interface ViewModEvidenceMessage {
  type: "rubrist:evidence";
  contract: typeof VIEW_MOD_CONTRACT;
  evidence: { input: unknown; output: unknown; steps: unknown; metadata: unknown };
  // Only what the ordinary case view already shows beside the evidence.
  evaluatorFailingStep: number | null;
  theme: { scheme: "light" | "dark"; tokens: Record<string, string> };
}

export type ViewModRequest = { type: "rubrist:ready" } | { type: "rubrist:resize"; height: number };

// Anything a frame mod says outside this vocabulary is dropped.
export function parseViewModRequest(data: unknown): ViewModRequest | null {
  const record = evidenceObject(data);
  if (record?.type === "rubrist:ready") return { type: "rubrist:ready" };
  if (record?.type === "rubrist:resize" && typeof record.height === "number" && Number.isFinite(record.height)) {
    return { type: "rubrist:resize", height: clampViewModHeight(record.height) };
  }
  return null;
}

export type ViewModSkipReason = "changed" | "unverifiable" | "invalid" | "missing";
export class ViewModPinError extends Error {
  constructor(readonly reason: ViewModSkipReason) { super(`View mod file ${reason}`); }
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  // Browsers expose the digest only on HTTPS and localhost.
  if (!globalThis.crypto?.subtle) return null;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

// Fails closed: a file is used only when its bytes match the recorded pin.
export async function pinnedViewModText(bytes: ArrayBuffer, expected: string): Promise<string> {
  const actual = await sha256Hex(bytes);
  if (actual === null) throw new ViewModPinError("unverifiable");
  if (actual !== expected) throw new ViewModPinError("changed");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function fetchPinned(path: string, expected: string): Promise<string> {
  const response = await fetch(path, { credentials: "omit", cache: "no-store" });
  if (!response.ok) throw new ViewModPinError("missing");
  return pinnedViewModText(await response.arrayBuffer(), expected);
}

export interface InstalledViewMods {
  mods: ViewModManifest[];
  skipped: { id: string; reason: ViewModSkipReason }[];
}

// Every address a pinned mod's embed blocks name. Pinning a mod is what
// approves them; no other frame source is allowed on the page.
export function viewModFrameOrigins(mods: readonly ViewModManifest[]): string[] {
  return [...new Set(mods.flatMap(mod => mod.kind === "declared" ? mod.views.flatMap(view => view.kind === "embed" ? [view.origin] : []) : []))].sort();
}

export function viewFramePolicy(origins: readonly string[]): string {
  return `frame-src ${origins.length > 0 ? origins.join(" ") : "'none'"}`;
}

// Applied once, before any view is drawn, so a sandboxed frame can never
// navigate itself to an address no pinned mod names. A policy added to a page
// can only narrow it, so this runs a single time per page load.
function applyViewFramePolicy(origins: readonly string[]): void {
  if (typeof document === "undefined") return;
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = viewFramePolicy(origins);
  policy.dataset.viewFramePolicy = "";
  document.head.append(policy);
}

let installed: Promise<InstalledViewMods> | undefined;

// Installed mods are deployment files, read once per page load. A missing or
// malformed index means no mods; one bad mod does not hide the others.
export function installedViewMods(): Promise<InstalledViewMods> {
  installed ??= (async () => {
    const result: InstalledViewMods = { mods: [], skipped: [] };
    const response = await fetch(VIEW_MOD_INDEX_PATH, { credentials: "omit", cache: "no-store" });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return result;
    const entries = evidenceObject(await response.json())?.mods;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const { id, sha256 } = evidenceObject(entry) ?? {};
      if (typeof id !== "string" || !MOD_ID.test(id) || typeof sha256 !== "string" || !SHA256.test(sha256)) continue;
      try {
        const manifest = parseViewModManifest(JSON.parse(await fetchPinned(`/mods/${id}/mod.json`, sha256)), id);
        if (manifest) result.mods.push(manifest);
        else result.skipped.push({ id, reason: "invalid" });
      } catch (error) {
        result.skipped.push({ id, reason: error instanceof ViewModPinError ? error.reason : "invalid" });
      }
    }
    return result;
  })().catch(() => ({ mods: [], skipped: [] })).then(result => { applyViewFramePolicy(viewModFrameOrigins(result.mods)); return result; });
  return installed;
}

export async function loadViewModDocument(manifest: Extract<ViewModManifest, { kind: "frame" }>): Promise<string> {
  return sandboxedViewModDocument(await fetchPinned(`/mods/${manifest.id}/${manifest.entry}`, manifest.entrySha256));
}

export function viewModSkipText(reason: ViewModSkipReason): string {
  if (reason === "changed") return "its files changed since they were pinned";
  if (reason === "unverifiable") return "this page cannot verify its files (that needs HTTPS or localhost)";
  if (reason === "missing") return "its files could not be loaded";
  return "its description is not valid";
}
