// AdBye service worker: wires settings, the blocking engine, stats, sync and
// the UI pages together.

import {
  applyAll, applyDynamicRules, applyRulesets, applySessionRules, customFilterReport, hideNow,
  injectCosmetics, isActiveFor, loadCosmetics, tabState,
} from "./lib/engine.js";
import {
  defaultEnabledLists, getCatalog, getSettings, hostMatches, invalidateSettings, normalizeHost, saveSettings,
} from "./lib/settings.js";
import { countHidden, getStats, getTabCount, initStats, refreshBadges, resetStats } from "./lib/stats.js";
import { exportBackup, importBackup, pullSync, pushSync } from "./lib/sync.js";

const CUSTOM_LIST_MAX_AGE = 24 * 60 * 60 * 1000;
const NOTIFICATIONS_SCRIPT_ID = "no-notifications";

initStats();

// ---------------------------------------------------------------- setup

async function firstRun() {
  const settings = await getSettings();
  if (settings.enabledLists === null) {
    await saveSettings({ enabledLists: await defaultEnabledLists() }, { touch: false });
  }
}

async function setup() {
  await firstRun();
  await pullSync().catch(() => {});
  await applyAll();
  await refreshCustomLists();
  await updateNotificationBlocking();
  await updateContextMenu();
  await updateIcon();
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await setup();
  if (reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(setup);

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync" || !changes.meta) return;
  if (await pullSync().catch(() => false)) await afterSettingsChange(Object.keys(await getSettings()));
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tabs = await tabState.update((t) => {
    t.paused = t.paused.filter((id) => id !== tabId);
    t.ytAllowed = t.ytAllowed.filter((id) => id !== tabId);
    delete t.channels[tabId];
  });
  if (tabs) await applySessionRules();
});

// ---------------------------------------------------------- settings flow

async function afterSettingsChange(keys) {
  const has = (...names) => names.some((n) => keys.includes(n));
  if (has("paused", "enabledLists")) await applyRulesets();
  if (has("customFilters", "customLists", "allowlist")) await applyDynamicRules();
  if (has("enabledLists", "customFilters", "customLists")) await loadCosmetics();
  if (has("blockNotifications", "allowlist", "paused")) await updateNotificationBlocking();
  if (has("contextMenu")) await updateContextMenu();
  if (has("showBadge")) await refreshBadges();
  if (has("paused")) await updateIcon();
  await pushSync().catch(() => {});
}

async function updateSettings(patch) {
  await saveSettings(patch);
  await afterSettingsChange(Object.keys(patch));
}

async function updateIcon() {
  const { paused } = await getSettings();
  const suffix = paused ? "-paused" : "";
  await chrome.action.setIcon({
    path: { 16: `icons/icon-16${suffix}.png`, 32: `icons/icon-32${suffix}.png` },
  }).catch(() => {});
}

// ----------------------------------------------------- custom filter lists

async function fetchList(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (/^\s*</.test(text)) throw new Error("Not a filter list");
  const title = /^!\s*Title:\s*(.+)$/m.exec(text)?.[1]?.trim();
  return { text, title };
}

async function refreshCustomLists({ force = false } = {}) {
  const settings = await getSettings();
  let changed = false;
  const lists = await Promise.all(
    settings.customLists.map(async (list) => {
      if (!force && list.text && Date.now() - (list.updatedAt || 0) < CUSTOM_LIST_MAX_AGE) return list;
      changed = true;
      try {
        const { text, title } = await fetchList(list.url);
        return { ...list, text, title: list.title && list.title !== list.url ? list.title : title || list.url, updatedAt: Date.now(), error: null };
      } catch (error) {
        return { ...list, error: String(error.message || error) };
      }
    }),
  );
  if (changed) {
    await saveSettings({ customLists: lists }, { touch: false });
    await afterSettingsChange(["customLists"]);
  }
}

async function addCustomList(url) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http(s) URLs are supported");
  const settings = await getSettings();
  if (settings.customLists.some((l) => l.url === parsed.href)) return;
  const { text, title } = await fetchList(parsed.href);
  await updateSettings({
    customLists: [...settings.customLists, { url: parsed.href, title: title || parsed.href, text, updatedAt: Date.now(), error: null }],
  });
}

// ------------------------------------------------------ notification denial

async function updateNotificationBlocking() {
  const settings = await getSettings();
  await chrome.scripting.unregisterContentScripts({ ids: [NOTIFICATIONS_SCRIPT_ID] }).catch(() => {});
  if (!settings.blockNotifications || settings.paused) return;
  const excludeMatches = settings.allowlist.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);
  await chrome.scripting.registerContentScripts([
    {
      id: NOTIFICATIONS_SCRIPT_ID,
      js: ["content/no-notifications.js"],
      matches: ["http://*/*", "https://*/*"],
      excludeMatches,
      runAt: "document_start",
      allFrames: true,
      world: "MAIN",
      persistAcrossSessions: true,
    },
  ]).catch((error) => console.warn("AdBye: notification blocking unavailable", error));
}

// ------------------------------------------------------------ context menu

async function updateContextMenu() {
  await chrome.contextMenus.removeAll();
  const { contextMenu } = await getSettings();
  if (!contextMenu) return;
  const contexts = ["page", "frame", "image", "link", "video"];
  chrome.contextMenus.create({ id: "block-element", title: chrome.i18n.getMessage("menuBlockElement"), contexts });
  chrome.contextMenus.create({ id: "allow-site", title: chrome.i18n.getMessage("menuAllowSite"), contexts: ["page"] });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "block-element") {
    await startPicker(tab.id, info.frameId ?? 0, true);
  } else if (info.menuItemId === "allow-site") {
    await toggleAllowlist(tab.url, true);
    chrome.tabs.reload(tab.id);
  }
});

async function startPicker(tabId, frameId = 0, fromContextMenu = false) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (fromMenu) => { globalThis.__adbyePickFromMenu = fromMenu; },
    args: [fromContextMenu],
  });
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content/picker.js"] });
}

// ---------------------------------------------------------------- actions

async function toggleAllowlist(url, allow) {
  const host = normalizeHost(url);
  if (!host) return;
  const settings = await getSettings();
  // Removing must also drop parent domains that cover this host.
  const allowlist = allow
    ? [...new Set([...settings.allowlist, host])]
    : settings.allowlist.filter((d) => !(host === d || host.endsWith(`.${d}`)));
  await updateSettings({ allowlist });
}

async function setTabPaused(tabId, paused) {
  await tabState.update((t) => {
    t.paused = t.paused.filter((id) => id !== tabId);
    if (paused) t.paused.push(tabId);
  });
  await applySessionRules();
}

async function setYouTubeAllowed(tabId, allowed) {
  const tabs = await tabState.update((t) => {
    t.ytAllowed = t.ytAllowed.filter((id) => id !== tabId);
    if (allowed) t.ytAllowed.push(tabId);
  });
  await applySessionRules();
  return tabs;
}

async function onYouTubeChannel(tabId, channel) {
  const settings = await getSettings();
  const tabs = await tabState.get();
  const shouldAllow = Boolean(channel) && settings.ytChannels.includes(channel);
  const isAllowed = tabs.ytAllowed.includes(tabId);
  await tabState.update((t) => {
    if (channel) t.channels[tabId] = channel;
    else delete t.channels[tabId];
  });
  if (shouldAllow === isAllowed) return { reload: false };
  await setYouTubeAllowed(tabId, shouldAllow);
  return { reload: true };
}

async function setChannelAllowed(tabId, channel, allowed) {
  const settings = await getSettings();
  const ytChannels = settings.ytChannels.filter((c) => c !== channel);
  if (allowed) ytChannels.push(channel);
  await updateSettings({ ytChannels });
  await setYouTubeAllowed(tabId, allowed);
  chrome.tabs.reload(tabId);
}

async function addCustomFilter(filter, tabId) {
  const settings = await getSettings();
  const customFilters = settings.customFilters.trimEnd();
  if (customFilters.split("\n").includes(filter)) return;
  await updateSettings({ customFilters: `${customFilters}${customFilters ? "\n" : ""}${filter}\n` });
  const selector = filter.split("##")[1];
  if (selector && tabId !== undefined) await hideNow(tabId, selector);
}

// ------------------------------------------------------------- image swap

const SWAP_CHANNELS = {
  cats: ({ w, h }) => `https://cataas.com/cat?width=${w}&height=${h}`,
  dogs: async () => {
    const res = await fetch("https://dog.ceo/api/breeds/image/random");
    const data = await res.json();
    if (data.status !== "success") throw new Error("dog.ceo unavailable");
    return data.message;
  },
  landscapes: ({ w, h }) => `https://picsum.photos/seed/${Math.random().toString(36).slice(2)}/${w}/${h}`,
  grayscale: ({ w, h }) => `https://picsum.photos/seed/${Math.random().toString(36).slice(2)}/${w}/${h}?grayscale`,
  custom: async () => {
    const { swapImages = [] } = await chrome.storage.local.get("swapImages");
    if (!swapImages.length) return null;
    return swapImages[Math.floor(Math.random() * swapImages.length)];
  },
};

async function getSwapImage(size) {
  const { imageSwap } = await getSettings();
  const make = SWAP_CHANNELS[imageSwap.channel] || SWAP_CHANNELS.cats;
  const w = Math.min(2000, Math.max(1, Math.round(size.w)));
  const h = Math.min(2000, Math.max(1, Math.round(size.h)));
  try {
    return await make({ w, h });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- popup

async function getPopupState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = await getSettings();
  const tabs = await tabState.get();
  const { errors = {} } = await chrome.storage.session.get("errors");
  const stats = await getStats();
  let host = "";
  let web = false;
  try {
    const url = new URL(tab.url);
    web = /^https?:$/.test(url.protocol);
    host = normalizeHost(url.hostname);
  } catch {}
  return {
    tabId: tab?.id,
    host,
    web,
    paused: settings.paused,
    allowlisted: web && hostMatches(host, settings.allowlist),
    tabPaused: tabs.paused.includes(tab?.id),
    blockedOnPage: await getTabCount(tab?.id),
    blockedTotal: stats.total,
    channel: tabs.channels[tab?.id] || null,
    channelAllowed: tabs.ytAllowed.includes(tab?.id),
    imageSwap: settings.imageSwap,
    theme: settings.themes.popup,
    errors: Object.values(errors),
  };
}

async function getOptionsState() {
  const settings = await getSettings();
  const catalog = await getCatalog();
  const meta = await fetch(chrome.runtime.getURL("rulesets/meta.json")).then((r) => r.json()).catch(() => null);
  const { errors = {} } = await chrome.storage.session.get("errors");
  const { swapImages = [] } = await chrome.storage.local.get("swapImages");
  return {
    settings,
    catalog,
    meta,
    errors: Object.values(errors),
    customReport: customFilterReport(),
    swapImages,
    version: chrome.runtime.getManifest().version,
  };
}

// ------------------------------------------------------------- messaging

const handlers = {
  async frameReady(msg, sender) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return { active: false };
    const frameId = sender.frameId ?? 0;
    const topUrl = frameId === 0 ? sender.url : sender.tab.url;
    if (!(await isActiveFor(tabId, topUrl))) return { active: false };
    let hostname = "";
    try {
      hostname = new URL(sender.url).hostname || new URL(sender.tab.url).hostname;
    } catch {}
    const { swapSelectors } = await injectCosmetics({ tabId, frameId, hostname });
    const { imageSwap } = await getSettings();
    return { active: true, swap: imageSwap.enabled && frameId === 0 ? swapSelectors : [] };
  },
  getSwapImage: (msg) => getSwapImage(msg),
  adsHidden: (msg, sender) => sender.tab && countHidden(sender.tab.id, Math.max(0, Number(msg.count) || 0)),
  ytChannel: (msg, sender) => (sender.tab ? onYouTubeChannel(sender.tab.id, msg.channel) : { reload: false }),
  addCustomFilter: (msg, sender) => addCustomFilter(String(msg.filter), sender.tab?.id),

  getPopupState,
  getOptionsState,
  getStats,
  resetStats,
  updateSettings: ({ patch }) => updateSettings(patch),
  toggleAllowlist: ({ url, allow }) => toggleAllowlist(url, allow),
  setTabPaused: ({ tabId, paused }) => setTabPaused(tabId, paused),
  setChannelAllowed: ({ tabId, channel, allowed }) => setChannelAllowed(tabId, channel, allowed),
  startPicker: ({ tabId }) => startPicker(tabId),
  addCustomList: ({ url }) => addCustomList(url),
  removeCustomList: async ({ url }) => {
    const settings = await getSettings();
    await updateSettings({ customLists: settings.customLists.filter((l) => l.url !== url) });
  },
  refreshCustomLists: () => refreshCustomLists({ force: true }),
  exportBackup,
  importBackup: async ({ backup }) => {
    await importBackup(backup);
    invalidateSettings();
    await afterSettingsChange(Object.keys(await getSettings()));
  },
  setSwapImages: async ({ images }) => {
    await chrome.storage.local.set({ swapImages: images.filter((s) => typeof s === "string" && s.startsWith("data:image/")) });
  },
  syncNow: async () => {
    await pullSync();
    await pushSync();
  },
};

// Messages only content scripts may send; everything else must come from our pages.
const CONTENT_MESSAGES = new Set(["frameReady", "getSwapImage", "adsHidden", "ytChannel", "addCustomFilter"]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(""));
  if (!handler || (!fromExtensionPage && !CONTENT_MESSAGES.has(msg.type))) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: String(error?.message || error) }),
    );
  return true;
});
