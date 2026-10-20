// Runs in every frame at document_start. Asks the background to inject the
// element hiding CSS for this frame and, with Image Swap on, replaces hidden
// ads in the top frame with pictures.

(() => {
  if (globalThis.__adbyeCosmetic) return;
  globalThis.__adbyeCosmetic = true;

  const MIN_W = 60;
  const MIN_H = 40;

  // Remember what was right-clicked so "Block this element" can preselect it.
  document.addEventListener(
    "contextmenu",
    (event) => {
      globalThis.__adbyeContextTarget = event.target;
    },
    true,
  );

  const send = (message) =>
    chrome.runtime.sendMessage(message).then((res) => (res?.ok ? res.result : null)).catch(() => null);

  send({ type: "frameReady" }).then((state) => {
    if (state?.active && state.swap?.length) startImageSwap(state.swap);
  });

  function startImageSwap(selectors) {
    // Validated selectors may still fail in this browser; test them one by one.
    const usable = selectors.filter((sel) => {
      try {
        document.querySelector(sel);
        return true;
      } catch {
        return false;
      }
    });
    if (!usable.length) return;
    const combined = usable.join(",");
    let pending = false;

    const scan = () => {
      pending = false;
      let hidden = 0;
      for (const el of document.querySelectorAll(combined)) {
        if (el.hasAttribute("data-adbye-swapped") || el.hasAttribute("data-adbye-collapse")) continue;
        // Skip ads nested in an ad we already handled.
        if (el.parentElement?.closest("[data-adbye-swapped],[data-adbye-collapse]")) continue;
        const rect = el.getBoundingClientRect();
        if (!rect.width && !rect.height) continue; // not laid out yet; next mutation
        hidden++;
        if (rect.width >= MIN_W && rect.height >= MIN_H) swap(el, rect);
        else el.setAttribute("data-adbye-collapse", "");
      }
      if (hidden) send({ type: "adsHidden", count: hidden });
    };

    const schedule = () => {
      if (pending) return;
      pending = true;
      setTimeout(scan, 250);
    };

    async function swap(el, rect) {
      el.setAttribute("data-adbye-collapse", "");
      const src = await send({ type: "getSwapImage", w: rect.width, h: rect.height });
      if (!src) return;
      const holder = document.createElement("adbye-picture");
      const shadow = holder.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = `
        :host { all: initial; display: inline-block; position: relative; overflow: hidden;
                width: ${Math.round(rect.width)}px; height: ${Math.round(rect.height)}px;
                max-width: 100%; vertical-align: top; }
        img { width: 100%; height: 100%; object-fit: cover; display: block; }
        span { position: absolute; right: 4px; bottom: 4px; font: 10px/1.4 system-ui, sans-serif;
               background: rgba(0,0,0,.55); color: #fff; padding: 0 5px; border-radius: 3px; }`;
      const img = document.createElement("img");
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.src = src;
      img.onerror = () => holder.remove();
      const label = document.createElement("span");
      label.textContent = "AdBye";
      shadow.append(style, img, label);
      el.removeAttribute("data-adbye-collapse");
      el.setAttribute("data-adbye-swapped", "");
      el.after(holder);
    }

    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan, { once: true });
    else scan();
    addEventListener("load", schedule, { once: true });
  }
})();
