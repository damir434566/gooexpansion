/**
 * The AI check sets a piece's style: `catalogue-check/fields.ts` and `ai.ts`.
 *
 * Plan 001: a piece the extension collects should arrive with its style set,
 * not only with what the style dictionary reads off its page. So the AI
 * check's agent speaks about one more field, `style`, and it is held to the
 * catalogue's five styles (casual, minimal, classic, streetwear, sporty):
 *
 *   - judgeFixes: a sure style out of the five becomes a write to
 *     `style_keywords`, in the vocabulary's order; a style outside them, an
 *     empty list, more than three, or the same styles again are refused, and
 *     a guess is dropped;
 *   - the record the model reads carries its current styles (stored tags no
 *     longer in the vocabulary left out), and a style write does not change
 *     the record's fingerprint, so it does not send the piece back to the
 *     model;
 *   - the request: the strict schema lets the model name `style`, and the
 *     shared block lists the five with what each means.
 *
 * Runs the shipping modules; the OpenAI client is a stand-in.
 */
const path = require("path");
const Module = require("module");

const COMPILED = path.join(__dirname, "compiled");

// ── A stand-in for the openai package: it records the request ───────────────
const requests = [];
let reply = { products: [] };
class FakeOpenAI {
  constructor() {
    this.chat = {
      completions: {
        create: async (body) => {
          requests.push(body);
          return {
            choices: [{ message: { content: JSON.stringify(reply) } }],
            usage: { prompt_tokens: 1200, completion_tokens: 80 },
          };
        },
      },
    };
  }
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "openai") return "fake-openai";
  if (request.startsWith("@/")) request = path.join(COMPILED, request.slice(2));
  return origResolve.call(this, request, ...rest);
};
require.cache["fake-openai"] = {
  id: "fake-openai",
  filename: "fake-openai",
  loaded: true,
  exports: { __esModule: true, default: FakeOpenAI },
};

const fields = require(path.join(COMPILED, "lib", "server", "catalogue-check", "fields.js"));
const ai = require(path.join(COMPILED, "lib", "server", "catalogue-check", "ai.js"));

let pass = 0;
const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else failures.push(`${name}\n     got  ${JSON.stringify(got).slice(0, 500)}\n     want ${JSON.stringify(want).slice(0, 500)}`);
}

const ctx = {
  tree: [{ label: "Shoes", items: [{ label: "Sneakers", value: "shoes" }] }],
  colorGroups: [{ id: 1, name: "White" }],
  brands: ["Nike"],
};
const runner = {
  id: "p1",
  name: "Pegasus 41 running shoe",
  brand: "Nike",
  category: "shoes",
  subcategory: "Sneakers",
  gender: "men",
  colors: ["White"],
  color_group_ids: [1],
  description: "A responsive road running shoe for daily training.",
  source_url: "https://store.example/nike-pegasus-41",
  style_keywords: [],
  catalogue_fingerprint: null,
};
const fix = (value, confidence = "high") => ({ field: "style", value, confidence, reason: "a running shoe for training" });
const judge = (row, value, confidence) => fields.judgeFixes(row, [fix(value, confidence)], ctx);

(async () => {
  // ── What may be written ─────────────────────────────────────────────────
  const sure = judge(runner, ["Sporty"]);
  check("a sure style out of the five is written to style_keywords", sure.fixes.map((f) => [f.field, f.before, f.after, f.confidence]), [
    ["style", { style_keywords: [] }, { style_keywords: ["sporty"] }, "high"],
  ]);
  check("and nothing is refused", sure.rejected, []);

  const two = judge(runner, ["streetwear", "casual", "Casual"]);
  check("several styles: once each, in the vocabulary's order", two.fixes.map((f) => f.after), [{ style_keywords: ["casual", "streetwear"] }]);

  const unknown = judge(runner, ["bohemian"]);
  check("a style the catalogue does not have is refused", [unknown.fixes.length, unknown.rejected], [
    0,
    [{ field: "style", reason: "bohemian is not one of the catalogue's styles" }],
  ]);
  const mixed = judge(runner, ["sporty", "techwear"]);
  check("one unknown style refuses the whole fix", [mixed.fixes.length, mixed.rejected.map((r) => r.reason)], [
    0,
    ["techwear is not one of the catalogue's styles"],
  ]);
  check("an empty list never clears a style", judge({ ...runner, style_keywords: ["sporty"] }, []).rejected, [
    { field: "style", reason: "clears the style" },
  ]);
  check("more than three styles say nothing", judge(runner, ["casual", "minimal", "classic", "sporty"]).rejected, [
    { field: "style", reason: "more than 3 styles" },
  ]);
  check("the same styles in another order are no change", judge({ ...runner, style_keywords: ["casual", "sporty"] }, ["sporty", "casual"]).rejected, [
    { field: "style", reason: "no change" },
  ]);
  const guess = judge(runner, ["classic"], "low");
  check("a guess is neither written nor logged", [guess.fixes.length, guess.rejected.length], [0, 0]);
  const likely = judge(runner, ["sporty"], "medium");
  check("a likely style is a suggestion for a person", likely.fixes.map((f) => f.confidence), ["medium"]);

  // A tag dropped from the vocabulary on 2026-09-29 is not a style any more.
  const old = { ...runner, style_keywords: ["bohemian"] };
  check("the model reads stored tags outside the five as no style", fields.productForModel(old, ctx.colorGroups).style, []);
  check("the model reads the piece's current styles", fields.productForModel({ ...runner, style_keywords: ["sporty"] }, ctx.colorGroups).style, ["sporty"]);
  check(
    "a style over an old tag: the old tag is what the write expects to find",
    judge(old, ["sporty"]).fixes.map((f) => [f.before, f.after]),
    [[{ style_keywords: ["bohemian"] }, { style_keywords: ["sporty"] }]],
  );

  // ── Written, and not sent back to the model for it ──────────────────────
  const after = fields.rowAfter(runner, sure.fixes);
  check("the row once written carries the style", after.style_keywords, ["sporty"]);
  check("a style write leaves the fingerprint as it was", fields.fingerprint(after), fields.fingerprint(runner));
  check("so a checked piece is not checked again for its new style", fields.needsCheck({ ...after, catalogue_fingerprint: fields.fingerprint(runner) }), false);
  check("apply holds against the row as it is", fields.rowHolds(runner, sure.fixes[0].before), true);
  check("and goes stale once someone set a style meanwhile", fields.rowHolds({ ...runner, style_keywords: ["classic"] }, sure.fixes[0].before), false);
  check("the check reads the style column", fields.CHECK_COLUMNS.includes("style_keywords"), true);

  // ── The request to the model ────────────────────────────────────────────
  reply = { products: [{ id: "p1", fixes: [fix(["sporty"])] }] };
  const result = await ai.checkProductsWithModel([fields.productForModel(runner, ctx.colorGroups)], { ...ctx, notes: "" }, "gpt-4o-mini", "sk-test");
  const body = requests[0];
  const fieldEnum = body.response_format.json_schema.schema.properties.products.items.properties.fixes.items.properties.field.enum;
  check("the strict schema lets the model name style", [body.response_format.json_schema.strict, fieldEnum.includes("style")], [true, true]);
  const system = body.messages[0].content;
  const block = system.slice(system.indexOf("CATALOGUE STYLES"));
  check(
    "the shared block lists the five styles, each with its meaning",
    ["casual", "minimal", "classic", "streetwear", "sporty"].map((s) => new RegExp(`^- ${s}: \\S`, "m").test(block)),
    [true, true, true, true, true],
  );
  check("and no style besides them", (block.split("\n\n")[0].match(/^- /gm) || []).length, 5);
  check("the rules say style is never another word and never cleared", [/style: one to three of the catalogue's styles/.test(system), /never another word/.test(system), /never clear it/.test(system)], [true, true, true]);
  check("the record sent carries its styles", JSON.parse(body.messages[1].content.split("\n")[1]).style, []);
  check("the answer comes back as the model gave it", result.fixes.get("p1"), [fix(["sporty"])]);
  check("and goes through the same judgement", fields.judgeFixes(runner, result.fixes.get("p1"), ctx).fixes.map((f) => f.after), [{ style_keywords: ["sporty"] }]);

  console.log(`\n  ${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
})();
