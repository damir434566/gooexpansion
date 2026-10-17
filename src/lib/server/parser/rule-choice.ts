/**
 * The admin's rule against a list from a store: which entries to keep.
 *
 * The extension's whole-store run asks this twice over: which of the store's
 * menu categories to walk (`pick-categories.ts`) and, inside them, which
 * pieces to open (`pick-pieces.ts`). Both are the same question — a rule in
 * the admin's words, a list of labels and addresses, an answer by number —
 * asked of the model the AI check uses, with its key. Only what the model is
 * told, and how big a call is, differ.
 *
 * The answer is strict JSON: every number goes in one of the named lists.
 * A number the model does not place, or places both in "drop" and in a list
 * that keeps, is kept: an entry kept by mistake costs time, one dropped by
 * mistake loses pieces. The store's text is passed as data, never as
 * instructions.
 */
import OpenAI from "openai";
import { CHECK_MODELS, type CheckModel } from "@/lib/server/catalogue-check/ai";

/** Longest rule the admin can send. */
export const MAX_RULE = 500;
const MAX_LABEL = 120;
const MAX_PATH = 200;

export interface RuleItem {
  url: string;
  label: string;
}

/** The part of an OpenAI client this uses, so a test can hand in its own. */
export interface ChatClient {
  chat: {
    completions: {
      create(body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming): Promise<OpenAI.Chat.ChatCompletion>;
    };
  };
}

export interface RuleAnswer {
  /** Positions kept, in order: every list but "drop", and whatever the model left unplaced. */
  keep: number[];
  /** Positions left out. */
  drop: number[];
  /** Positions per list the model was given, "drop" aside, after the rules above. */
  lists: Record<string, number[]>;
  model: CheckModel;
  costUsd: number;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** An entry as the model sees it: its number, its label quoted, its path. */
function line(n: number, item: RuleItem): string {
  let path = item.url;
  try {
    const u = new URL(item.url);
    path = `${u.pathname}${u.search}`;
  } catch {
    /* sent as given */
  }
  const label = item.label.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
  return `${n}. ${JSON.stringify(label)} ${path.slice(0, MAX_PATH)}`;
}

function cost(model: CheckModel, usage: OpenAI.CompletionUsage | undefined): number {
  const price = CHECK_MODELS[model];
  const input = usage?.prompt_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  return ((input - cached) * price.input + cached * price.cached + output * price.output) / 1_000_000;
}

/** Run `jobs` with at most `width` going at once, answers in job order. */
async function inParallel<T>(jobs: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out = new Array<T>(jobs.length);
  let next = 0;
  const lane = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, lane));
  return out;
}

/**
 * Put `items` to the model against `rule`, `perCall` at a time, `width` calls
 * at once. `lists` names the lists of the answer; "drop" is the one that
 * leaves an entry out. Throws when any call fails: a partial answer is not
 * one to act on.
 */
export async function chooseByRule(input: {
  system: string;
  schemaName: string;
  lists: readonly string[];
  heading: string;
  rule: string;
  store: string;
  items: RuleItem[];
  perCall: number;
  width: number;
  model: CheckModel;
  apiKey?: string;
  client?: ChatClient;
}): Promise<RuleAnswer> {
  const rule = input.rule.trim().slice(0, MAX_RULE);
  const client: ChatClient = input.client ?? new OpenAI({ apiKey: input.apiKey, timeout: 45_000, maxRetries: 1 });
  const keeping = input.lists.filter((l) => l !== "drop");
  const schema = {
    type: "object",
    additionalProperties: false,
    required: [...input.lists],
    properties: Object.fromEntries(input.lists.map((l) => [l, { type: "array", items: { type: "integer" } }])),
  };

  const chunks: number[][] = [];
  for (let i = 0; i < input.items.length; i += input.perCall) {
    chunks.push(input.items.slice(i, i + input.perCall).map((_, j) => i + j));
  }

  const answers = await inParallel(
    chunks.map((numbers) => async () => {
      const res = await client.chat.completions.create({
        model: input.model,
        temperature: 0,
        max_completion_tokens: 3_000,
        response_format: { type: "json_schema", json_schema: { name: input.schemaName, strict: true, schema } },
        messages: [
          { role: "system", content: input.system },
          {
            role: "user",
            content: `RULE: ${JSON.stringify(rule)}\nSTORE: ${input.store}\n\n${input.heading}:\n${numbers
              .map((n) => line(n, input.items[n]))
              .join("\n")}`,
          },
        ],
      });
      const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
      const asked = new Set(numbers);
      const placed = (name: string) =>
        new Set(
          (Array.isArray(parsed[name]) ? (parsed[name] as unknown[]) : []).filter(
            (n): n is number => Number.isInteger(n) && asked.has(n as number),
          ),
        );
      const lists = Object.fromEntries(keeping.map((l) => [l, placed(l)]));
      const drop = placed("drop");
      // Named in "drop" and in a list that keeps: kept.
      for (const l of keeping) for (const n of lists[l]) drop.delete(n);
      return { drop, lists, costUsd: cost(input.model, res.usage) };
    }),
    input.width,
  );

  const dropped = new Set<number>();
  const lists: Record<string, number[]> = Object.fromEntries(keeping.map((l) => [l, [] as number[]]));
  let costUsd = 0;
  for (const a of answers) {
    for (const n of a.drop) dropped.add(n);
    for (const l of keeping) for (const n of a.lists[l]) lists[l].push(n);
    costUsd += a.costUsd;
  }
  for (const l of keeping) lists[l].sort((x, y) => x - y);
  const keep: number[] = [];
  const drop: number[] = [];
  for (let n = 0; n < input.items.length; n++) (dropped.has(n) ? drop : keep).push(n);
  return { keep, drop, lists, model: input.model, costUsd };
}
