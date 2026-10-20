// Settings sync through chrome.storage.sync (AdBlock Premium's "Sync"), and
// JSON backups. Sync items are limited to 8 KB, so custom filters are chunked.

import { DEFAULTS, getSettings, invalidateSettings, saveSettings } from "./settings.js";

const CHUNK = 7000;
// Settings that travel between devices. Custom list contents are re-downloaded.
const SYNCED = [
  "enabledLists", "allowlist", "ytChannels", "imageSwap", "blockNotifications",
  "showBadge", "contextMenu", "themes",
];

function pick(settings) {
  const out = {};
  for (const key of SYNCED) out[key] = settings[key];
  out.customLists = settings.customLists.map(({ url, title }) => ({ url, title }));
  return out;
}

export async function pushSync() {
  const settings = await getSettings();
  if (!settings.sync) return;
  const filters = settings.customFilters;
  const chunks = {};
  for (let i = 0; i * CHUNK < filters.length; i++) chunks[`filters_${i}`] = filters.slice(i * CHUNK, (i + 1) * CHUNK);
  const count = Object.keys(chunks).length;
  const old = await chrome.storage.sync.get("meta");
  const stale = [];
  for (let i = count; i < (old.meta?.chunks || 0); i++) stale.push(`filters_${i}`);
  await chrome.storage.sync.set({
    meta: { updatedAt: settings.updatedAt, chunks: count },
    settings: pick(settings),
    ...chunks,
  });
  if (stale.length) await chrome.storage.sync.remove(stale);
}

/** Applies remote settings when they are newer. Returns true if anything changed. */
export async function pullSync() {
  const settings = await getSettings();
  if (!settings.sync) return false;
  const { meta, settings: remote } = await chrome.storage.sync.get(["meta", "settings"]);
  if (!meta || !remote || meta.updatedAt <= settings.updatedAt) return false;
  const keys = Array.from({ length: meta.chunks }, (_, i) => `filters_${i}`);
  const chunks = keys.length ? await chrome.storage.sync.get(keys) : {};
  const customFilters = keys.map((k) => chunks[k] || "").join("");
  const known = new Map(settings.customLists.map((l) => [l.url, l]));
  const customLists = (remote.customLists || []).map((l) => known.get(l.url) || { ...l, text: "" });
  await saveSettings({ ...remote, customLists, customFilters, updatedAt: meta.updatedAt }, { touch: false });
  return true;
}

export async function exportBackup() {
  const settings = await getSettings();
  const { swapImages = [] } = await chrome.storage.local.get("swapImages");
  return {
    format: "adbye-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: { ...pick(settings), customFilters: settings.customFilters, paused: settings.paused },
    swapImages,
  };
}

export async function importBackup(backup) {
  if (backup?.format !== "adbye-backup" || typeof backup.settings !== "object") {
    throw new Error("Not an AdBye backup file");
  }
  const patch = {};
  for (const key of [...SYNCED, "customFilters", "paused"]) {
    const value = backup.settings[key];
    const expected = Array.isArray(DEFAULTS[key]) || key === "enabledLists" ? "array" : typeof DEFAULTS[key];
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (actual === expected) patch[key] = value;
  }
  if (Array.isArray(backup.settings.customLists)) {
    patch.customLists = backup.settings.customLists
      .filter((l) => typeof l?.url === "string")
      .map(({ url, title }) => ({ url, title: String(title || url), text: "" }));
  }
  if (Array.isArray(backup.swapImages)) {
    await chrome.storage.local.set({ swapImages: backup.swapImages.filter((s) => typeof s === "string" && s.startsWith("data:image/")) });
  }
  invalidateSettings();
  await saveSettings(patch);
}
