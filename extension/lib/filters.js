// Filter parsing shared by the build script (Node) and the extension runtime.
// Static filter lists are converted at build time with @eyeo/abp2dnr; this
// module handles cosmetic filters everywhere and the user's own network
// filters at runtime, where abp2dnr (native RE2) is not available.

const COSMETIC_RE = /^([^/|@"!]*?)#([@?$%]{0,2})#(.+)$/;

// Selectors using procedural / scriptlet syntax that browsers cannot apply as
// plain CSS. Filters containing them are skipped.
const UNSUPPORTED_SELECTOR_RE =
  /:-abp-|:has-text\(|:contains\(|:xpath\(|:matches-css|:upward\(|:remove\(|:style\(|:watch-attr\(|:min-text-length\(|:others\(|:if\(|:if-not\(|:nth-ancestor\(|:matches-path\(|:matches-attr\(|:matches-prop\(|:remove-attr\(|:remove-class\(|\+js\(/;

export const PRIORITY = {
  userBlock: 1500,
  userAllow: 4000,
  allowlist: 10000,
};

function splitDomains(text) {
  const include = [];
  const exclude = [];
  for (const raw of text.split(/[,|]/)) {
    const d = raw.trim().toLowerCase();
    if (!d) continue;
    if (d.startsWith("~")) exclude.push(d.slice(1));
    else include.push(d);
  }
  return { include, exclude };
}

/**
 * Parses an element hiding filter (`example.com##.ad`, `##.ad`, `#@#.ad`).
 * Returns null for comments, network filters and unsupported syntaxes
 * (`#?#` procedural, `#$#` snippets).
 */
export function parseCosmeticFilter(line) {
  const m = COSMETIC_RE.exec(line.trim());
  if (!m) return null;
  const [, domainText, marker, selector] = m;
  if (marker !== "" && marker !== "@") return null;
  if (UNSUPPORTED_SELECTOR_RE.test(selector)) return null;
  return {
    exception: marker === "@",
    domains: splitDomains(domainText),
    selector: selector.trim(),
  };
}

export function isCosmeticFilter(line) {
  return COSMETIC_RE.test(line.trim());
}

// `@@||example.com^$elemhide` style exceptions disable element hiding.
const HIDE_EXCEPTION_RE = /^@@\|\|([a-z0-9.-]+)\^?\$(.+)$/i;

export function parseHideException(line) {
  const m = HIDE_EXCEPTION_RE.exec(line.trim());
  if (!m) return null;
  const options = m[2].toLowerCase().split(",");
  const domain = m[1].toLowerCase();
  if (options.includes("elemhide") || options.includes("ehide") || options.includes("document")) {
    return { domain, kind: "elemhide" };
  }
  if (options.includes("generichide") || options.includes("ghide")) {
    return { domain, kind: "generichide" };
  }
  return null;
}

function* hostnameSuffixes(hostname) {
  let host = hostname.toLowerCase().replace(/\.$/, "");
  while (host) {
    yield host;
    const dot = host.indexOf(".");
    if (dot < 0) break;
    host = host.slice(dot + 1);
  }
}

function pushTo(map, key, value) {
  (map[key] ||= []).push(value);
}

/**
 * Index of element hiding filters. Serializable so the build script can ship
 * one per filter list and the background can merge the enabled ones.
 */
export class CosmeticIndex {
  constructor(data = {}) {
    this.generic = data.generic || [];
    this.specific = data.specific || {};
    this.exceptions = data.exceptions || {};
    this.genericExceptions = data.genericExceptions || [];
    this.elemhide = data.elemhide || [];
    this.generichide = data.generichide || [];
  }

  addFilter(filter) {
    const { exception, domains, selector } = filter;
    if (exception) {
      if (domains.include.length === 0) this.genericExceptions.push(selector);
      for (const d of domains.include) pushTo(this.exceptions, d, selector);
      return;
    }
    if (domains.include.length === 0) {
      this.generic.push(selector);
    } else {
      for (const d of domains.include) pushTo(this.specific, d, selector);
    }
    for (const d of domains.exclude) pushTo(this.exceptions, d, selector);
  }

  addHideException({ domain, kind }) {
    (kind === "elemhide" ? this.elemhide : this.generichide).push(domain);
  }

  merge(other) {
    this.generic.push(...other.generic);
    this.genericExceptions.push(...other.genericExceptions);
    this.elemhide.push(...other.elemhide);
    this.generichide.push(...other.generichide);
    for (const [d, sels] of Object.entries(other.specific)) {
      (this.specific[d] ||= []).push(...sels);
    }
    for (const [d, sels] of Object.entries(other.exceptions)) {
      (this.exceptions[d] ||= []).push(...sels);
    }
    this._genericSet = null;
  }

  toJSON() {
    return {
      generic: this.generic,
      specific: this.specific,
      exceptions: this.exceptions,
      genericExceptions: this.genericExceptions,
      elemhide: this.elemhide,
      generichide: this.generichide,
    };
  }

  /** Selectors to hide on `hostname`, split so generic CSS can be cached. */
  lookup(hostname) {
    const suffixes = [...hostnameSuffixes(hostname)];
    if (suffixes.some((s) => this.elemhide.includes(s))) {
      return { specific: [], generic: false, exceptions: [] };
    }
    const exceptions = new Set(this.genericExceptions);
    const specific = new Set();
    for (const s of suffixes) {
      for (const sel of this.exceptions[s] || []) exceptions.add(sel);
      for (const sel of this.specific[s] || []) specific.add(sel);
    }
    for (const sel of exceptions) specific.delete(sel);
    const generic = !suffixes.some((s) => this.generichide.includes(s));
    return { specific: [...specific], generic, exceptions: [...exceptions] };
  }

  genericSelectors(exceptions = []) {
    if (exceptions.length === 0) return this.generic;
    const skip = new Set(exceptions);
    return this.generic.filter((sel) => !skip.has(sel));
  }
}

/** Builds CSS hiding `selectors`, grouped to keep the stylesheet small. */
export function selectorsToCss(selectors, declaration = "display: none !important;", groupSize = 1) {
  const out = [];
  for (let i = 0; i < selectors.length; i += groupSize) {
    out.push(`${selectors.slice(i, i + groupSize).join(",\n")} { ${declaration} }`);
  }
  return out.join("\n");
}

const RESOURCE_TYPES = {
  script: "script",
  image: "image",
  stylesheet: "stylesheet",
  object: "object",
  xmlhttprequest: "xmlhttprequest",
  xhr: "xmlhttprequest",
  subdocument: "sub_frame",
  frame: "sub_frame",
  font: "font",
  media: "media",
  websocket: "websocket",
  ping: "ping",
  other: "other",
  popup: null,
};

/**
 * Converts one network filter in Adblock Plus syntax into a DNR rule
 * (without id). DNR's urlFilter syntax (`||`, `|`, `^`, `*`) mirrors ABP's,
 * so patterns pass through unchanged. Returns null when the filter uses an
 * option we cannot express.
 */
export function convertNetworkFilter(text) {
  let line = text.trim();
  if (!line || line.startsWith("!") || line.startsWith("[") || isCosmeticFilter(line)) return null;

  const allow = line.startsWith("@@");
  if (allow) line = line.slice(2);

  let pattern = line;
  let optionText = "";
  const dollar = line.lastIndexOf("$");
  if (dollar >= 0 && !/^\/.*\/$/.test(line)) {
    pattern = line.slice(0, dollar);
    optionText = line.slice(dollar + 1);
  }

  const condition = {};
  const action = { type: allow ? "allow" : "block" };
  let priority = allow ? PRIORITY.userAllow : PRIORITY.userBlock;
  const types = [];
  const excludedTypes = [];

  for (const rawOption of optionText ? optionText.split(",") : []) {
    const [nameRaw, value] = rawOption.split("=");
    const negated = nameRaw.startsWith("~");
    const name = nameRaw.replace(/^~/, "").toLowerCase();
    if (name === "third-party" || name === "3p") {
      condition.domainType = negated ? "firstParty" : "thirdParty";
    } else if (name === "first-party" || name === "1p") {
      condition.domainType = negated ? "thirdParty" : "firstParty";
    } else if (name === "domain" && value) {
      const { include, exclude } = splitDomains(value);
      if (include.length) condition.initiatorDomains = include;
      if (exclude.length) condition.excludedInitiatorDomains = exclude;
    } else if (name === "match-case") {
      condition.isUrlFilterCaseSensitive = true;
    } else if (name === "important") {
      priority += 5000;
    } else if (name === "document" && !negated) {
      if (allow) action.type = "allowAllRequests";
      types.push("main_frame", "sub_frame");
    } else if (name in RESOURCE_TYPES) {
      const type = RESOURCE_TYPES[name];
      if (!type) return null;
      (negated ? excludedTypes : types).push(type);
    } else {
      return null;
    }
  }

  if (action.type === "allowAllRequests") {
    condition.resourceTypes = ["main_frame", "sub_frame"];
  } else {
    if (types.length) condition.resourceTypes = [...new Set(types)];
    if (excludedTypes.length) condition.excludedResourceTypes = [...new Set(excludedTypes)];
  }

  if (/^\/.+\/$/.test(pattern)) {
    condition.regexFilter = pattern.slice(1, -1);
  } else if (pattern && pattern !== "*") {
    condition.urlFilter = pattern;
  }
  if (!condition.urlFilter && !condition.regexFilter && !condition.initiatorDomains) return null;

  return { priority, action, condition };
}

/** Splits user-entered filter text into cosmetic filters and DNR rules. */
export function parseFilterText(text) {
  const cosmetic = new CosmeticIndex();
  const rules = [];
  const invalid = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("!") || line.startsWith("[")) continue;
    if (isCosmeticFilter(line)) {
      const filter = parseCosmeticFilter(line);
      if (filter) cosmetic.addFilter(filter);
      else invalid.push(line);
      continue;
    }
    const hideException = parseHideException(line);
    if (hideException) {
      cosmetic.addHideException(hideException);
      continue;
    }
    const rule = convertNetworkFilter(line);
    if (rule) rules.push(rule);
    else invalid.push(line);
  }
  return { cosmetic, rules, invalid };
}
