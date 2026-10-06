import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VIEW_MOD_CONTRACT,
  ViewModPinError,
  clampViewModHeight,
  declaredEvidenceView,
  parseViewModManifest,
  parseViewModRequest,
  pinnedViewModText,
  sandboxedViewModDocument,
  sha256Hex,
  viewFramePolicy,
  viewModFor,
  viewModFrameOrigins
} from "../src/lib/view-mods.js";

const modFile = (path: string) => readFileSync(new URL(`../public/mods/${path}`, import.meta.url));
const shipped = (id: string) => JSON.parse(modFile(`${id}/mod.json`).toString("utf8"));
const bytes = (buffer: Buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
const frame = { id: "html-view", name: "HTML view", version: "0.1.0", contract: VIEW_MOD_CONTRACT, renders: ["thing/v1"], entry: "view.html", entrySha256: "a".repeat(64), height: 460 };

describe("view mod manifests", () => {
  it("accepts the shipped declared and frame mods", () => {
    expect(parseViewModManifest(shipped("n8n-execution"), "n8n-execution")).toMatchObject({ kind: "declared", renders: ["n8n-execution/v1"] });
    expect(parseViewModManifest(shipped("n8n-execution-html"), "n8n-execution-html")).toMatchObject({ kind: "frame", entry: "view.html" });
  });

  it("rejects a manifest that claims another id, contract, or an entry outside its folder", () => {
    expect(parseViewModManifest(frame, "html-view")).toMatchObject({ kind: "frame" });
    expect(parseViewModManifest(frame, "other-mod")).toBeNull();
    expect(parseViewModManifest({ ...frame, contract: "rubrist/view-mod/v2" }, "html-view")).toBeNull();
    for (const entry of ["../view.html", "/view.html", "https://example.com/view.html", "nested/view.html", "view.js"]) {
      expect(parseViewModManifest({ ...frame, entry }, "html-view")).toBeNull();
    }
    expect(parseViewModManifest({ ...frame, renders: [] }, "html-view")).toBeNull();
    expect(parseViewModManifest(null, "html-view")).toBeNull();
  });

  it("requires a frame entry to be pinned, and a mod to be one kind only", () => {
    expect(parseViewModManifest({ ...frame, entrySha256: "" }, "html-view")).toBeNull();
    expect(parseViewModManifest({ ...frame, views: shipped("n8n-execution").views }, "html-view")).toBeNull();
    const { entry: _entry, entrySha256: _pin, ...neither } = frame;
    expect(parseViewModManifest(neither, "html-view")).toBeNull();
    expect(parseViewModManifest({ ...neither, views: [{ kind: "chart" }] }, "html-view")).toBeNull();
    expect(parseViewModManifest({ ...neither, views: shipped("langtracer-finding").views }, "html-view")).toMatchObject({ kind: "declared" });
  });

  it("clamps a declared height", () => {
    expect(parseViewModManifest({ ...frame, height: 100000 }, "html-view")).toMatchObject({ height: 900 });
    expect(parseViewModManifest({ ...frame, height: "tall" }, "html-view")).toMatchObject({ height: 420 });
  });
});

describe("view mod pins", () => {
  it("match the shipped files, so the index and the frame entry load", async () => {
    const index = JSON.parse(modFile("index.json").toString("utf8")) as { mods: { id: string; sha256: string }[] };
    expect(index.mods.map(mod => mod.id)).toEqual(["langtracer-finding", "n8n-execution", "n8n-execution-html"]);
    for (const mod of index.mods) expect(await sha256Hex(bytes(modFile(`${mod.id}/mod.json`)))).toBe(mod.sha256);
    const html = shipped("n8n-execution-html");
    expect(await sha256Hex(bytes(modFile(`n8n-execution-html/${html.entry}`)))).toBe(html.entrySha256);
  });

  it("refuse a file whose bytes differ from the pin", async () => {
    const original = Buffer.from("<p>view</p>");
    const pin = (await sha256Hex(bytes(original)))!;
    expect(await pinnedViewModText(bytes(original), pin)).toBe("<p>view</p>");
    await expect(pinnedViewModText(bytes(Buffer.from("<p>view</p> ")), pin)).rejects.toMatchObject({ reason: "changed" });
    await expect(pinnedViewModText(bytes(original), "0".repeat(64))).rejects.toBeInstanceOf(ViewModPinError);
  });
});

describe("view frame policy", () => {
  it("allows only the addresses pinned mods name, and none when there are none", () => {
    const mods = ["langtracer-finding", "n8n-execution", "n8n-execution-html"].map(id => parseViewModManifest(shipped(id), id)!);
    expect(viewModFrameOrigins(mods)).toEqual(["https://n8n-preview-service.internal.n8n.cloud"]);
    expect(viewFramePolicy(viewModFrameOrigins(mods))).toBe("frame-src https://n8n-preview-service.internal.n8n.cloud");
    expect(viewFramePolicy(viewModFrameOrigins(mods.filter(mod => mod.id !== "n8n-execution")))).toBe("frame-src 'none'");
  });
});

describe("view mod selection", () => {
  const mods = [parseViewModManifest(frame, "html-view")!];

  it("selects a mod only from the case's explicit declaration", () => {
    expect(viewModFor({ evidenceView: "thing/v1" }, mods)?.id).toBe("html-view");
    expect(viewModFor({ evidenceView: "thing/v2" }, mods)).toBeNull();
    expect(viewModFor({ source: "thing" }, mods)).toBeNull();
    expect(viewModFor(null, mods)).toBeNull();
    expect(declaredEvidenceView({ evidenceView: 7 })).toBeNull();
  });
});

describe("view mod sandbox document", () => {
  it("puts the policy before anything the mod supplies", () => {
    const html = sandboxedViewModDocument("<script>fetch('https://example.com')</script>");
    expect(html.indexOf("Content-Security-Policy")).toBeGreaterThan(0);
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script>"));
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("form-action 'none'");
  });
});

describe("view mod requests", () => {
  it("accepts only ready and a bounded resize", () => {
    expect(parseViewModRequest({ type: "rubrist:ready", extra: 1 })).toEqual({ type: "rubrist:ready" });
    expect(parseViewModRequest({ type: "rubrist:resize", height: 99999 })).toEqual({ type: "rubrist:resize", height: 900 });
    expect(parseViewModRequest({ type: "rubrist:resize", height: "9" })).toBeNull();
    expect(parseViewModRequest({ type: "rubrist:record-label", label: "pass" })).toBeNull();
    expect(parseViewModRequest("rubrist:ready")).toBeNull();
    expect(clampViewModHeight(Number.NaN)).toBe(420);
  });
});
