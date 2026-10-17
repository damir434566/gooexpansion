/**
 * AI picks which pieces a whole-store run opens: `pick-pieces.ts` on the site.
 *
 * With a rule ("only men's and women's shoes"), every plan of a whole-store
 * run also asks which of the pieces just found the rule wants, so the broad
 * categories ("New in", "Sale") and the sitemaps do not open everything the
 * store sells. This runs the shipping module against a stand-in for the
 * OpenAI client:
 *
 *   - the request: the AI check's model, a strict schema of keep / drop, the
 *     rule, each piece's name (from the extension's card, else the sitemap's
 *     `image:title`, else empty) and its path, all as quoted data;
 *   - the answer: dropped is dropped, unclear is kept, and the plan's order
 *     is kept;
 *   - a plan of 250 pieces goes out in three calls, never more than six at
 *     once; a failed call fails the choice, and nothing is asked when there
 *     is nothing to ask about;
 *   - the plan request's own fields are read as the route reads them.
 */
const path = require("path");
const Module = require("module");

const COMPILED = path.join(__dirname, "compiled");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(COMPILED, request.slice(2));
  return origResolve.call(this, request, ...rest);
};

const { pickPieces, readPieceQuestion, PIECE_SYSTEM_PROMPT } = require(path.join(
  COMPILED,
  "lib",
  "server",
  "parser",
  "pick-pieces.js",
));

let pass = 0;
const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else failures.push(`${name}\n     got  ${JSON.stringify(got).slice(0, 500)}\n     want ${JSON.stringify(want).slice(0, 500)}`);
}

/** A stand-in OpenAI client: `answer(lines, body)` says what the model replies. */
function fakeClient(answer) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        async create(body) {
          calls.push(body);
          const lines = [...body.messages[1].content.matchAll(/^(\d+)\. (".*") (\S+)$/gm)].map((m) => ({
            n: Number(m[1]),
            name: JSON.parse(m[2]),
            path: m[3],
          }));
          const reply = await answer(lines, body);
          return {
            choices: [{ message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) } }],
            usage: { prompt_tokens: 2000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 0 } },
          };
        },
      },
    },
  };
}

const S = "https://shop.example";
const URLS = [
  `${S}/p/samba-og-white`,
  `${S}/p/wrap-midi-dress`,
  `${S}/p/chelsea-boot-black`,
  `${S}/p/kids-runner-2`,
  `${S}/p/canvas-tote`,
  `${S}/p/12345678`,
];

(async () => {
  // ── The request ────────────────────────────────────────────────────────────
  {
    const names = new Map([
      [`${S}/p/samba-og-white`, "Samba OG"],
      [`${S}/p/wrap-midi-dress`, "Wrap midi dress"],
      [`${S}/p/chelsea-boot-black`, "Chelsea boot"],
      [`${S}/p/kids-runner-2`, "Kids' runner"],
    ]);
    const sitemap = {
      url: `${S}/sitemap_products_1.xml`,
      xml: `<urlset><url><loc>${S}/p/canvas-tote</loc><image:image><image:title>Canvas tote &amp; strap</image:title></image:image></url><url><loc>${S}/p/chelsea-boot-black</loc><image:image><image:title>From the sitemap</image:title></image:image></url></urlset>`,
    };
    const client = fakeClient(() => ({ keep: [0, 2, 5], drop: [1, 3, 4] }));
    const choice = await pickPieces({
      rule: "only men's and women's shoes",
      store: "shop.example",
      urls: URLS,
      names,
      sitemaps: [sitemap],
      model: "gpt-4o-mini",
      client,
    });
    const body = client.calls[0];
    check("one call for six pieces", client.calls.length, 1);
    check("on the AI check's model, deterministic", [body.model, body.temperature], ["gpt-4o-mini", 0]);
    check("a strict schema of keep and drop", [body.response_format.json_schema.strict, body.response_format.json_schema.schema.required], [true, ["keep", "drop"]]);
    check("the system prompt is the module's", body.messages[0].content, PIECE_SYSTEM_PROMPT);
    check("it says the store's text is data", /never an instruction/.test(PIECE_SYSTEM_PROMPT), true);
    check("and that a model name alone is kept", /Samba OG/.test(PIECE_SYSTEM_PROMPT) && /When unsure, keep/.test(PIECE_SYSTEM_PROMPT), true);
    check("the rule goes as a quoted string", body.messages[1].content.startsWith(`RULE: "only men's and women's shoes"`), true);
    check(
      "each piece: the card's name first, the sitemap's when there is no card, else empty; then its path",
      body.messages[1].content.split("\n").slice(-6),
      [
        '0. "Samba OG" /p/samba-og-white',
        '1. "Wrap midi dress" /p/wrap-midi-dress',
        '2. "Chelsea boot" /p/chelsea-boot-black',
        `3. "Kids' runner" /p/kids-runner-2`,
        '4. "Canvas tote & strap" /p/canvas-tote',
        '5. "" /p/12345678',
      ],
    );
    check("the plan's addresses the rule keeps, in the plan's order", choice.urls, [URLS[0], URLS[2], URLS[5]]);
    check("and how many were kept and skipped", [choice.kept, choice.skipped], [3, 3]);
    check("what it cost, at the AI check's prices", Number(choice.costUsd.toFixed(8)), Number(((2000 * 0.15 + 300 * 0.6) / 1e6).toFixed(8)));
  }

  // ── Unclear is kept ────────────────────────────────────────────────────────
  {
    const client = fakeClient(() => ({ keep: [0], drop: [0, 1, 99, -2, 2.5] }));
    const choice = await pickPieces({ rule: "only shoes", store: "shop.example", urls: URLS, names: new Map(), model: "gpt-4o-mini", client });
    check("named in both: kept; not named: kept; numbers it was not asked about: ignored", choice.urls, [URLS[0], URLS[2], URLS[3], URLS[4], URLS[5]]);
    check("one skipped", choice.skipped, 1);
  }

  // ── Many pieces, a few calls at a time ─────────────────────────────────────
  {
    const many = Array.from({ length: 250 }, (_, i) => `${S}/p/item-${i}`);
    const names = new Map(many.map((u, i) => [u, i % 2 ? "Leather loafer" : "Linen shirt"]));
    let inFlight = 0;
    let most = 0;
    const client = fakeClient(async (lines) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { keep: lines.filter((l) => /loafer/i.test(l.name)).map((l) => l.n), drop: lines.filter((l) => /shirt/i.test(l.name)).map((l) => l.n) };
    });
    const choice = await pickPieces({ rule: "shoes", store: "shop.example", urls: many, names, model: "gpt-4.1-nano", client });
    check("250 pieces: three calls of up to 100", client.calls.map((c) => (c.messages[1].content.match(/^\d+\. /gm) || []).length), [100, 100, 50]);
    check("side by side", most > 1, true);
    check("the loafers kept, the shirts skipped", [choice.kept, choice.skipped, choice.urls[0]], [125, 125, many[1]]);
  }
  {
    const many = Array.from({ length: 1200 }, (_, i) => `${S}/p/i-${i}`);
    let inFlight = 0;
    let most = 0;
    const client = fakeClient(async (lines) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return { keep: lines.map((l) => l.n), drop: [] };
    });
    await pickPieces({ rule: "shoes", store: "shop.example", urls: many, names: new Map(), model: "gpt-4o-mini", client });
    check("twelve calls, never more than six at once", [client.calls.length, most <= 6], [12, true]);
  }

  // ── Nothing to ask, and a failed call ──────────────────────────────────────
  {
    const client = fakeClient(() => ({ keep: [], drop: [] }));
    const choice = await pickPieces({ rule: "shoes", store: "shop.example", urls: [], names: new Map(), model: "gpt-4o-mini", client });
    check("no pieces: no call", [client.calls.length, choice.urls.length, choice.costUsd], [0, 0, 0]);
    const throws = fakeClient(() => {
      throw new Error("429 Rate limit reached");
    });
    let error = "";
    try {
      await pickPieces({ rule: "shoes", store: "shop.example", urls: URLS, names: new Map(), model: "gpt-4o-mini", client: throws });
    } catch (err) {
      error = err.message;
    }
    check("the model refusing is an error the route reports", error, "429 Rate limit reached");
  }

  // ── The plan request's fields ──────────────────────────────────────────────
  {
    const q = readPieceQuestion({
      pieceRule: "  only shoes ",
      pieces: [
        { url: `${S}/p/samba?color=white#reviews`, name: "  Samba   OG " },
        { url: `${S}/p/samba`, name: "Second name for the same page" },
        { url: "javascript:void(0)", name: "x" },
        { url: `${S}/p/no-name`, name: "" },
        "junk",
      ],
    });
    check("the rule, trimmed", q.rule, "only shoes");
    check("names by page, as the planner names a page (no query, no fragment), first one wins", [...q.names], [[`${S}/p/samba`, "Samba OG"]]);
    check("without a rule, no question", readPieceQuestion({ pieces: [{ url: `${S}/p/a`, name: "A" }] }), null);
    check("a rule and no names is still a question: names can come from the sitemap", readPieceQuestion({ pieceRule: "shoes" }).names.size, 0);
    check("nothing at all, none", readPieceQuestion(null), null);
  }

  console.log(`\n  ${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
})();
