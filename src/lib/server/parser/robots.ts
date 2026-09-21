/**
 * robots.txt — what the store says we may read, and how fast.
 *
 * This matters more here than in the rest of the parser, because collection no
 * longer runs on our server. It runs in the admin's own browser, on their home
 * connection, under their address. A crawl that ignores robots.txt from a
 * Vercel function costs us an IP nobody will miss; the same crawl from a
 * kitchen in Kyiv costs the admin their own address, on every store at once,
 * and there is no rotating it back.
 *
 * So the rules are read and obeyed rather than logged. Three things come out of
 * the file:
 *
 *   Disallow/Allow — which paths are ours to open, by the longest-match rule
 *   Crawl-delay    — the pace the store itself asked for
 *   Sitemap        — where the catalogue is listed, which saves walking the HTML
 *
 * Two deliberate narrowings:
 *
 * **Only the `*` group is read.** We are not Googlebot and will not pretend to
 * be: taking the Googlebot group would be claiming permissions granted to a
 * crawler that sends traffic back, which we do not. Where a store writes a
 * kinder rule for search engines and a stricter one for everyone, everyone is
 * us.
 *
 * **Parsing is pure.** `parseRobots` takes text and returns rules; it asks the
 * network nothing. The fetch happens in the admin's browser, which is the whole
 * point of the extension — their IP, their cookies, their already-passed
 * challenge. The server only ever sees the text that came back.
 */

/**
 * The rules from one robots.txt, already reduced to the `*` group.
 *
 * Patterns are kept as written rather than pre-compiled, because the longest
 * match is decided on the *pattern's* length and keeping the source string is
 * what makes that legible when a decision has to be explained.
 */
export interface RobotsRules {
  /** `Allow:` patterns from the `*` group, in file order. */
  allow: string[];
  /** `Disallow:` patterns from the `*` group, in file order. Empty values dropped. */
  disallow: string[];
  /** `Crawl-delay:` in milliseconds, or null when the store did not ask for one. */
  crawlDelayMs: number | null;
  /** Every `Sitemap:` line in the file — these are global, not per-group. */
  sitemaps: string[];
  /** False when the text could not be read as robots.txt at all (404 page, HTML). */
  parsed: boolean;
}

/** What an absent or unreadable robots.txt means: nothing is forbidden. */
export const PERMISSIVE: RobotsRules = {
  allow: [],
  disallow: [],
  crawlDelayMs: null,
  sitemaps: [],
  parsed: false,
};

/**
 * A robots.txt path pattern as a regex anchored at the start of the path.
 *
 * The format is not a glob and not a regex: `*` stands for any run of
 * characters, a trailing `$` anchors the end, and every other character is
 * literal — including the `.` and `?` that turn up in `/*.php?` style rules and
 * would otherwise quietly match far more than the store wrote.
 */
function patternToRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      out += ".*";
      continue;
    }
    // `$` is an end-anchor only as the final character; anywhere else it is a
    // literal dollar sign, which is how some stores write query-string rules.
    if (ch === "$" && i === pattern.length - 1) {
      out += "$";
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}`);
}

/** The longest pattern in `patterns` that matches `path`, or -1 for none. */
function longestMatch(patterns: string[], path: string): number {
  let best = -1;
  for (const p of patterns) {
    if (p.length <= best) continue; // cannot win — skip the regex entirely
    if (patternToRegex(p).test(path)) best = p.length;
  }
  return best;
}

/**
 * Read robots.txt into rules, taking the `*` group only.
 *
 * Group structure is the fiddly part of the format: a run of consecutive
 * `User-agent:` lines shares the rules that follow it, and the group ends at
 * the next `User-agent:` after at least one rule. That is why the agent list
 * accumulates and is only cleared once a rule has been seen — a file opening
 * with `User-agent: Googlebot` / `User-agent: *` gives *both* agents the same
 * block, and reading it any other way loses the block that applies to us.
 *
 * `Sitemap:` is deliberately handled outside the group machinery: the standard
 * defines it as a global directive, and stores routinely put it at the top of
 * the file, above any `User-agent:` line at all.
 */
export function parseRobots(text: string): RobotsRules {
  const rules: RobotsRules = {
    allow: [],
    disallow: [],
    crawlDelayMs: null,
    sitemaps: [],
    parsed: false,
  };
  if (typeof text !== "string" || !text.trim()) return rules;

  // A store that answers /robots.txt with its 404 page hands us HTML. Treating
  // that as "no rules" is right, but treating it as a *parsed* empty file is
  // not — the caller shows the difference to the admin.
  if (/^\s*</.test(text)) return rules;

  /** Agents naming the group we are currently inside. */
  let agents: string[] = [];
  /** Whether a rule has been seen since the last `User-agent:` run began. */
  let inRules = false;
  /** Whether the group we are inside is the one addressed to everyone. */
  let starGroup = false;
  let sawDirective = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;

    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === "sitemap") {
      sawDirective = true;
      if (value) rules.sitemaps.push(value);
      continue;
    }

    if (field === "user-agent") {
      sawDirective = true;
      // A `User-agent:` after rules starts a fresh group.
      if (inRules) {
        agents = [];
        inRules = false;
      }
      agents.push(value.toLowerCase());
      starGroup = agents.includes("*");
      continue;
    }

    if (field !== "allow" && field !== "disallow" && field !== "crawl-delay") continue;

    sawDirective = true;
    inRules = true;
    if (!starGroup) continue;

    if (field === "crawl-delay") {
      // Seconds in the file, and fractional values are legal. A nonsense value
      // is ignored rather than guessed at.
      const secs = Number(value.replace(",", "."));
      if (Number.isFinite(secs) && secs > 0) {
        rules.crawlDelayMs = Math.round(secs * 1000);
      }
      continue;
    }

    // An empty `Disallow:` is the documented way to say "nothing is forbidden",
    // so it must not become a pattern that matches every path. An empty
    // `Allow:` carries no meaning at all.
    if (!value) continue;
    if (field === "allow") rules.allow.push(value);
    else rules.disallow.push(value);
  }

  rules.parsed = sawDirective;
  return rules;
}

/**
 * May we open this path?
 *
 * The longest-match rule, as the standard defines it: whichever of the Allow
 * and Disallow patterns matches the most characters wins, and a tie goes to
 * Allow. That ordering is not a detail — `Disallow: /` with `Allow: /products/`
 * is the ordinary shape of a store that wants its catalogue indexed and nothing
 * else, and reading it the other way round would refuse the one thing we came
 * for.
 */
export function isPathAllowed(rules: RobotsRules, pathname: string): boolean {
  const path = pathname || "/";
  const deny = longestMatch(rules.disallow, path);
  if (deny < 0) return true;
  return longestMatch(rules.allow, path) >= deny;
}

/** May we open this absolute URL? Malformed URLs are refused, not assumed safe. */
export function isUrlAllowed(rules: RobotsRules, url: string): boolean {
  try {
    const u = new URL(url);
    return isPathAllowed(rules, `${u.pathname}${u.search}`);
  } catch {
    return false;
  }
}
