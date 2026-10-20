// Applies settings to Chrome: static rulesets, dynamic rules for the user's
// filters and allowlist, session rules for paused tabs, and element hiding.

import { CosmeticIndex, PRIORITY, parseFilterText, selectorsToCss } from "./filters.js";
import { getCatalog, getSettings, hostMatches, normalizeHost } from "./settings.js";

const TAB_RULE_ID = 1;
const MAX_DYNAMIC_RULES = 30000;
// Lists whose hidden elements may be swapped for pictures; the rest
// (cookies, annoyances, social...) are always collapsed.
const SWAP_CATEGORIES = new Set(["ads", "language"]);
const COLLAPSE_CSS =
  "[data-adbye-collapse], [data-adbye-swapped] { display: none !important; }";

let cosmetic = null;
let swapIndex = null;
let genericCssCache = new Map();
let lastCustom = { invalid: [], dropped: 0 };

export const tabState = {
  async get() {
    const { tabs } = await chrome.storage.session.get("tabs");
    return tabs || { paused: [], ytAllowed: [], channels: {} };
  },
  async update(fn) {
    const tabs = await this.get();
    fn(tabs);
    await chrome.storage.session.set({ tabs });
    return tabs;
  },
};

async function recordError(key, error) {
  const { errors = {} } = await chrome.storage.session.get("errors");
  if (error) errors[key] = String(error.message || error);
  else delete errors[key];
  await chrome.storage.session.set({ errors });
}

export async function applyRulesets() {
  const settings = await getSettings();
  const catalog = await getCatalog();
  const wanted = new Set(settings.paused ? [] : settings.enabledLists || []);
  const current = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());
  // Big lists are split into <id>, <id>__2, ... (see build-rulesets.mjs).
  const listOf = (rulesetId) => rulesetId.split("__")[0];
  const known = new Set(catalog.map((l) => l.id));
  const all = chrome.runtime.getManifest().declarative_net_request.rule_resources.map((r) => r.id);
  const enableRulesetIds = all.filter((id) => known.has(listOf(id)) && wanted.has(listOf(id)) && !current.has(id));
  const disableRulesetIds = [...current].filter((id) => !wanted.has(listOf(id)));
  if (!enableRulesetIds.length && !disableRulesetIds.length) return;
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
    await recordError("rulesets", null);
  } catch (error) {
    // Usually the browser-wide static rule pool is exhausted.
    await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds }).catch(() => {});
    await recordError("rulesets", error);
  }
}

function customFilterText(settings) {
  return [settings.customFilters, ...settings.customLists.map((l) => l.text || "")].join("\n");
}

export async function applyDynamicRules() {
  const settings = await getSettings();
  const { rules, invalid } = parseFilterText(customFilterText(settings));
  const allowlist = settings.allowlist.filter(Boolean);
  if (allowlist.length) {
    rules.unshift({
      priority: PRIORITY.allowlist,
      action: { type: "allowAllRequests" },
      condition: { requestDomains: allowlist, resourceTypes: ["main_frame", "sub_frame"] },
    });
  }
  const kept = rules.slice(0, MAX_DYNAMIC_RULES).map((rule, i) => ({ ...rule, id: i + 1 }));
  lastCustom = { invalid, dropped: rules.length - kept.length };

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: kept });
    await recordError("dynamic", null);
  } catch (error) {
    // One bad rule (e.g. an unsupported regex) rejects the whole batch; fall
    // back to adding rules one by one so the rest still apply.
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    let failed = 0;
    for (const rule of kept) {
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] }).catch(() => failed++);
    }
    await recordError("dynamic", failed ? `${failed} custom rules were rejected by the browser` : null);
  }
}

export function customFilterReport() {
  return lastCustom;
}

export async function applySessionRules() {
  const tabs = await tabState.get();
  const tabIds = [...new Set([...tabs.paused, ...tabs.ytAllowed])];
  const addRules = tabIds.length
    ? [
        {
          id: TAB_RULE_ID,
          priority: PRIORITY.allowlist,
          action: { type: "allowAllRequests" },
          condition: { tabIds, resourceTypes: ["main_frame", "sub_frame"] },
        },
      ]
    : [];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [TAB_RULE_ID], addRules });
}

export async function loadCosmetics() {
  const settings = await getSettings();
  const catalog = await getCatalog();
  const enabled = new Set(settings.enabledLists || []);
  const index = new CosmeticIndex();
  const swap = new CosmeticIndex();
  await Promise.all(
    catalog
      .filter((list) => enabled.has(list.id))
      .map(async (list) => {
        const res = await fetch(chrome.runtime.getURL(`cosmetic/${list.id}.json`));
        const data = new CosmeticIndex(await res.json());
        (SWAP_CATEGORIES.has(list.category) ? swap : index).merge(data);
      }),
  );
  index.merge(parseFilterText(customFilterText(settings)).cosmetic);
  cosmetic = index;
  swapIndex = swap;
  genericCssCache = new Map();
}

/** Whether AdBye should filter a page with this top-level URL in this tab. */
export async function isActiveFor(tabId, topUrl) {
  const settings = await getSettings();
  if (settings.paused) return false;
  let url;
  try {
    url = new URL(topUrl);
  } catch {
    return true;
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  if (hostMatches(url.hostname, settings.allowlist)) return false;
  const tabs = await tabState.get();
  return !tabs.paused.includes(tabId) && !tabs.ytAllowed.includes(tabId);
}

function genericCss(index, exceptions, declaration) {
  const key = `${index === swapIndex ? "s" : "h"}:${declaration}:${exceptions.join("\n")}`;
  let css = genericCssCache.get(key);
  if (css === undefined) {
    // Build-time validated selectors, so grouping them is safe.
    css = selectorsToCss(index.genericSelectors(exceptions), declaration, 50);
    if (genericCssCache.size > 50) genericCssCache.clear();
    genericCssCache.set(key, css);
  }
  return css;
}

function cssFor(index, hostname, declaration) {
  const { specific, generic, exceptions } = index.lookup(hostname);
  const parts = [];
  if (generic) parts.push(genericCss(index, exceptions, declaration));
  // User and specific selectors are not validated; one rule each so an
  // invalid selector only drops itself.
  parts.push(selectorsToCss(specific, declaration));
  return { css: parts.join("\n"), selectors: generic ? [...specific, ...index.genericSelectors(exceptions)] : specific };
}

/**
 * Injects element hiding CSS into a frame. With image swap on, ad selectors
 * in the top frame are only made invisible so the content script can
 * measure them and put a picture in their place.
 */
export async function injectCosmetics({ tabId, frameId, hostname }) {
  if (!cosmetic) await loadCosmetics();
  const settings = await getSettings();
  const swapping = settings.imageSwap.enabled && frameId === 0;
  const hidden = "display: none !important;";
  const parts = [cssFor(cosmetic, hostname, hidden).css];
  let swapSelectors = [];
  if (swapping) {
    const swap = cssFor(swapIndex, hostname, "visibility: hidden !important;");
    parts.push(swap.css, COLLAPSE_CSS);
    swapSelectors = swap.selectors;
  } else {
    parts.push(cssFor(swapIndex, hostname, hidden).css);
  }
  await chrome.scripting
    .insertCSS({ target: { tabId, frameIds: [frameId] }, css: parts.join("\n"), origin: "USER" })
    .catch(() => {});
  return { swapSelectors };
}

/** Immediately hides a selector the user just picked, in every frame of the tab. */
export async function hideNow(tabId, selector) {
  await chrome.scripting
    .insertCSS({
      target: { tabId, allFrames: true },
      css: `${selector} { display: none !important; }`,
      origin: "USER",
    })
    .catch(() => {});
}

export async function applyAll() {
  await applyRulesets();
  await applyDynamicRules();
  await applySessionRules();
  await loadCosmetics();
}

export { normalizeHost };
