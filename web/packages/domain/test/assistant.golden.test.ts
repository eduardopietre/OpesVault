/**
 * Parity with scripts/golden/cases_assistant.py: the tool lists (MCP and Ollama JSON Schemas), the
 * arguments the registry accepts or refuses (the exact message the model gets back), every read as
 * the text the model receives, every edit prepared and applied on a fresh copy, and scripted
 * conversations through `receive`/`resolve`.
 */
import { describe, expect, it } from "vitest";

import type { ModelTurn, ToolCall } from "../src/ai/ollama.ts";
import {
  Conversation,
  MAX_ATTEMPTS,
  MAX_MESSAGES,
  MAX_STEPS,
  again,
  type Pending,
} from "../src/assistant/conversation.ts";
import { ToolError, ToolKind, resultText } from "../src/assistant/tools.ts";
import { Ledger, type LedgerRecord } from "../src/domain/ledger.ts";
import * as tags from "../src/domain/tags.ts";
import { Dec } from "../src/lib/dec.ts";
import type { IsoDate } from "../src/lib/dates.ts";
import { cmpStr } from "../src/lib/text.ts";
import { items } from "../src/importing/store.ts";
import { golden } from "./golden.ts";

const ORIGIN = "ollama:m:a1";
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

type Json = unknown;
interface Outcome {
  ok?: Json;
  error?: string;
  crash?: boolean;
  text?: string | null;
  rotulo?: string;
  link?: Json;
  prepared?: { tool: string; summary: string; details: string[] };
  untouched?: boolean;
  applied?: Json;
  state?: { added: Json[]; removed: Json[] };
}
interface File {
  today: IsoDate;
  records: LedgerRecord[];
  schemas: { mcp: Json[]; ollama: Json[]; kinds: Record<string, string>; edit_descriptions_mention_approval: boolean };
  constants: { max_attempts: number; max_steps: number; max_messages: number };
  parse: { tool: string; args: Json; result: Outcome }[];
  reads: { tool: string; args: Record<string, Json>; result: Outcome }[];
  edits: { tool: string; args: Record<string, Json>; apply: boolean; result: Outcome }[];
  conversations: {
    name: string;
    brief: boolean;
    steps: Record<string, unknown>[];
    results: Record<string, unknown>[];
  }[];
}
const data = golden<File>("assistant");

// ── JSON as the generator wrote it ──

function dec(value: Json): Json {
  if (Array.isArray(value)) return value.map(dec);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, Json>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === "$dec") return Dec.parse(record["$dec"] as string);
    if (keys.length === 1 && keys[0] === "$big") return BigInt(record["$big"] as string);
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, dec(v)]));
  }
  return value;
}

function enc(value: unknown): Json {
  if (value instanceof Dec) return { $dec: value.toString() };
  if (typeof value === "bigint") return { $big: value.toString() };
  if (typeof value === "number" && Number.isInteger(value) && Math.abs(value) > 2 ** 53) return { $big: String(value) };
  if (Array.isArray(value)) return value.map(enc);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, enc(v)]));
  return value;
}

function ledgerOf(records: LedgerRecord[]): Ledger {
  return Ledger.fromRecords(records);
}

function resolveRefs(ledger: Ledger, value: Json): Json {
  if (typeof value === "string" && value.startsWith("@op:")) {
    const description = value.slice(4);
    const op = [...ledger.operations.values()].find((o) => o.description === description)!;
    return op.id.replaceAll("-", "").slice(0, 8);
  }
  if (typeof value === "string" && value.startsWith("@item:")) {
    const id = [...items(ledger).keys()][Number(value.slice(6))]!;
    return id.replaceAll("-", "").slice(0, 8);
  }
  if (value instanceof Dec) return value;
  if (Array.isArray(value)) return value.map((v) => resolveRefs(ledger, v));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(ledger, v)]));
  return value;
}

// ── record states ──

function knownIds(records: readonly LedgerRecord[]): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string") for (const m of v.matchAll(UUID_IN_TEXT)) out.add(m[0]);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(visit);
  };
  for (const r of records) {
    out.add(r.id);
    visit(r.payload);
  }
  return out;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort(cmpStr);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stateOf(ledger: Ledger, known: ReadonlySet<string>): Json[] {
  const norm = (v: unknown): unknown => {
    if (typeof v === "string")
      return INSTANT.test(v) ? "<instant>" : v.replace(UUID_IN_TEXT, (m) => (known.has(m) ? m : "<new>"));
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
    return v;
  };
  const rows = ledger.toRecords().map((r) => ({ kind: r.kind, payload: norm(JSON.parse(JSON.stringify(r.payload))) }));
  return rows.sort((a, b) => cmpStr(canonical(a), canonical(b)));
}

function delta(after: Json[], before: Json[]): { added: Json[]; removed: Json[] } {
  const count = (rows: Json[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(canonical(r), (m.get(canonical(r)) ?? 0) + 1);
    return m;
  };
  const a = count(after);
  const b = count(before);
  const side = (x: Map<string, number>, y: Map<string, number>) =>
    [...x]
      .flatMap(([k, n]) => Array.from({ length: Math.max(0, n - (y.get(k) ?? 0)) }, () => k))
      .sort(cmpStr)
      .map((k) => JSON.parse(k) as Json);
  return { added: side(a, b), removed: side(b, a) };
}

// ── the tests ──

describe("assistant tools", () => {
  it("are described as MCP and Ollama describe them", () => {
    const registry = new Conversation().registry;
    expect(registry.mcpList()).toEqual(data.schemas.mcp);
    expect(registry.ollamaList()).toEqual(data.schemas.ollama);
    expect(Object.fromEntries([...registry.tools.values()].map((t) => [t.name, t.kind]))).toEqual(data.schemas.kinds);
    expect(
      [...registry.tools.values()]
        .filter((t) => t.kind === ToolKind.EDIT)
        .every((t) => t.description.includes("aprovação")),
    ).toBe(data.schemas.edit_descriptions_mention_approval);
    expect({ max_attempts: MAX_ATTEMPTS, max_steps: MAX_STEPS, max_messages: MAX_MESSAGES }).toEqual(data.constants);
  });

  it.each(data.parse.map((c, i) => [i, c] as const))("parses arguments case %i", (_i, c) => {
    const registry = new Conversation().registry;
    let result: Outcome;
    try {
      const [, args] = registry.parse(c.tool, dec(c.args));
      result = { ok: enc(args) };
    } catch (error) {
      result = error instanceof ToolError ? { error: error.message } : { crash: true };
    }
    expect(result, `${c.tool} ${JSON.stringify(c.args)}`).toEqual(c.result);
  });

  const base = ledgerOf(data.records);
  it.each(data.reads.map((c, i) => [i, c] as const))("reads case %i", (_i, c) => {
    const registry = new Conversation().registry;
    let result: Outcome;
    try {
      const [tool, args] = registry.parse(c.tool, dec(resolveRefs(base, c.args)));
      const out = tool.run!(base, args, { today: data.today });
      if (c.tool === "show_in_ledger") {
        const shown = out as { rotulo: string; link: unknown[] };
        result = { text: null, rotulo: shown.rotulo, link: shown.link };
      } else result = { text: resultText(out) };
    } catch (error) {
      result = error instanceof ToolError ? { error: error.message } : { crash: true };
    }
    expect(result, `${c.tool} ${JSON.stringify(c.args)}`).toEqual(c.result);
  });

  it.each(data.edits.map((c, i) => [i, c] as const))("prepares and applies edit case %i", (_i, c) => {
    const ledger = ledgerOf(data.records);
    const known = knownIds(data.records);
    const registry = new Conversation().registry;
    const before = ledger.changeCount;
    const result: Outcome = {};
    let prepared;
    try {
      const [tool, args] = registry.parse(c.tool, dec(resolveRefs(ledger, c.args)));
      prepared = tool.prepare!(ledger, args, ORIGIN, { today: data.today });
    } catch (error) {
      const failed = error instanceof ToolError ? { error: error.message } : { crash: true };
      expect(failed, `${c.tool} ${JSON.stringify(c.args)}`).toEqual(c.result);
      return;
    }
    result.prepared = { tool: prepared.tool, summary: prepared.summary, details: [...prepared.details] };
    result.untouched = ledger.changeCount === before;
    if (c.apply) {
      try {
        const applied = enc(prepared.apply()) as Record<string, unknown>;
        if (typeof applied["id"] === "string") {
          expect(applied["id"]).toMatch(/^[0-9a-f]{8}$/);
          applied["id"] = "<id>";
        }
        result.applied = applied;
      } catch (error) {
        result.applied = error instanceof ToolError ? { error: error.message } : { crash: true };
      }
      result.state = delta(stateOf(ledger, known), stateOf(ledgerOf(data.records), known));
    }
    expect(result, `${c.tool} ${JSON.stringify(c.args)}`).toEqual(c.result);
  });
});

// ── conversations ──

function turnOf(calls: [string, unknown][], content: string): ModelTurn {
  const raw = {
    role: "assistant",
    content,
    tool_calls: calls.map(([name, args]) => ({ function: { name, arguments: args } })),
  };
  return {
    content,
    tool_calls: calls.map(([name, args]): ToolCall => ({ name, arguments: args as ToolCall["arguments"] })),
    raw: raw as unknown as ModelTurn["raw"],
  };
}

function stepJson(step: ReturnType<Conversation["receive"]>): Json {
  return {
    answer: step.answer,
    activity: step.activity,
    pending: step.pending.map((p) => [p.tool, p.edit.summary, [...p.edit.details]]),
    links: step.links.map(([label, link]) => [label, link]),
    stop: step.stop,
    again: again(step),
  };
}

describe("assistant conversations replayed from the desktop", () => {
  for (const script of data.conversations) {
    it(script.name, () => {
      const ledger = ledgerOf(data.records);
      const known = knownIds(data.records);
      const conversation = new Conversation(null, () => data.today);
      let pendings: Pending[] = [];
      script.steps.forEach((step, n) => {
        const entry: Record<string, unknown> = {};
        const label = `${script.name} step ${n} (${String(step["op"])})`;
        switch (step["op"]) {
          case "ask":
            conversation.ask(step["text"] as string);
            break;
          case "reset":
            conversation.reset();
            break;
          case "turn": {
            const calls = (step["calls"] as [string, Json][]).map(
              ([name, args]) =>
                [name, typeof args === "string" ? args : resolveRefs(ledger, dec(args))] as [string, unknown],
            );
            const result = conversation.receive(
              turnOf(calls, (step["content"] as string | undefined) ?? ""),
              ledger,
              ORIGIN,
            );
            entry["step"] = stepJson(result);
            pendings = [...result.pending];
            break;
          }
          case "resolve":
            entry["line"] = conversation.resolve(pendings[step["index"] as number]!, step["approved"] as boolean);
            break;
          case "mutate": {
            const cancel = step["cancel"] as string | undefined;
            if (cancel !== undefined) {
              const op = [...ledger.operations.values()].find((o) => o.description === cancel)!;
              ledger.cancelOperation(op.id, "mudou");
            }
            const tag = step["tag"] as [string, string] | undefined;
            if (tag !== undefined) {
              const op = [...ledger.operations.values()].find((o) => o.description === tag[0])!;
              tags.addTag(ledger, [op.id], tag[1]);
            }
            break;
          }
        }
        const messages = conversation.messages;
        entry["messages"] = script.brief ? [messages.length, enc(messages[0]), enc(messages.at(-1))] : enc(messages);
        entry["counters"] = [conversation.invalid, conversation.steps];
        entry["ledger_changes"] = ledger.changeCount;
        if (n === script.steps.length - 1) {
          if (script.brief) entry["all_messages"] = enc(messages);
          entry["state"] = delta(stateOf(ledger, known), stateOf(ledgerOf(data.records), known));
        }
        expect(entry, label).toEqual(script.results[n]);
      });
    });
  }
});
