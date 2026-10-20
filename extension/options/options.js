import { THEMES, applyTheme, formatNumber, localize, send, t } from "../shared/ui.js";

const $ = (id) => document.getElementById(id);
const GROUPS = ["ads", "language", "privacy", "cookies", "distractions", "security"];
const SWAP_CHANNELS = ["cats", "dogs", "landscapes", "grayscale", "custom"];
const MAX_CUSTOM_IMAGES = 20;

let state;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function row(label, ...actions) {
  return el("li", {}, el("span", { className: "grow" }, label), ...actions);
}

function emptyRow(text) {
  return el("li", { className: "empty" }, text);
}

async function update(patch) {
  await send("updateSettings", { patch });
  await refresh();
}

// ------------------------------------------------------------------ render

function renderErrors() {
  const messages = [...state.errors];
  if (state.customReport.dropped) messages.push(t("customDropped", [String(state.customReport.dropped)]));
  $("errors").hidden = !messages.length;
  $("errors").textContent = messages.join("\n");
}

function renderGeneral() {
  for (const input of document.querySelectorAll("[data-setting]")) {
    input.checked = Boolean(state.settings[input.dataset.setting]);
  }
}

function renderLists() {
  const { settings, catalog, meta } = state;
  const enabled = new Set(settings.enabledLists || []);
  if (meta) $("lists-built").textContent = t("listsBuilt", [new Date(meta.builtAt).toLocaleDateString()]);

  const groups = $("list-groups");
  groups.replaceChildren();
  for (const group of GROUPS) {
    const lists = catalog.filter((l) => l.category === group);
    if (!lists.length) continue;
    const ul = el("ul", { className: "rows" });
    for (const list of lists) {
      const input = el("input", { type: "checkbox", checked: enabled.has(list.id) });
      input.addEventListener("change", () => {
        const next = new Set(settings.enabledLists || []);
        if (input.checked) next.add(list.id);
        else next.delete(list.id);
        update({ enabledLists: [...next] });
      });
      const rules = meta?.lists?.[list.id];
      const info = el(
        "span",
        { className: "grow" },
        el("strong", {}, list.title),
        " ",
        list.premium ? el("span", { className: "tag", textContent: t("freeInAdBye") }) : null,
        el("br"),
        el("small", {
          className: "muted",
          textContent: [rules ? t("listRules", [formatNumber(rules.network), formatNumber(rules.cosmetic)]) : "", list.license]
            .filter(Boolean)
            .join(" · "),
        }),
      );
      ul.append(el("li", {}, el("label", { className: "switch grow" }, info, input)));
    }
    groups.append(el("div", { className: "list-group" }, el("h2", { textContent: t(`group_${group}`) }), ul));
  }

  const custom = $("custom-lists");
  custom.replaceChildren();
  if (!settings.customLists.length) custom.append(emptyRow(t("none")));
  for (const list of settings.customLists) {
    const remove = el("button", { textContent: t("remove") });
    remove.addEventListener("click", async () => {
      await send("removeCustomList", { url: list.url });
      refresh();
    });
    const detail = list.error
      ? t("listError", [list.error])
      : t("listUpdated", [new Date(list.updatedAt).toLocaleString()]);
    custom.append(
      row(el("span", {}, el("strong", { textContent: list.title }), el("br"), el("small", { className: "muted", textContent: `${list.url} · ${detail}` })), remove),
    );
  }
}

function renderCustomize() {
  const { settings } = state;
  const allow = $("allowlist");
  allow.replaceChildren();
  if (!settings.allowlist.length) allow.append(emptyRow(t("none")));
  for (const host of settings.allowlist) {
    const remove = el("button", { textContent: t("remove") });
    remove.addEventListener("click", () => update({ allowlist: settings.allowlist.filter((h) => h !== host) }));
    allow.append(row(host, remove));
  }

  const channels = $("yt-channels");
  channels.replaceChildren();
  if (!settings.ytChannels.length) channels.append(emptyRow(t("ytChannelsEmpty")));
  for (const channel of settings.ytChannels) {
    const remove = el("button", { textContent: t("remove") });
    remove.addEventListener("click", () => update({ ytChannels: settings.ytChannels.filter((c) => c !== channel) }));
    const link = el("a", { href: `https://www.youtube.com/${channel}`, target: "_blank", textContent: channel });
    channels.append(row(link, remove));
  }

  if (document.activeElement !== $("custom-filters")) $("custom-filters").value = settings.customFilters;
  const invalid = state.customReport.invalid;
  $("filters-report").textContent = invalid.length ? t("filtersInvalid", [String(invalid.length), invalid.slice(0, 3).join("  ")]) : "";
}

function renderImageSwap() {
  const { imageSwap } = state.settings;
  $("swap-enabled").checked = imageSwap.enabled;
  const box = $("swap-channels");
  box.replaceChildren();
  for (const channel of SWAP_CHANNELS) {
    const button = el(
      "button",
      { className: "choice", type: "button" },
      el("strong", { textContent: t(`swap_${channel}`) }),
      el("small", { className: "muted", textContent: t(`swap_${channel}_src`) }),
    );
    button.setAttribute("aria-pressed", String(imageSwap.channel === channel));
    button.addEventListener("click", () => update({ imageSwap: { ...imageSwap, channel } }));
    box.append(button);
  }
  $("custom-images").hidden = imageSwap.channel !== "custom";

  const grid = $("image-grid");
  grid.replaceChildren();
  state.swapImages.forEach((src, i) => {
    const remove = el("button", { textContent: "×", title: t("remove") });
    remove.addEventListener("click", async () => {
      await send("setSwapImages", { images: state.swapImages.filter((_, j) => j !== i) });
      refresh();
    });
    grid.append(el("figure", {}, el("img", { src, alt: "" }), remove));
  });
}

function themeSwatches(theme) {
  const probe = el("div");
  probe.dataset.theme = theme;
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const colors = ["--bg", "--surface", "--text", "--accent"].map((v) => style.getPropertyValue(v).trim());
  probe.remove();
  return el("span", { className: "swatches" }, ...colors.map((c) => {
    const s = el("span");
    s.style.background = c;
    return s;
  }));
}

function renderThemes() {
  for (const box of document.querySelectorAll("[data-theme-target]")) {
    const target = box.dataset.themeTarget;
    box.replaceChildren();
    for (const theme of THEMES) {
      const button = el("button", { className: "choice", type: "button" }, themeSwatches(theme), el("span", { textContent: t(`theme_${theme}`) }));
      button.setAttribute("aria-pressed", String(state.settings.themes[target] === theme));
      button.addEventListener("click", () => update({ themes: { ...state.settings.themes, [target]: theme } }));
      box.append(button);
    }
  }
  applyTheme(state.settings.themes.options);
}

async function renderStats() {
  const stats = await send("getStats");
  const today = new Date().toISOString().slice(0, 10);
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push([d, stats.days[d] || 0]);
  }
  $("stat-total").textContent = formatNumber(stats.total);
  $("stat-today").textContent = formatNumber(stats.days[today]);
  $("stat-month").textContent = formatNumber(days.reduce((sum, [, n]) => sum + n, 0));

  const max = Math.max(1, ...days.map(([, n]) => n));
  const chart = $("chart");
  chart.replaceChildren(
    ...days.map(([d, n]) => {
      const bar = el("div", { title: `${d}: ${formatNumber(n)}` });
      bar.style.height = `${(n / max) * 100}%`;
      return bar;
    }),
  );
  chart.setAttribute("aria-label", t("last30"));

  const top = Object.entries(stats.domains).sort((a, b) => b[1] - a[1]).slice(0, 15);
  $("top-domains").replaceChildren(
    ...(top.length ? top.map(([host, n]) => el("li", {}, el("span", { className: "grow", textContent: host }), formatNumber(n))) : [emptyRow(t("none"))]),
  );
}

function renderAbout() {
  $("version").textContent = state.version;
  const credits = $("credits");
  credits.replaceChildren(
    ...state.catalog.map((l) =>
      row(el("span", {}, el("a", { href: l.homepage, target: "_blank", textContent: l.title }), ` — ${l.license}`)),
    ),
    row("@eyeo/abp2dnr — GPL-3.0"),
    row("cataas.com, Dog CEO API, Lorem Picsum — Image Swap"),
  );
}

async function refresh() {
  state = await send("getOptionsState");
  renderErrors();
  renderGeneral();
  renderLists();
  renderCustomize();
  renderImageSwap();
  renderThemes();
  renderAbout();
  if (location.hash === "#stats") renderStats();
}

// ------------------------------------------------------------------ events

function showSection() {
  const id = (location.hash || "#general").slice(1);
  for (const section of document.querySelectorAll("main > section")) section.hidden = section.id !== id;
  for (const link of document.querySelectorAll("nav a")) link.classList.toggle("current", link.hash === `#${id}`);
  if (id === "stats") renderStats();
}

async function resizeImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

function wire() {
  addEventListener("hashchange", showSection);

  for (const input of document.querySelectorAll("[data-setting]")) {
    input.addEventListener("change", () => update({ [input.dataset.setting]: input.checked }));
  }

  $("add-list").addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = e.submitter;
    button.disabled = true;
    try {
      await send("addCustomList", { url: $("list-url").value.trim() });
      $("list-url").value = "";
    } catch (error) {
      alert(error.message);
    }
    button.disabled = false;
    refresh();
  });
  $("refresh-lists").addEventListener("click", async () => {
    await send("refreshCustomLists");
    refresh();
  });

  $("add-allow").addEventListener("submit", async (e) => {
    e.preventDefault();
    await send("toggleAllowlist", { url: $("allow-host").value, allow: true });
    $("allow-host").value = "";
    refresh();
  });

  $("save-filters").addEventListener("click", async () => {
    await update({ customFilters: $("custom-filters").value });
    $("filters-report").textContent = state.customReport.invalid.length ? $("filters-report").textContent : t("saved");
  });

  $("swap-enabled").addEventListener("change", (e) => update({ imageSwap: { ...state.settings.imageSwap, enabled: e.target.checked } }));
  $("image-files").addEventListener("change", async (e) => {
    const added = await Promise.all([...e.target.files].map(resizeImage));
    await send("setSwapImages", { images: [...state.swapImages, ...added].slice(-MAX_CUSTOM_IMAGES) });
    e.target.value = "";
    refresh();
  });

  $("export").addEventListener("click", async () => {
    const backup = await send("exportBackup");
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
    el("a", { href: url, download: `adbye-backup-${new Date().toISOString().slice(0, 10)}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("import").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await send("importBackup", { backup: JSON.parse(await file.text()) });
      $("backup-status").textContent = t("importDone");
    } catch (error) {
      $("backup-status").textContent = t("importFailed", [error.message]);
    }
    e.target.value = "";
    refresh();
  });

  $("reset-stats").addEventListener("click", async () => {
    if (!confirm(t("resetStatsConfirm"))) return;
    await send("resetStats");
    renderStats();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings && document.activeElement?.tagName !== "TEXTAREA") refresh();
  });
}

localize();
wire();
showSection();
refresh();
