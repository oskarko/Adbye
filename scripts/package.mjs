#!/usr/bin/env node
// Zips extension/ into dist/adbye-<version>.zip for the Chrome Web Store or
// for loading elsewhere. Uses the system `zip` command.

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = path.join(ROOT, "extension");
const manifest = JSON.parse(await fs.readFile(path.join(EXT, "manifest.json"), "utf8"));

for (const { path: file } of manifest.declarative_net_request.rule_resources) {
  await fs.access(path.join(EXT, file)).catch(() => {
    throw new Error(`Missing ${file}; run npm run build:lists first`);
  });
}

const dist = path.join(ROOT, "dist");
await fs.mkdir(dist, { recursive: true });
const out = path.join(dist, `adbye-${manifest.version}.zip`);
await fs.rm(out, { force: true });
execFileSync("zip", ["-r", "-q", "-X", out, ".", "-x", "*.DS_Store", "_metadata/*"], { cwd: EXT, stdio: "inherit" });
const { size } = await fs.stat(out);
console.log(`${path.relative(ROOT, out)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
