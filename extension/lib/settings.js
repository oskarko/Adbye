// Persistent user settings. Everything AdBlock gates behind a license is a
// plain setting here.

export const DEFAULTS = {
  paused: false,
  // null until first run, then the ids of the enabled filter lists.
  enabledLists: null,
  allowlist: [],
  customFilters: "",
  // [{ url, title, text, updatedAt, error }]
  customLists: [],
  ytChannels: [],
  imageSwap: { enabled: false, channel: "cats" },
  blockNotifications: true,
  showBadge: true,
  contextMenu: true,
  themes: { popup: "default", options: "default" },
  sync: false,
  updatedAt: 0,
};

let cache = null;

export async function getSettings() {
  if (cache) return cache;
  const { settings } = await chrome.storage.local.get("settings");
  cache = { ...structuredClone(DEFAULTS), ...(settings || {}) };
  return cache;
}

export async function saveSettings(patch, { touch = true } = {}) {
  const current = await getSettings();
  cache = { ...current, ...patch };
  if (touch) cache.updatedAt = Date.now();
  await chrome.storage.local.set({ settings: cache });
  return cache;
}

/** Drops the in-memory copy, e.g. after another context wrote storage. */
export function invalidateSettings() {
  cache = null;
}

export async function getCatalog() {
  const res = await fetch(chrome.runtime.getURL("lists.json"));
  return res.json();
}

/** Lists enabled on first run: the defaults plus the browser language's list. */
export async function defaultEnabledLists() {
  const catalog = await getCatalog();
  const lang = chrome.i18n.getUILanguage().split("-")[0];
  return catalog
    .filter((list) => list.default || (list.languages || []).includes(lang))
    .map((list) => list.id);
}

export function normalizeHost(input) {
  let host = String(input || "").trim().toLowerCase();
  try {
    if (host.includes("/")) host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
  } catch {
    return "";
  }
  return host.replace(/^www\./, "").replace(/\.$/, "");
}

export function hostMatches(hostname, domains) {
  const host = normalizeHost(hostname);
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}
