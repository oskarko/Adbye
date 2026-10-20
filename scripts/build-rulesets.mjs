#!/usr/bin/env node
// Downloads the filter lists in extension/lists.json and compiles them:
//   - network filters -> extension/rulesets/<id>.json (DNR static rulesets)
//   - element hiding  -> extension/cosmetic/<id>.json (CosmeticIndex)
// and registers the rulesets in extension/manifest.json.
//
// Usage: node scripts/build-rulesets.mjs [--offline]
//   --offline reuses the copies in .cache/ instead of downloading.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parse as parseSelector } from "css-what";

import {
  CosmeticIndex,
  isCosmeticFilter,
  parseCosmeticFilter,
  parseHideException,
} from "../extension/lib/filters.js";

const require = createRequire(import.meta.url);
const { convertFilter } = require("@eyeo/abp2dnr");

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = path.join(ROOT, "extension");
const CACHE = path.join(ROOT, ".cache");
const OFFLINE = process.argv.includes("--offline");

// Chrome limits regex rules per static ruleset.
const MAX_REGEX_RULES = 1000;

const SUPPORTED_PSEUDOS = new Set([
  "not", "is", "where", "has", "matches", "any-link", "link", "visited", "hover", "focus",
  "checked", "disabled", "enabled", "empty", "root", "scope", "target", "lang",
  "first-child", "last-child", "only-child", "first-of-type", "last-of-type", "only-of-type",
  "nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type", "required", "optional",
  "read-only", "read-write", "placeholder-shown", "default", "defined", "focus-within",
]);

function isValidSelector(selector) {
  let parsed;
  try {
    parsed = parseSelector(selector);
  } catch {
    return false;
  }
  const check = (tokens) =>
    tokens.every((token) => {
      if (token.type === "pseudo") {
        if (!SUPPORTED_PSEUDOS.has(token.name)) return false;
        if (Array.isArray(token.data)) return token.data.every(check);
      }
      return true;
    });
  return parsed.every(check);
}

async function download(list) {
  const file = path.join(CACHE, `${list.id}.txt`);
  if (OFFLINE) return fs.readFile(file, "utf8");
  const res = await fetch(list.url, { headers: { "user-agent": "AdBye-build" } });
  if (!res.ok) throw new Error(`${list.id}: HTTP ${res.status} for ${list.url}`);
  const text = await res.text();
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, text);
  return text;
}

async function compile(list, text) {
  const cosmetic = new CosmeticIndex();
  const rules = [];
  const seen = new Set();
  const stats = { network: 0, cosmetic: 0, skipped: 0, regexDropped: 0 };
  let regexCount = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("!") || line.startsWith("[")) continue;

    if (isCosmeticFilter(line)) {
      const filter = parseCosmeticFilter(line);
      if (filter && isValidSelector(filter.selector)) {
        cosmetic.addFilter(filter);
        stats.cosmetic++;
      } else {
        stats.skipped++;
      }
      continue;
    }

    const hideException = parseHideException(line);
    if (hideException) {
      cosmetic.addHideException(hideException);
      continue;
    }

    let converted;
    try {
      converted = await convertFilter(line);
    } catch {
      stats.skipped++;
      continue;
    }
    for (const rule of converted) {
      const key = JSON.stringify(rule);
      if (seen.has(key)) continue;
      seen.add(key);
      if (rule.condition.regexFilter) {
        if (regexCount >= MAX_REGEX_RULES) {
          stats.regexDropped++;
          continue;
        }
        regexCount++;
      }
      rule.id = rules.length + 1;
      rules.push(rule);
    }
    if (converted.length) stats.network++;
    else stats.skipped++;
  }

  return { rules, cosmetic, stats };
}

async function main() {
  const lists = JSON.parse(await fs.readFile(path.join(EXT, "lists.json"), "utf8"));
  await fs.mkdir(path.join(EXT, "rulesets"), { recursive: true });
  await fs.mkdir(path.join(EXT, "cosmetic"), { recursive: true });

  const meta = { builtAt: new Date().toISOString(), lists: {} };
  for (const list of lists) {
    process.stdout.write(`${list.id.padEnd(16)} `);
    const text = await download(list);
    const { rules, cosmetic, stats } = await compile(list, text);
    await fs.writeFile(path.join(EXT, "rulesets", `${list.id}.json`), JSON.stringify(rules));
    await fs.writeFile(path.join(EXT, "cosmetic", `${list.id}.json`), JSON.stringify(cosmetic));
    meta.lists[list.id] = { rules: rules.length, ...stats };
    console.log(
      `${rules.length} DNR rules, ${stats.cosmetic} cosmetic, ${stats.skipped} skipped` +
        (stats.regexDropped ? `, ${stats.regexDropped} regex over limit` : ""),
    );
  }
  await fs.writeFile(path.join(EXT, "rulesets", "meta.json"), JSON.stringify(meta, null, 2));

  const manifestPath = path.join(EXT, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.declarative_net_request = {
    rule_resources: lists.map((list) => ({
      id: list.id,
      enabled: Boolean(list.default),
      path: `rulesets/${list.id}.json`,
    })),
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Registered ${lists.length} rulesets in manifest.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
