import { applyTheme, formatNumber, localize, send, t } from "../shared/ui.js";

const $ = (id) => document.getElementById(id);
const ALL_SITES = { origins: ["<all_urls>"] };

async function render() {
  const state = await send("getPopupState");
  applyTheme(state.theme);

  const active = state.web && !state.paused && !state.allowlisted && !state.tabPaused && !state.channelAllowed;
  $("status").className = `status ${active ? "active" : "inactive"}`;
  $("status-text").textContent = !state.web
    ? t("statusNotWeb")
    : state.paused
      ? t("statusPausedAll")
      : state.allowlisted
        ? t("statusAllowlisted")
        : state.tabPaused
          ? t("statusTabPaused")
          : state.channelAllowed
            ? t("statusChannelAllowed")
            : t("statusActive");
  $("host").textContent = state.web ? state.host : "";

  $("count-page").textContent = formatNumber(state.blockedOnPage);
  $("count-total").textContent = formatNumber(state.blockedTotal);

  $("errors").hidden = !state.errors.length;
  $("errors").textContent = state.errors.join("\n");
  // Firefox lets users withdraw site access after install; without it nothing is blocked.
  $("host-access").hidden = await chrome.permissions.contains(ALL_SITES);

  for (const el of document.querySelectorAll(".site-only")) el.hidden = !state.web;
  $("pick").disabled = !active;
  $("allow-site").checked = state.allowlisted;
  $("pause-tab").checked = state.tabPaused;
  $("pause-all").checked = state.paused;
  $("image-swap").checked = state.imageSwap.enabled;

  $("channel-row").hidden = !state.channel;
  if (state.channel) {
    $("channel-label").textContent = t("allowChannel", [state.channel]);
    $("allow-channel").checked = state.channelAllowed;
  }
  return state;
}

function wire(state) {
  const reloadTab = () => chrome.tabs.reload(state.tabId);

  $("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("grant-access").addEventListener("click", async () => {
    if (await chrome.permissions.request(ALL_SITES)) {
      reloadTab();
      render();
    }
  });
  $("pick").addEventListener("click", async () => {
    await send("startPicker", { tabId: state.tabId });
    window.close();
  });
  $("allow-site").addEventListener("change", async (e) => {
    const tab = await chrome.tabs.get(state.tabId);
    await send("toggleAllowlist", { url: tab.url, allow: e.target.checked });
    reloadTab();
    render();
  });
  $("pause-tab").addEventListener("change", async (e) => {
    await send("setTabPaused", { tabId: state.tabId, paused: e.target.checked });
    reloadTab();
    render();
  });
  $("pause-all").addEventListener("change", async (e) => {
    await send("updateSettings", { patch: { paused: e.target.checked } });
    reloadTab();
    render();
  });
  $("image-swap").addEventListener("change", async (e) => {
    await send("updateSettings", { patch: { imageSwap: { ...state.imageSwap, enabled: e.target.checked } } });
    reloadTab();
    render();
  });
  $("allow-channel").addEventListener("change", async (e) => {
    const current = await send("getPopupState");
    await send("setChannelAllowed", { tabId: state.tabId, channel: current.channel, allowed: e.target.checked });
    render();
  });
}

localize();
render().then(wire);
