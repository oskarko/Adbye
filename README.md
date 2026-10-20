# AdBye

A **free and open source (GPL-3.0)** ad blocker for Chrome, Edge and Brave (Manifest V3). Every feature AdBlock reserves for its Premium plan is included for free. There are no accounts, sign-ups, licenses or AdBye servers: install it and it works.

AdBye is an independent reimplementation. It contains no AdBlock code, proprietary filter lists, images or trademarks, and is not affiliated with AdBlock, eyeo or Adblock Plus.

## Features

| Feature | AdBlock | AdBye |
|---|---|---|
| Ad blocking (EasyList + regional lists) | Free | Free |
| Privacy protection (EasyPrivacy) | Free | Free |
| Cryptomining blocking | Free | Free (NoCoin) |
| Allowlist; pause per site, per tab or everywhere | Free | Free |
| Block an element with the mouse (element picker) | Free | Free |
| Allow ads on specific YouTube channels | Free | Free |
| Custom filters and custom filter lists | Free | Free |
| **Distraction Control** (pop-ups, newsletters, surveys, floating videos) | Premium | Free (Fanboy Annoyances) |
| **Cookie notice blocking** | Premium | Free (Fanboy Cookie Monster) |
| **Deny push notification requests** | Premium | Free |
| **Image Swap**: replace ads with pictures (cats, dogs, landscapes, your own) | Premium | Free |
| **Color themes** for the popup and options page | Premium | Free |
| **Sync and backups** | Premium | Free (browser sync + JSON files) |
| Blocking statistics | Free | Free, with a 30-day chart |
| "Acceptable Ads" on by default | Yes | Don't exist |

## Development setup

```bash
npm install
npm run build:lists   # downloads the lists and generates extension/rulesets and extension/cosmetic
npm test
```

Then open `chrome://extensions` (or `edge://extensions`, `brave://extensions`), turn on Developer mode, click "Load unpacked" and select the `extension/` folder.

Other scripts:

- `npm run build:lists:offline` recompiles from the lists already downloaded to `.cache/`.
- `npm run build:icons` regenerates the icons (no dependencies).
- `npm run package` creates `dist/adbye-<version>.zip`.

A GitHub workflow (`.github/workflows/lists.yml`) rebuilds the lists every Monday and opens a pull request.

## How it works

```
extension/
  background.js         service worker: messaging, context menu, first run
  lib/filters.js        ABP filter parser (shared by the build and the extension)
  lib/engine.js         applies DNR rules (static, dynamic, session) and element hiding CSS
  lib/settings.js       persistent settings
  lib/stats.js          counters (webRequest net::ERR_BLOCKED_BY_CLIENT)
  lib/sync.js           chrome.storage.sync and JSON backups
  content/cosmetic.js   requests element hiding CSS per frame; Image Swap
  content/picker.js     element picker
  content/youtube.js    detects the YouTube channel
  content/no-notifications.js   denies Notification/PushManager (MAIN world)
  popup/, options/, shared/     UI, themes and i18n (es, en)
scripts/build-rulesets.mjs      lists → DNR with @eyeo/abp2dnr (GPL-3.0) + cosmetic index
```

- **Network blocking:** filter lists are converted at build time into static `declarativeNetRequest` rulesets (about 136,000 rules in total). Turning a list on or off just enables or disables its ruleset.
- **Element hiding:** each frame asks the service worker for the CSS for its domain, which is injected with `scripting.insertCSS` (`USER` origin, so it beats inline styles).
- **Custom filters and allowlist:** dynamic rules. Per-tab pausing and allowed YouTube channels are tab-scoped `allowAllRequests` session rules.

## Known limitations

- Bundled lists update with each AdBye release, not daily. Custom lists added by URL update every 24 hours as dynamic rules.
- Adblock Plus procedural filters (`#?#`) and snippets (`#$#`) are not supported and are dropped at build time. This mostly affects script-injected YouTube ads.
- Image Swap loads pictures from external services; sites with a strict CSP block them, and the ad is simply hidden there.
- YouTube channel detection depends on YouTube's DOM and may break when it changes.

## Background research

AdBye started from an analysis of the AdBlock 6.x extension (ID `gighmmpiobklfepjocnamgkkbiglidom`) with [REA](https://github.com/morluto/rea) and the source maps the extension itself ships. The relevant findings:

- AdBlock is GPL-3.0 and built on `@eyeo/webext-ad-filtering-solution`.
- Premium features are unlocked by `License.isActiveLicense()`, which checks an account against AdBlock's servers. When the license expires, `processExpiredLicense` turns off Image Swap, resets themes and removes the Distraction Control and cookie lists.
- The Premium lists (`adblock_premium.txt`, `distraction-control-*.txt`, `cookie-filter-list.txt`) are proprietary, so AdBye uses open equivalents from Fanboy/EasyList.

## Licenses and credits

- AdBye code: [GPL-3.0](LICENSE).
- [EasyList, EasyPrivacy and Fanboy](https://easylist.to/): GPL-3.0 / CC BY-SA 3.0.
- [Liste FR](https://forums.lanik.us/): GPL-3.0.
- [ABP Anti-Circumvention](https://github.com/abp-filters/abp-filters-anti-cv): GPL-3.0 / CC BY-SA 3.0.
- [NoCoin](https://github.com/hoshsadiq/adblock-nocoin-list): MIT.
- [@eyeo/abp2dnr](https://www.npmjs.com/package/@eyeo/abp2dnr): GPL-3.0, build time only.
- Image Swap pictures: [cataas.com](https://cataas.com), [Dog CEO API](https://dog.ceo/dog-api/), [Lorem Picsum](https://picsum.photos).
