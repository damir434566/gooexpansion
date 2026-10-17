// Builds roadmap.html (the page for the person) from roadmap.md (the working
// copy), so the two never drift apart. Run after every change to roadmap.md:
//
//   node docs/roadmap/build.mjs
//
// The page carries no file names: stages say what the person gets, tasks say
// what is done in plain words, and whatever waits on them is set apart.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(here, "roadmap.md"), "utf8");

const STATUS = {
  Planned: { label: "в плане", tone: "plan" },
  "In Progress": { label: "в работе", tone: "work" },
  Testing: { label: "проверяется", tone: "work" },
  Done: { label: "готово", tone: "done" },
  Blocked: { label: "ждёт решения", tone: "block" },
};

const title = (md.match(/^# (.+)$/m) || [, "Роадмап"])[1].replace(/^Роадмап:\s*/, "");
const updated = (md.match(/Обновлено:\s*([0-9-]+)/) || [, ""])[1];

const stages = [];
let stage = null;
let task = null;
for (const line of md.split("\n")) {
  const s = line.match(/^## (Этап [A-ZА-Я])\.\s*(.+?)\s+—\s+(.+)$/);
  if (s) {
    stage = { code: s[1], name: s[2], gets: s[3], tasks: [] };
    stages.push(stage);
    task = null;
    continue;
  }
  const t = line.match(/^### (R-\d+)\s*·\s*(.+)$/);
  if (t && stage) {
    task = { id: t[1], name: t[2], fields: {} };
    stage.tasks.push(task);
    continue;
  }
  const f = line.match(/^- ([^:]+):\s*(.*)$/);
  if (f && task) task.fields[f[1].trim()] = f[2].trim();
}

const tasks = stages.flatMap((s) => s.tasks);
const done = tasks.filter((t) => t.fields["Статус"] === "Done").length;
const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
const waiting = tasks.filter((t) => t.fields["Нужно от вас"]);
const now = tasks.find((t) => ["In Progress", "Testing"].includes(t.fields["Статус"]));

const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const status = (t) => STATUS[t.fields["Статус"]] || STATUS.Planned;
const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

const stageHtml = stages
  .map((s) => {
    const n = s.tasks.filter((t) => t.fields["Статус"] === "Done").length;
    const state = n === s.tasks.length ? "done" : s.tasks.some((t) => t.fields["Статус"] !== "Planned") ? "work" : "plan";
    const items = s.tasks
      .map((t) => {
        const st = status(t);
        return `<li class="task ${st.tone}">
          <span class="id">${esc(t.id)}</span>
          <span class="what"><strong>${esc(t.name)}</strong><span class="why">${esc(t.fields["Зачем"] || "")}</span></span>
          <span class="pill ${st.tone}">${esc(st.label)}</span>
        </li>`;
      })
      .join("");
    return `<section class="stage ${state}">
      <div class="stage-head">
        <span class="mark" aria-hidden="true"></span>
        <div class="stage-text">
          <p class="code">${esc(s.code)} · ${n} из ${s.tasks.length}</p>
          <h2>${esc(s.name)}</h2>
          <p class="gets"><span>Что вы получите:</span> ${esc(s.gets)}</p>
        </div>
      </div>
      <ol class="tasks">${items}</ol>
    </section>`;
  })
  .join("");

const waitingHtml = waiting.length
  ? `<section class="waiting">
      <h2>Ждёт вашего решения</h2>
      <ul>${waiting
        .map((t) => `<li><span class="id">${esc(t.id)}</span> ${esc(t.fields["Нужно от вас"])}</li>`)
        .join("")}</ul>
    </section>`
  : "";

const html = `<title>Роадмап Goo Collect</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
  /* Layout: one column of milestones on a rail; progress first, decisions set apart. */
  :root {
    --page: #f4f4f1;
    --card: #ffffff;
    --ink: #171717;
    --soft: #5f5f5a;
    --line: #dededa;
    --done: #0f7a55;
    --work: #2155c4;
    --block: #a6560d;
    --plan: #8a8a84;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --page: #0f0f0f; --card: #171717; --ink: #ededea; --soft: #a5a59f; --line: #2b2b29;
      --done: #4fd1a1; --work: #7ea6ff; --block: #f0a75a; --plan: #77776f; color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --page: #0f0f0f; --card: #171717; --ink: #ededea; --soft: #a5a59f; --line: #2b2b29;
    --done: #4fd1a1; --work: #7ea6ff; --block: #f0a75a; --plan: #77776f; color-scheme: dark;
  }
  body {
    background: var(--page); color: var(--ink); font: 15px/1.55 var(--sans);
    padding-left: max(16px, env(safe-area-inset-left, 0px));
    padding-right: max(16px, env(safe-area-inset-right, 0px));
    padding-block: 32px 64px;
  }
  main { max-width: 760px; margin: 0 auto; display: grid; gap: 28px; }
  header { display: grid; gap: 10px; }
  header .eyebrow { margin: 0; font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--soft); }
  header h1 { margin: 0; font-size: 28px; font-weight: 650; letter-spacing: -0.01em; text-wrap: balance; }
  .progress { display: grid; gap: 8px; }
  .progress .nums { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; font-variant-numeric: tabular-nums; }
  .progress .big { font-size: 34px; font-weight: 650; }
  .progress .of { color: var(--soft); }
  .track { height: 8px; border-radius: 999px; background: var(--line); overflow: hidden; }
  .track > div { height: 100%; background: var(--done); width: ${pct}%; }
  .now { margin: 0; color: var(--soft); }
  .now strong { color: var(--ink); font-weight: 600; }

  .waiting { background: var(--card); border: 1px solid var(--block); border-radius: 12px; padding: 16px 18px; display: grid; gap: 8px; }
  .waiting h2 { margin: 0; font-size: 15px; color: var(--block); letter-spacing: 0.02em; }
  .waiting ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; }

  .stages { display: grid; gap: 22px; }
  .stage { display: grid; gap: 12px; }
  .stage-head { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 12px; align-items: start; }
  .mark { width: 16px; height: 16px; margin-top: 4px; border-radius: 50%; border: 2px solid var(--plan); background: var(--page); }
  .stage.work .mark { border-color: var(--work); background: var(--work); box-shadow: 0 0 0 4px color-mix(in srgb, var(--work) 20%, transparent); }
  .stage.done .mark { border-color: var(--done); background: var(--done); }
  .stage-text { min-width: 0; display: grid; gap: 4px; }
  .code { margin: 0; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--soft); font-variant-numeric: tabular-nums; }
  .stage h2 { margin: 0; font-size: 19px; font-weight: 650; text-wrap: balance; }
  .gets { margin: 0; }
  .gets span { color: var(--soft); }
  .tasks { list-style: none; margin: 0 0 0 34px; padding: 0; display: grid; gap: 8px; }
  .task {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: start;
    background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px;
  }
  .task .id { font-size: 12px; color: var(--soft); font-variant-numeric: tabular-nums; padding-top: 2px; }
  .task .what { min-width: 0; display: grid; gap: 2px; }
  .task .what strong { font-weight: 600; }
  .task .why { color: var(--soft); font-size: 13px; }
  .pill { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
  .pill.plan { color: var(--plan); }
  .pill.work { color: var(--work); }
  .pill.done { color: var(--done); }
  .pill.block { color: var(--block); }
  footer { color: var(--soft); font-size: 13px; }
  @media (max-width: 520px) {
    .tasks { margin-left: 0; }
    .task { grid-template-columns: minmax(0, 1fr) auto; }
    .task .id { grid-column: 1 / -1; padding: 0; }
  }
</style>
<main>
  <header>
    <p class="eyebrow">Роадмап · обновлено ${esc(updated)}</p>
    <h1>${esc(title)}</h1>
    <div class="progress">
      <div class="nums"><span class="big">${pct}%</span><span class="of">готово ${done} из ${tasks.length} ${plural(tasks.length, "задачи", "задач", "задач")}</span></div>
      <div class="track" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div></div></div>
      <p class="now">${now ? `Сейчас: <strong>${esc(now.id)} · ${esc(now.name)}</strong>` : done === tasks.length ? "Всё готово." : "Следующая задача ждёт одобрения роадмапа."}</p>
    </div>
  </header>
  ${waitingHtml}
  <div class="stages">${stageHtml}</div>
  <footer>Страница собирается из рабочего роадмапа и обновляется после каждой задачи.</footer>
</main>
`;

writeFileSync(join(here, "roadmap.html"), html);
// The working copy's own progress line, kept in step with its tasks.
const counted = md.replace(/Готово: \d+ из \d+ \(\d+ %\)/, `Готово: ${done} из ${tasks.length} (${pct} %)`);
if (counted !== md) writeFileSync(join(here, "roadmap.md"), counted);
console.log(`roadmap.html: ${done}/${tasks.length} (${pct}%), ${stages.length} stages, ${waiting.length} waiting`);
