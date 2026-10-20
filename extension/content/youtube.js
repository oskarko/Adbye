// Detects the channel of the YouTube page so the user can allow ads on the
// channels they want to support.

(() => {
  let lastChannel;

  function findChannel() {
    const fromUrl = /^\/(@[^/?#]+)/.exec(location.pathname);
    if (fromUrl) return decodeURIComponent(fromUrl[1]).toLowerCase();
    if (!location.pathname.startsWith("/watch") && !location.pathname.startsWith("/shorts")) return null;
    const link = document.querySelector(
      "ytd-watch-metadata #owner a[href^='/@'], ytd-video-owner-renderer a[href^='/@'], " +
        "ytd-reel-player-overlay-renderer a[href^='/@'], ytm-slim-owner-renderer a[href^='/@']",
    );
    const handle = link && /^\/(@[^/?#]+)/.exec(link.getAttribute("href"));
    return handle ? decodeURIComponent(handle[1]).toLowerCase() : null;
  }

  async function report(channel) {
    if (channel === lastChannel) return;
    lastChannel = channel;
    const res = await chrome.runtime.sendMessage({ type: "ytChannel", channel }).catch(() => null);
    if (res?.ok && res.result?.reload) location.reload();
  }

  // The owner link renders after navigation, so retry for a few seconds and
  // only report "no channel" once it is clearly absent.
  let timer;
  function check() {
    clearInterval(timer);
    let tries = 0;
    timer = setInterval(() => {
      const channel = findChannel();
      if (channel || ++tries >= 10) {
        clearInterval(timer);
        report(channel);
      }
    }, 500);
  }

  document.addEventListener("yt-navigate-finish", check);
  check();
})();
