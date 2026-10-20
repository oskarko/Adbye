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
// addons.mozilla.org rejects text files over 5 MB, so big lists are split
// into several rulesets: <id>, <id>__2, <id>__3...
const MAX_RULESET_BYTES = 4 * 1024 * 1024;

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

  return { rules: mergeDomainRules(rules), cosmetic, stats };
}

const PURE_DOMAIN = /^\|\|([a-z0-9-]+(?:\.[a-z0-9-]+)+)\^$/;

/**
 * Merges rules that only differ in a `||domain^` urlFilter into one rule with
 * `requestDomains` (which also matches subdomains, like `||`). EasyList and
 * EasyPrivacy are mostly such rules, so this shrinks ~136k rules to ~27k:
 * enough to fit Firefox's 30k static rule limit and to spare Chrome's
 * browser-wide rule pool.
 */
function mergeDomainRules(rules) {
  const groups = new Map();
  const out = [];
  for (const rule of rules) {
    const { urlFilter, ...rest } = rule.condition;
    const match = PURE_DOMAIN.exec(urlFilter || "");
    const mergeable =
      match && (rule.action.type === "block" || rule.action.type === "allow") &&
      !rest.requestDomains && !rest.isUrlFilterCaseSensitive;
    if (!mergeable) {
      out.push(rule);
      continue;
    }
    const key = JSON.stringify([rule.action, rule.priority, Object.entries(rest).sort()]);
    let group = groups.get(key);
    if (!group) {
      group = { priority: rule.priority, condition: { ...rest, requestDomains: [] }, action: rule.action };
      groups.set(key, group);
      out.push(group);
    }
    group.condition.requestDomains.push(match[1]);
  }
  for (const group of groups.values()) group.condition.requestDomains = [...new Set(group.condition.requestDomains)];
  return out.map((rule, i) => ({ ...rule, id: i + 1 }));
}

/** Splits rules into chunks whose JSON stays under MAX_RULESET_BYTES. */
function splitRules(rules) {
  const parts = [[]];
  let size = 2;
  for (const rule of rules) {
    const bytes = JSON.stringify(rule).length + 1;
    if (size + bytes > MAX_RULESET_BYTES && parts.at(-1).length) {
      parts.push([]);
      size = 2;
    }
    parts.at(-1).push(rule);
    size += bytes;
  }
  return parts;
}

async function main() {
  const lists = JSON.parse(await fs.readFile(path.join(EXT, "lists.json"), "utf8"));
  await fs.rm(path.join(EXT, "rulesets"), { recursive: true, force: true });
  await fs.mkdir(path.join(EXT, "rulesets"), { recursive: true });
  await fs.mkdir(path.join(EXT, "cosmetic"), { recursive: true });

  const meta = { builtAt: new Date().toISOString(), lists: {} };
  const resources = [];
  for (const list of lists) {
    process.stdout.write(`${list.id.padEnd(16)} `);
    const text = await download(list);
    const { rules, cosmetic, stats } = await compile(list, text);
    const rulesets = splitRules(rules).map((part, i) => ({ id: i ? `${list.id}__${i + 1}` : list.id, rules: part }));
    for (const ruleset of rulesets) {
      await fs.writeFile(path.join(EXT, "rulesets", `${ruleset.id}.json`), JSON.stringify(ruleset.rules));
    }
    resources.push(...rulesets.map(({ id }) => ({ id, enabled: Boolean(list.default), path: `rulesets/${id}.json` })));
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
    rule_resources: resources,
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Registered ${resources.length} rulesets for ${lists.length} lists in manifest.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
