// Приёмочная проверка snapshot.js расширения Goo Collect.
//
//   npm i -D playwright && npx playwright install chromium
//   node check.mjs ../extension/snapshot.js
//
// Поднимает локальный сервер с шестью страницами-образцами, выполняет на каждой
// snapshot.js так же, как background.js (результат IIFE), и сверяет поля,
// которые уходят на сервер. Выход 0 — всё сошлось, 1 — есть расхождения.
// Переменные: PLAYWRIGHT_MODULE — путь к index.mjs playwright, если он не
// установлен рядом; CHROME_PATH — свой бинарник Chromium.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = process.argv[2];
if (!scriptPath) {
  console.error("Укажите путь к snapshot.js: node check.mjs ../extension/snapshot.js");
  process.exit(2);
}
const script = readFileSync(scriptPath, "utf8");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const page = (name) => readFileSync(join(here, "pages", name), "utf8");
const routes = {
  "/products/emerson": ["text/html; charset=utf-8", page("etnies.html")],
  "/products/classic-hoodie": ["text/html; charset=utf-8", page("dawn.html")],
  "/products/classic-clog": ["text/html; charset=utf-8", page("babymetal.html")],
  "/products/wool-coat": ["text/html; charset=utf-8", page("plain.html")],
  "/products/jordan-leather-jkt": ["text/html; charset=utf-8", page("mowalola.html")],
  "/products/jordan-leather-jkt.json": ["application/json", page("jordan-leather-jkt.json")],
  "/meta.json": ["application/json", page("meta.json")],
  "/products/stack-jacket-black-white": ["text/html; charset=utf-8", page("stack.html")],
};
const server = createServer((req, res) => {
  const hit = routes[req.url.split("?")[0]];
  if (!hit) return res.writeHead(404).end("not found");
  res.writeHead(200, { "Content-Type": hit[0] }).end(hit[1]);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const origin = `http://127.0.0.1:${server.address().port}`;

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cases = [
  {
    name: "etnies: цвет из подписи, а не alt фото («Emerson»)",
    path: "/products/emerson",
    check: (r) => [["colorText", r.colorText, "grey/white/leather"]],
  },
  {
    name: "Shopify Dawn: выбранная радиокнопка цвета",
    path: "/products/classic-hoodie",
    check: (r) => [["colorText", r.colorText, "Washed Black"]],
  },
  {
    name: "Название цвета из data-value сохраняется («Babymetal Storm»)",
    path: "/products/classic-clog",
    check: (r) => [["colorText", r.colorText, "Babymetal Storm"]],
  },
  {
    name: "Обычный магазин: «Colour: Camel»",
    path: "/products/wool-coat",
    check: (r) => [["colorText", r.colorText, "Camel"]],
  },
  {
    name: "colorCandidates — массив {value, origin}",
    path: "/products/emerson",
    check: (r) => [[
      "colorCandidates",
      Array.isArray(r.colorCandidates) && r.colorCandidates.every((c) => typeof c.value === "string" && typeof c.origin === "string"),
      true,
    ]],
  },
  {
    name: "Stack Jacket: «вам может понравиться» не попадает в цвета",
    path: "/products/stack-jacket-black-white",
    check: (r) => [[
      "variantUrls",
      r.variantUrls,
      [`${origin}/products/stack-jacket-blue-black`, `${origin}/products/stack-jacket-camo-black`],
    ]],
  },
  {
    name: "mowalola: название у кнопки покупки",
    path: "/products/jordan-leather-jkt",
    check: (r) => [["titleText", r.titleText, "JORDAN LEATHER JACKET"]],
  },
  {
    name: "mowalola: JSON товара Shopify и валюта магазина",
    path: "/products/jordan-leather-jkt",
    check: (r) => [
      ["shopify.product.handle", r.shopify && r.shopify.product && r.shopify.product.handle, "jordan-leather-jkt"],
      ["shopify.product.images.length", r.shopify && r.shopify.product && r.shopify.product.images.length, 3],
      ["shopify.currency", r.shopify && r.shopify.currency, "GBP"],
    ],
  },
  {
    name: "Не Shopify: shopify = null, без запросов",
    path: "/products/wool-coat",
    check: (r) => [["shopify", r.shopify, null]],
  },
];

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
let failed = 0;
for (const c of cases) {
  const tab = await browser.newPage();
  await tab.goto(origin + c.path);
  const result = await tab.evaluate(script);
  await tab.close();
  const bad = c.check(result).filter(([, got, want]) => !eq(got, want));
  if (bad.length) failed++;
  console.log(`${bad.length ? "FAIL" : "ok  "}  ${c.name}`);
  for (const [field, got, want] of bad) {
    console.log(`        ${field}: получено ${JSON.stringify(got)}, ожидалось ${JSON.stringify(want)}`);
  }
}
await browser.close();
server.close();
console.log(failed ? `\n${failed} из ${cases.length} не прошли` : `\nВсе ${cases.length} проверок прошли`);
process.exit(failed ? 1 : 0);
