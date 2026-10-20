// "Block an element": highlights elements under the pointer, lets the user
// widen the selection with a slider and saves a `host##selector` filter.

(() => {
  if (globalThis.__adbyePicker) return;
  globalThis.__adbyePicker = true;

  const t = (key, fallback) => chrome.i18n.getMessage(key) || fallback;
  const host = location.hostname.replace(/^www\./, "");

  const root = document.createElement("adbye-picker");
  const shadow = root.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .box { position: fixed; pointer-events: none; z-index: 2147483646; background: rgba(217,48,37,.25);
             outline: 2px solid #d93025; transition: all .05s; }
      .panel { position: fixed; z-index: 2147483647; right: 16px; bottom: 16px; width: 340px; max-width: calc(100vw - 32px);
               font: 13px/1.4 system-ui, sans-serif; color: #202124; background: #fff; border-radius: 10px;
               box-shadow: 0 6px 24px rgba(0,0,0,.3); padding: 14px; box-sizing: border-box; }
      .panel h1 { font-size: 14px; margin: 0 0 6px; }
      .panel p { margin: 0 0 8px; color: #5f6368; }
      code { display: block; background: #f1f3f4; padding: 6px; border-radius: 6px; word-break: break-all;
             max-height: 80px; overflow: auto; font-size: 12px; }
      input[type=range] { width: 100%; margin: 8px 0; }
      .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
      button { font: inherit; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
      .ok { background: #d93025; color: #fff; } .ok:disabled { opacity: .5; cursor: default; }
      .cancel { background: #e8eaed; color: #202124; }
    </style>
    <div class="box" hidden></div>
    <div class="panel">
      <h1></h1>
      <p class="hint"></p>
      <div class="chosen" hidden>
        <code></code>
        <label><input type="range" min="0" value="0"></label>
        <p class="count"></p>
      </div>
      <div class="row">
        <button class="cancel"></button>
        <button class="ok" disabled></button>
      </div>
    </div>`;
  // Text goes in as text nodes, never as markup.
  const texts = {
    h1: t("pickerTitle", "Block an element"),
    ".hint": t("pickerHint", "Click the element you want to hide. Press Esc to cancel."),
    label: t("pickerScope", "Selection size"),
    ".cancel": t("cancel", "Cancel"),
    ".ok": t("pickerBlock", "Block it"),
  };
  for (const [selector, text] of Object.entries(texts)) shadow.querySelector(selector).prepend(text);

  const box = shadow.querySelector(".box");
  const panel = shadow.querySelector(".panel");
  const code = shadow.querySelector("code");
  const slider = shadow.querySelector("input");
  const count = shadow.querySelector(".count");
  const ok = shadow.querySelector(".ok");
  let chosen = null;
  let candidates = [];

  function cssEscape(s) {
    return CSS.escape(s);
  }

  // Candidates from most specific (the element itself) to broader ancestors.
  function selectorFor(el) {
    if (el.id && !/\d{3,}/.test(el.id)) return `#${cssEscape(el.id)}`;
    let sel = el.localName;
    const classes = [...el.classList].filter((c) => !/\d{3,}|^(active|hover|show|open|visible)$/.test(c)).slice(0, 3);
    if (classes.length) sel += classes.map((c) => `.${cssEscape(c)}`).join("");
    for (const attr of ["data-ad", "data-ad-slot", "aria-label", "src", "href"]) {
      const v = el.getAttribute(attr);
      if (v && !classes.length && v.length < 120) {
        sel += `[${attr}="${v.replace(/"/g, '\\"')}"]`;
        break;
      }
    }
    return sel;
  }

  function buildCandidates(el) {
    const list = [];
    for (let node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      list.push({ el: node, selector: selectorFor(node) });
    }
    return list.length ? list : [{ el, selector: selectorFor(el) }];
  }

  function highlight(el) {
    if (!el) {
      box.hidden = true;
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    box.hidden = false;
  }

  function select(el) {
    candidates = buildCandidates(el);
    slider.max = String(candidates.length - 1);
    slider.value = "0";
    shadow.querySelector(".chosen").hidden = false;
    ok.disabled = false;
    update();
  }

  function update() {
    chosen = candidates[Number(slider.value)];
    code.textContent = `${host}##${chosen.selector}`;
    let n = 0;
    try {
      n = document.querySelectorAll(chosen.selector).length;
    } catch {}
    count.textContent = chrome.i18n.getMessage("pickerMatches", [String(n)]) || `${n} elements match`;
    highlight(chosen.el);
  }

  const onMove = (e) => {
    if (candidates.length || e.composedPath().includes(root)) return;
    highlight(e.target);
  };
  const onClick = (e) => {
    if (e.composedPath().includes(root)) return;
    e.preventDefault();
    e.stopPropagation();
    select(e.target);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };

  function close() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    root.remove();
    globalThis.__adbyePicker = false;
  }

  slider.addEventListener("input", update);
  shadow.querySelector(".cancel").addEventListener("click", close);
  ok.addEventListener("click", async () => {
    if (!chosen) return;
    await chrome.runtime.sendMessage({ type: "addCustomFilter", filter: `${host}##${chosen.selector}` }).catch(() => {});
    close();
  });
  panel.addEventListener("click", (e) => e.stopPropagation());

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  document.documentElement.append(root);

  const target = globalThis.__adbyePickFromMenu && globalThis.__adbyeContextTarget;
  if (target instanceof Element) select(target);
})();
