/**
 * Local AI parity (golden/ai.json, scripts/golden/cases_ai.py): the prompts character for character,
 * what the client sends and concludes for scripted Ollama answers, the name check, and learning and
 * planning over seeded ledgers loaded from the desktop's records.
 */
import { describe, expect, it } from "vitest";

import { Ledger, type LedgerRecord } from "../src/domain/ledger.ts";
import { AccountType } from "../src/domain/model.ts";
import { Dec } from "../src/lib/dec.ts";
import { AiUnavailable, OllamaClient, plausibleName, schema, type Transport } from "../src/ai/ollama.ts";
import * as prompts from "../src/ai/prompts.ts";
import * as ai from "../src/importing/ai_suggestions.ts";
import * as learning from "../src/importing/learning.ts";
import { golden } from "./golden.ts";

interface ClientCase {
  model: string;
  digest: string | null;
  answers: unknown[];
  call: string;
  args: Record<string, unknown>;
  calls: { path: string; payload: unknown }[];
  ok?: unknown;
  error?: string;
  message?: string;
  fatal?: boolean;
}

interface LearningCase {
  seed: number;
  records: LedgerRecord[];
  accounts: Record<string, string>;
  knowledge: Record<string, unknown>;
  suggest: { description: string; wanted: string; account: string | null; result: unknown }[];
  merchant_keys: [string, string, string][];
  proposals: unknown;
  proposals_2: unknown;
  contradictions: unknown;
  category_names: Record<string, unknown>;
  plan_description: [string, string, unknown][];
  plan_operations: { ids: string[]; plans: unknown };
  describe_source: [string, string | null][];
}

const data = golden<{
  prompts: {
    constants: Record<string, string>;
    category_request: { args: [string[], string[], string]; text: string }[];
    merchant_request: string;
    schema: unknown;
  };
  client: ClientCase[];
  names: [string, string, string | null][];
  learning: LearningCase[];
}>("ai");

describe("prompts", () => {
  it("keep the desktop's texts and versions", () => {
    const c = data.prompts.constants;
    expect(prompts.CATEGORY_VERSION).toBe(c["CATEGORY_VERSION"]);
    expect(prompts.MERCHANT_VERSION).toBe(c["MERCHANT_VERSION"]);
    expect(prompts.ASSISTANT_VERSION).toBe(c["ASSISTANT_VERSION"]);
    expect(prompts.CATEGORY_SYSTEM).toBe(c["CATEGORY_SYSTEM"]);
    expect(prompts.MERCHANT_SYSTEM).toBe(c["MERCHANT_SYSTEM"]);
    expect(prompts.ASSISTANT_SYSTEM).toBe(c["ASSISTANT_SYSTEM"]);
    for (const { args, text } of data.prompts.category_request) expect(prompts.categoryRequest(...args)).toBe(text);
    expect(prompts.merchantRequest("0: IFD*IFOOD")).toBe(data.prompts.merchant_request);
    expect(schema("suggestions", "category")).toEqual(data.prompts.schema);
  });
});

/** Python's `jsonable` of the results: Decimal as {"$dec": str}, big ints as numbers. */
function plain(value: unknown): unknown {
  if (value instanceof Dec) return { $dec: value.toString() };
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [k, plain(v)]));
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plain(v)]));
  return value;
}

function scripted(answers: unknown[], calls: { path: string; payload: unknown }[]): Transport {
  const queue = [...answers];
  return (url, init) => {
    calls.push({ path: url.replace(/^http:\/\/[^/]+/, ""), payload: init.body ? JSON.parse(init.body) : null });
    const answer = queue.length ? queue.shift() : { message: { role: "assistant", content: "" } };
    if (answer === "offline") return Promise.reject(new TypeError("fetch failed"));
    if (Array.isArray(answer) && answer[0] === "http")
      return Promise.resolve({ status: answer[1] as number, text: () => Promise.resolve(answer[2] as string) });
    // Integers past 2^53 were read from the golden file as doubles: send them back as integers.
    const raw = (JSON as unknown as { rawJSON: (t: string) => unknown }).rawJSON;
    const text =
      Array.isArray(answer) && answer[0] === "text"
        ? (answer[1] as string)
        : JSON.stringify(answer, (_k, v: unknown) =>
            typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v) ? raw(BigInt(v).toString()) : v,
          );
    return Promise.resolve({ status: 200, text: () => Promise.resolve(text) });
  };
}

async function runCase(c: ClientCase, transport: Transport): Promise<unknown> {
  const client = new OllamaClient(c.model, transport);
  client.digest = c.digest;
  const a = c.args as unknown as {
    descriptions: string[];
    categories: string[];
    examples?: [string, string][];
    system: string;
    messages: Record<string, unknown>[];
    tools: Record<string, unknown>[];
  };
  switch (c.call) {
    case "categories": {
      const run = await client.suggestCategories(a.descriptions, a.categories, a.examples ?? []);
      return {
        suggestions: run.suggestions.map((s) => [s.index, s.category, s.source]),
        failed: run.failed,
        cancelled: run.cancelled,
      };
    }
    case "names": {
      const run = await client.suggestNames(a.descriptions);
      return {
        suggestions: run.suggestions.map((s) => [s.index, s.name, s.source]),
        failed: run.failed,
        cancelled: run.cancelled,
      };
    }
    case "chat_tools": {
      const turn = await client.chatTools(a.system, a.messages, a.tools);
      return plain({
        content: turn.content,
        tool_calls: turn.tool_calls.map((t) => [t.name, t.arguments]),
        raw: turn.raw,
      });
    }
    case "server_info": {
      const info = await client.serverInfo();
      return { version: info.version, models: info.models, digests: Object.fromEntries(info.digests) };
    }
    case "check_model":
      await client.checkModel();
      return { digest: client.digest, source: client.source };
    case "placement": {
      const placed = await client.placement();
      return placed === null ? null : [placed.size, placed.vram, placed.gpuPercent];
    }
    case "supports_tools":
      return client.supportsTools();
  }
  throw new Error(c.call);
}

describe("the client against scripted answers", () => {
  for (const [n, c] of data.client.entries()) {
    it(`${n} ${c.call} (${c.model})`, async () => {
      const calls: { path: string; payload: unknown }[] = [];
      let outcome: Record<string, unknown>;
      try {
        outcome = { ok: plain(await runCase(c, scripted(c.answers, calls))) };
      } catch (error) {
        outcome =
          error instanceof AiUnavailable
            ? { error: "AiUnavailable", message: error.message, fatal: error.fatal }
            : { error: (error as Error).name };
      }
      expect(calls).toEqual(c.calls);
      const expected = { ...c } as Record<string, unknown>;
      for (const k of ["model", "digest", "answers", "call", "args", "calls"]) delete expected[k];
      expect(outcome).toEqual(plain(expected));
    });
  }
});

describe("names made of the description's own words", () => {
  it(`${data.names.length} pairs`, () => {
    for (const [description, name, kept] of data.names)
      expect(plausibleName(description, name), `${description} / ${name}`).toBe(kept);
  });
});

describe("learning and planning over seeded ledgers", () => {
  for (const c of data.learning) {
    it(`seed ${c.seed}`, () => {
      const ledger = Ledger.fromRecords(c.records);
      const knowledge = Object.fromEntries(
        [...learning.knowledge(ledger).values()].map((l) => [
          `${l.kind}|${l.key}`,
          l.choices.map((ch) => [ch.on, ch.category_id, ch.account_id, ch.text]),
        ]),
      );
      expect(knowledge).toEqual(c.knowledge);
      for (const s of c.suggest) {
        const kinds = s.wanted === "both" ? [AccountType.EXPENSE, AccountType.INCOME] : (s.wanted as AccountType);
        const found = learning.suggest(ledger, s.description, kinds, s.account);
        const result =
          found === null ? null : [found.key, found.category_id, found.agreeing, found.considered, found.source];
        expect(result, `${s.description} ${s.wanted} ${s.account}`).toEqual(s.result);
      }
      for (const [d, key, question] of c.merchant_keys) {
        expect(learning.merchantKey(d)).toBe(key);
        expect(ai.questionKey(d)).toBe(question);
      }
      expect(learning.proposals(ledger).map((p) => [p.pattern, p.category_id, p.count])).toEqual(c.proposals);
      expect(learning.proposals(ledger, 2).map((p) => [p.pattern, p.category_id, p.count])).toEqual(c.proposals_2);
      const contradictions = Object.fromEntries(
        [...learning.contradictions(ledger)].map(([k, v]) => [
          k,
          [v.rule_id, v.matched, v.contrary, v.usual_category_id],
        ]),
      );
      expect(contradictions).toEqual(c.contradictions);
      for (const t of [AccountType.EXPENSE, AccountType.INCOME])
        expect([...ai.categoryNames(ledger, t)]).toEqual(c.category_names[t]);
      for (const [d, t, expected] of c.plan_description) {
        const p = ai.planDescription(ledger, d, t as AccountType);
        expect(p === null ? null : [[...p.descriptions], p.examples.map((e) => [...e])], d).toEqual(expected);
      }
      const plans = ai.planOperations(ledger, c.plan_operations.ids);
      expect(
        plans.map((p) => [[...p.descriptions], p.item_ids.map((g) => [...g]), p.examples.map((e) => [...e])]),
      ).toEqual(c.plan_operations.plans);
      for (const [s, described] of c.describe_source) expect(learning.describeSource(s)).toBe(described);
    });
  }
});
