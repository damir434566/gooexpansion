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
  "/products/wool-coat-gallery": ["text/html; charset=utf-8", page("gallery-noise.html")],
  "/products/mia-jacket-a": ["text/html; charset=utf-8", page("size-swatch-a.html")],
  "/products/mia-jacket-b": ["text/html; charset=utf-8", page("size-swatch-b.html")],
  "/products/aj4-bred": ["text/html; charset=utf-8", page("size-price-grid.html")],
  "/products/samba-og": ["text/html; charset=utf-8", page("size-price-inline.html")],
  "/products/basic-tee": ["text/html; charset=utf-8", page("price-european.html")],
  "/ua/shopping/women/gucci-horsebit-1955-shoulder-bag-item-19356833.aspx": ["text/html; charset=utf-8", page("ff-product.html")],
  "/ua/shopping/women/denied-item-19356833.aspx": ["text/html; charset=utf-8", page("bot-check.html")],
  "/ua/shopping/women/hold-item-19356833.aspx": ["text/html; charset=utf-8", page("press-hold.html")],
  "/sneakers/dunk-low-panda": ["text/html; charset=utf-8", page("goat.html")],
  "/sneakers/new-balance-550-white-green": ["text/html; charset=utf-8", page("goat-brand.html")],
  "/en-gb/men/product/balenciaga/black-venom-boots/18128871": ["text/html; charset=utf-8", page("ssense.html")],
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

cases.push(
  {
    name: "Размеры-свотчи с подписью «Size: XS» — не цвет",
    path: "/products/mia-jacket-a",
    check: (r) => [
      ["colorText", r.colorText, ""],
      ["размер среди надёжных кандидатов", (r.colorCandidates || []).filter((c) => ["data", "swatch", "label", "line"].includes(c.origin) && /^(?:xs|s|m|l|xl)$/i.test(c.value)).map((c) => c.value), []],
    ],
  },
  {
    name: "Классический сниппет swatch для размера — не цвет",
    path: "/products/mia-jacket-b",
    check: (r) => [
      ["colorText", r.colorText, ""],
      ["размер среди надёжных кандидатов", (r.colorCandidates || []).filter((c) => ["data", "swatch", "label", "line"].includes(c.origin) && /^(?:xs|s|m|l|xl)$/i.test(c.value)).map((c) => c.value), []],
    ],
  },
);

cases.push({
  name: "Фото: только галерея товара — без шапки, подвала, свотчей, иконок и «похожих»",
  path: "/products/wool-coat-gallery",
  check: (r) => {
    const names = (r.images || []).map((u) => u.split("/").pop());
    return [
      ["обе фото товара", ["wool-coat-front.jpg", "wool-coat-back.jpg"].every((n) => names.includes(n)), true],
      ["чужие и мебель страницы", names.filter((n) => /logo|swatch|visa|trench|long|badge/.test(n)), []],
    ];
  },
});

cases.push(
  {
    name: "Цена не размер: плитки «18 / $215» — цена товара из блока покупки, $199",
    path: "/products/aj4-bred",
    check: (r) => [["priceText", r.priceText, "$199"]],
  },
  {
    name: "Цена не размер: кнопка «18 $120» в одну строку — это $120",
    path: "/products/samba-og",
    check: (r) => [["priceText", r.priceText, "$120"]],
  },
  {
    name: "Настоящая цена 18 евро остаётся 18 евро, пробел-NBSP внутри цены не рвёт её",
    path: "/products/basic-tee",
    check: (r) => [["priceText", r.priceText.replace(/\u00a0/g, " "), "18,00 €"]],
  },
);

cases.push(
  {
    name: "Farfetch: только галерея вещи — без окна выбора страны, cookies, рассылки и «похожих»",
    path: "/ua/shopping/women/gucci-horsebit-1955-shoulder-bag-item-19356833.aspx",
    check: (r) => {
      const names = (r.images || []).map((u) => u.split("/").pop());
      return [
        ["все три фото вещи", ["19356833_42560043_1000.jpg", "19356833_42560044_1000.jpg", "19356833_42560051_1000.jpg"].every((n) => names.includes(n)), true],
        ["чужие и баннеры", names.filter((n) => !n.startsWith("19356833_")), []],
        ["не проверка, хотя в форме рассылки есть reCAPTCHA", r.botCheck || "", ""],
        ["адрес вкладки уходит с результатом", typeof r.url === "string" && r.url.endsWith("-item-19356833.aspx"), true],
      ];
    },
  },
  {
    name: "Заглушка Akamai «Access Denied» — не товар",
    path: "/ua/shopping/women/denied-item-19356833.aspx",
    check: (r) => [["botCheck", r.botCheck, "Access Denied"], ["html не отправляется", r.html, ""]],
  },
  {
    name: "PerimeterX «Press & Hold» — не товар",
    path: "/ua/shopping/women/hold-item-19356833.aspx",
    check: (r) => [["botCheck найден", !!r.botCheck, true], ["html не отправляется", r.html, ""]],
  },
);

cases.push(
  {
    name: "GOAT: бренд не из меню, «похожих» и подвала (было «Air Jordan» у каждой вещи)",
    path: "/sneakers/dunk-low-panda",
    check: (r) => [["brandText", r.brandText, ""]],
  },
  {
    name: "Бренд рядом с названием, в шапке самого товара (<header> внутри <article>)",
    path: "/sneakers/new-balance-550-white-green",
    check: (r) => [["brandText", r.brandText, "New Balance"]],
  },
);

cases.push({
  name: "SSENSE: адреса Cloudinary из srcset целиком, с запятыми внутри (было «…/images/b_white», «c_lpad»)",
  path: "/en-gb/men/product/balenciaga/black-venom-boots/18128871",
  check: (r) => {
    const images = r.images ?? [];
    const shots = [...new Set(images.map((u) => (u.match(/252342M223005_(\d)\//) ?? [])[1]).filter(Boolean))].sort();
    return [
      // Шаблон из JSON-LD уходит кандидатом как есть: заполняет его сервер (gallery.ts).
      ["каждый адрес — фото .jpg, без обрывков", images.filter((u) => !/\/252342M223005_\d\/balenciaga-black-venom-boots\.jpg$/.test(u) && !u.includes("/__IMAGE_PARAMS__/")), []],
      ["все три кадра", shots, ["1", "2", "3"]],
      ["2× из srcset целиком", images.some((u) => u.includes("/c_scale,h_680/f_auto,dpr_2.0/252342M223005_1/")), true],
      ["960w из srcset целиком", images.some((u) => u.includes("/b_white,g_center,f_auto,q_auto:best/252342M223005_3/")), true],
      ["не «похожие»", images.some((u) => u.includes("251342M237001")), false],
    ];
  },
});

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
