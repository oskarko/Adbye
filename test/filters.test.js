import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CosmeticIndex,
  PRIORITY,
  convertNetworkFilter,
  parseCosmeticFilter,
  parseFilterText,
  parseHideException,
  selectorsToCss,
} from "../extension/lib/filters.js";

test("parses generic and domain-specific hiding filters", () => {
  assert.deepEqual(parseCosmeticFilter("##.ad-banner"), {
    exception: false,
    domains: { include: [], exclude: [] },
    selector: ".ad-banner",
  });
  assert.deepEqual(parseCosmeticFilter("example.com,~shop.example.com##div[id^='ad-']").domains, {
    include: ["example.com"],
    exclude: ["shop.example.com"],
  });
  assert.equal(parseCosmeticFilter("example.com#@#.ad").exception, true);
});

test("rejects procedural and snippet filters", () => {
  assert.equal(parseCosmeticFilter("example.com#?#div:-abp-has(.ad)"), null);
  assert.equal(parseCosmeticFilter("example.com#$#abort-on-property-read foo"), null);
  assert.equal(parseCosmeticFilter("example.com##div:has-text(Sponsored)"), null);
  assert.equal(parseCosmeticFilter("||ads.example.com^"), null);
});

test("cosmetic index applies specific filters, exceptions and generichide", () => {
  const index = new CosmeticIndex();
  for (const line of [
    "##.ad",
    "##.sponsor",
    "example.com##.promo",
    "~news.example.com##.banner",
    "example.com#@#.sponsor",
  ]) {
    index.addFilter(parseCosmeticFilter(line));
  }
  index.addHideException(parseHideException("@@||quiet.org^$generichide"));
  index.addHideException(parseHideException("@@||trusted.org^$elemhide"));

  const page = index.lookup("www.example.com");
  assert.deepEqual(page.specific, [".promo"]);
  assert.equal(page.generic, true);
  assert.deepEqual(index.genericSelectors(page.exceptions), [".ad", ".banner"]);

  assert.ok(index.lookup("news.example.com").exceptions.includes(".banner"));
  assert.equal(index.lookup("quiet.org").generic, false);
  assert.deepEqual(index.lookup("sub.trusted.org"), { specific: [], generic: false, exceptions: [] });
});

test("cosmetic index survives a JSON round trip and merges", () => {
  const a = new CosmeticIndex();
  a.addFilter(parseCosmeticFilter("a.com##.x"));
  const b = new CosmeticIndex(JSON.parse(JSON.stringify(a)));
  b.merge(new CosmeticIndex({ generic: [".y"], specific: { "a.com": [".z"] } }));
  assert.deepEqual(b.lookup("a.com").specific.sort(), [".x", ".z"]);
  assert.deepEqual(b.genericSelectors(), [".y"]);
});

test("builds grouped CSS", () => {
  assert.equal(selectorsToCss([".a", ".b"]), ".a { display: none !important; }\n.b { display: none !important; }");
  assert.equal(selectorsToCss([".a", ".b", ".c"], "x: y;", 2), ".a,\n.b { x: y; }\n.c { x: y; }");
});

test("converts network filters to DNR rules", () => {
  assert.deepEqual(convertNetworkFilter("||ads.example.com^"), {
    priority: PRIORITY.userBlock,
    action: { type: "block" },
    condition: { urlFilter: "||ads.example.com^" },
  });
  assert.deepEqual(convertNetworkFilter("@@||cdn.example.com/ads.js$script,domain=example.com|~shop.example.com"), {
    priority: PRIORITY.userAllow,
    action: { type: "allow" },
    condition: {
      urlFilter: "||cdn.example.com/ads.js",
      resourceTypes: ["script"],
      initiatorDomains: ["example.com"],
      excludedInitiatorDomains: ["shop.example.com"],
    },
  });
  assert.deepEqual(convertNetworkFilter("@@||example.com^$document").action, { type: "allowAllRequests" });
  assert.equal(convertNetworkFilter("/banner\\d+/$third-party").condition.regexFilter, "banner\\d+");
  assert.equal(convertNetworkFilter("||x.com^$important").priority, PRIORITY.userBlock + 5000);
});

test("rejects network filters it cannot express", () => {
  assert.equal(convertNetworkFilter("||x.com^$popup"), null);
  assert.equal(convertNetworkFilter("||x.com^$rewrite=abp-resource:blank-js"), null);
  assert.equal(convertNetworkFilter("*$script"), null);
});

test("splits user filter text", () => {
  const { cosmetic, rules, invalid } = parseFilterText(
    ["! comment", "||ads.example.com^", "example.com##.box", "example.com#?#.x:-abp-has(.y)", "", "@@||ok.com^$elemhide"].join("\n"),
  );
  assert.equal(rules.length, 1);
  assert.deepEqual(cosmetic.lookup("example.com").specific, [".box"]);
  assert.deepEqual(cosmetic.elemhide, ["ok.com"]);
  assert.deepEqual(invalid, ["example.com#?#.x:-abp-has(.y)"]);
});
