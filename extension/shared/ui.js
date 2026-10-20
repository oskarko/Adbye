// Helpers shared by the popup and options pages.

export function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

/** Fills elements marked with data-i18n, data-i18n-title and data-i18n-placeholder. */
export function localize(root = document) {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
}

export async function send(type, data = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...data });
  if (!res?.ok) throw new Error(res?.error || "No response from AdBye");
  return res.result;
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme || "default";
}

export const THEMES = ["default", "dark", "solarized", "solarized_light", "watermelon", "sunshine", "ocean"];

export function formatNumber(n) {
  return new Intl.NumberFormat(chrome.i18n.getUILanguage()).format(n || 0);
}
