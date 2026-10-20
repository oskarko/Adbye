// Blocked request counters. DNR blocks surface in webRequest as
// net::ERR_BLOCKED_BY_CLIENT, which needs no feedback permission.

import { getSettings } from "./settings.js";

const DAYS_KEPT = 30;
const TOP_DOMAINS_KEPT = 200;

let stats = null;
let saveTimer = null;
const tabCounts = new Map();

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function load() {
  if (stats) return stats;
  const stored = await chrome.storage.local.get("stats");
  stats = stored.stats || { total: 0, since: Date.now(), days: {}, domains: {} };
  const session = await chrome.storage.session.get("tabCounts");
  for (const [id, n] of Object.entries(session.tabCounts || {})) tabCounts.set(Number(id), n);
  return stats;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const days = Object.keys(stats.days).sort();
    for (const day of days.slice(0, Math.max(0, days.length - DAYS_KEPT))) delete stats.days[day];
    const domains = Object.entries(stats.domains);
    if (domains.length > TOP_DOMAINS_KEPT * 2) {
      domains.sort((a, b) => b[1] - a[1]);
      stats.domains = Object.fromEntries(domains.slice(0, TOP_DOMAINS_KEPT));
    }
    await chrome.storage.local.set({ stats });
    await chrome.storage.session.set({ tabCounts: Object.fromEntries(tabCounts) });
  }, 2000);
}

async function updateBadge(tabId) {
  const settings = await getSettings();
  const n = tabCounts.get(tabId) || 0;
  const text = settings.showBadge && n ? (n > 999 ? "999+" : String(n)) : "";
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

async function onBlocked(details) {
  if (details.error !== "net::ERR_BLOCKED_BY_CLIENT" || details.tabId < 0) return;
  await load();
  stats.total++;
  const day = today();
  stats.days[day] = (stats.days[day] || 0) + 1;
  try {
    const host = new URL(details.url).hostname.replace(/^www\./, "");
    stats.domains[host] = (stats.domains[host] || 0) + 1;
  } catch {}
  tabCounts.set(details.tabId, (tabCounts.get(details.tabId) || 0) + 1);
  updateBadge(details.tabId);
  scheduleSave();
}

/** Counts elements replaced or hidden by the content script as blocked too. */
export async function countHidden(tabId, n) {
  await load();
  tabCounts.set(tabId, (tabCounts.get(tabId) || 0) + n);
  updateBadge(tabId);
  scheduleSave();
}

export async function getTabCount(tabId) {
  await load();
  return tabCounts.get(tabId) || 0;
}

export async function getStats() {
  await load();
  return stats;
}

export async function resetStats() {
  stats = { total: 0, since: Date.now(), days: {}, domains: {} };
  await chrome.storage.local.set({ stats });
}

export async function refreshBadges() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => updateBadge(t.id)));
}

export function initStats() {
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  chrome.webRequest.onErrorOccurred.addListener(onBlocked, { urls: ["<all_urls>"] });
  chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId }) => {
    if (frameId !== 0) return;
    tabCounts.set(tabId, 0);
    updateBadge(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabCounts.delete(tabId);
    scheduleSave();
  });
}
