#!/usr/bin/env node
// SPIKE: records the current SHA-256 of every view mod file. Running it is the
// stand-in for an owner approving a mod: until it runs again, a changed file is
// not shown. Usage: node tools/pin-view-mods.mjs [mods directory]
// apps/web/public/mods is not tracked and ships empty, so a build has no mods;
// to try the examples locally, copy apps/web/examples/view-mods/* there and
// run this.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "apps/web/public/mods";
const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const mods = [];
for (const entry of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const manifestPath = join(root, entry.name, "mod.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof manifest.entry === "string") {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.html$/.test(manifest.entry)) throw new Error(`${entry.name}: entry must be one .html file in the mod folder`);
    manifest.entrySha256 = sha256(join(root, entry.name, manifest.entry));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  mods.push({ id: entry.name, sha256: sha256(manifestPath) });
  console.log(`pinned ${entry.name}`);
}
writeFileSync(join(root, "index.json"), `${JSON.stringify({ mods }, null, 2)}\n`);
