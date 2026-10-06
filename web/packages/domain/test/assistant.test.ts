/**
 * `tests/test_assistant.py` (everything but the Qt page): the local model with the app's tools. The
 * contract, decided by the user on 04/10/2026: reads run as the model asks and never change the
 * ledger; every change is prepared and described first and only runs after approval; an invalid
 * answer goes back to the model as an error and three in a row interrupt the question; money
 * arrives as Dec, never float; CPF/CNPJ never reach the model. Every answer comes from FakeOllama.
 *
 * Skipped (they drive `AssistantPage`, a screen of the desktop): the five "on screen" tests
 * (answer with tools and approval dialog, refusal on screen, three wrong answers on screen, a model
 * without tools explained on screen, "off and closed").
 */
import { beforeEach, describe, expect, it } from "vitest";

import { AiUnavailable, type ModelTurn, OllamaClient, type ToolCall, type Transport } from "../src/ai/ollama.ts";
import { Conversation, MAX_ATTEMPTS, MAX_STEPS, again } from "../src/assistant/conversation.ts";
import { EDITS } from "../src/assistant/edits.ts";
import { READS } from "../src/assistant/reads.ts";
import { ToolError, ToolKind } from "../src/assistant/tools.ts";
import { demoSession } from "../src/demo.ts";
import * as budget from "../src/domain/budget.ts";
import { Dec } from "../src/lib/dec.ts";
import * as merchants from "../src/domain/merchants.ts";
import * as queries from "../src/domain/queries.ts";
import * as tags from "../src/domain/tags.ts";
import { type IsoDate, makeDate, ym } from "../src/lib/dates.ts";
import * as rules from "../src/importing/rules.ts";
import * as taxRecords from "../src/tax/records.ts";
import { TaxSubject } from "../src/tax/model.ts";
import { FakeOllama } from "./fake_ollama.ts";
import { category, family, type Family } from "./fixtures.ts";
import { extractor } from "./importing_helpers.ts";

const ORIGIN = "ollama:m:a1";
const TODAY = "2026-10-05" as IsoDate;

function make(): Conversation {
  return new Conversation(null, () => TODAY);
}

function fam(): Family {
  const f = family();
  f.ledger.recordOpeningBalance(f.bank, "5000.00", makeDate(2026, 1, 1));
  return f;
}

function turn(calls: [string, unknown][], content = ""): ModelTurn {
  return {
    content,
    tool_calls: calls.map(([name, args]): ToolCall => ({ name, arguments: args as ToolCall["arguments"] })),
    raw: {
      role: "assistant",
      content,
      tool_calls: calls.map(([name, args]) => ({ function: { name, arguments: args } })),
    } as unknown as ModelTurn["raw"],
  };
}

const idOf = (op: { id: string }) => op.id.replaceAll("-", "").slice(0, 8);
const lastContent = (c: Conversation) => String(c.messages.at(-1)!["content"]);

describe("the tools", () => {
  it("are described as MCP describes them", () => {
    const c = make();
    const listed = c.registry.mcpList();
    expect(listed).toHaveLength(READS.length + EDITS.length);
    for (const tool of listed) {
      expect(Object.keys(tool).sort()).toEqual(["description", "inputSchema", "name"]);
      const schema = tool["inputSchema"] as Record<string, unknown>;
      expect(schema["type"]).toBe("object");
      expect(schema["additionalProperties"]).toBe(false);
    }
    for (const [name, description] of EDITS) expect(description, name).toContain("aprovação");
    expect(c.tools().every((t) => t["type"] === "function")).toBe(true);
  });

  it("every read leaves the ledger as it was", async () => {
    const ledger = (await demoSession({ today: TODAY, extractor })).ledger;
    const registry = make().registry;
    const before = ledger.changeCount;
    const arguments_: Record<string, Record<string, unknown>> = {
      spending_by_category: { start: "2026-01", end: "2026-03" },
      merchant_totals: { start: "2026-03" },
      get_operation: { id: [...ledger.operations.keys()][0]!.replaceAll("-", "").slice(0, 8) },
      show_in_ledger: { account: "Alimentação", start: "2026-03-01", end: "2026-03-31" },
    };
    for (const tool of registry.tools.values()) {
      if (tool.kind !== ToolKind.READ) continue;
      const [, parsed] = registry.parse(tool.name, arguments_[tool.name] ?? {});
      const data = tool.run!(ledger, parsed, { today: TODAY });
      JSON.stringify(data, (_k, v: unknown) => (v instanceof Dec ? v.toString() : v)); // plain data
    }
    expect(ledger.changeCount).toBe(before);
  });

  it("never let CPF and CNPJ reach the model", () => {
    const f = fam();
    taxRecords.setMemberInfo(f.ledger, f.ana, { cpf: "529.982.247-25", birth_date: null, declared_by: null }, TODAY);
    taxRecords.setIdentity(f.ledger, TaxSubject.CATEGORY, f.salary, "11.222.333/0001-81", "Empresa");
    f.ledger.recordIncome(f.bank, f.salary, "4000.00", makeDate(2026, 2, 5), "SALARIO");
    const c = make();
    c.ask("tudo");
    for (const tool of c.registry.tools.values()) {
      if (tool.kind !== ToolKind.READ || ["spending_by_category", "merchant_totals"].includes(tool.name)) continue;
      let args: Record<string, unknown> = {};
      if (tool.name === "get_operation") args = { id: idOf([...f.ledger.operations.values()][0]!) };
      if (tool.name === "show_in_ledger") args = { account: "Banco A" };
      c.receive(turn([[tool.name, args]]), f.ledger, ORIGIN);
    }
    const sent = JSON.stringify(c.request());
    expect(sent).not.toContain("Consultou"); // the transcript lines are for the user only
    for (const secret of ["52998224725", "529.982.247-25", "11222333000181", "11.222.333/0001-81"])
      expect(sent).not.toContain(secret);
  });
});

describe("edits", () => {
  it("are described first and run only when approved", () => {
    const f = fam();
    const op = f.ledger.recordExpense(f.bank, f.groceries, "87.40", makeDate(2026, 2, 3), "UBER *TRIP 123");
    const c = make();
    c.ask("os uber são transporte");
    const before = f.ledger.changeCount;
    const step = c.receive(
      turn([["reclassify_operations", { ids: [idOf(op)], category: "transporte", reason: "é corrida" }]]),
      f.ledger,
      ORIGIN,
    );
    const [pending] = step.pending;
    expect(pending!.edit.summary).toBe("Reclassificar 1 lançamento(s) para Transporte");
    expect(pending!.edit.details[0]).toContain("Alimentação → Transporte");
    expect(f.ledger.changeCount).toBe(before);
    expect(again(step)).toBe(true); // the model hears the result before answering
    expect(c.resolve(pending!, true).startsWith("Aplicado")).toBe(true);
    expect(queries.balance(f.ledger, category(f.ledger, "Transporte")).toString()).toBe("87.40");
    expect(f.ledger.historyOf(op.id).at(-1)!.reason).toBe(`é corrida (assistente, ${ORIGIN})`);
    expect(JSON.parse(lastContent(c))["resultado"]).toBe("aplicado");
  });

  it("a refused edit changes nothing and the model is told", () => {
    const f = fam();
    const c = make();
    c.ask("orçamento");
    const step = c.receive(
      turn([["set_budget", { month: "2026-03", category: "Lazer", amount: "300,00" }]]),
      f.ledger,
      ORIGIN,
    );
    const before = f.ledger.changeCount;
    expect(c.resolve(step.pending[0]!, false).startsWith("Você recusou")).toBe(true);
    expect(f.ledger.changeCount).toBe(before);
    expect(budget.lines(f.ledger).size).toBe(0);
    expect(lastContent(c)).toContain("recusado");
  });

  it("each tool prepares without changing and applies after approval", () => {
    const f = fam();
    const { ledger } = f;
    const op = ledger.recordExpense(f.bank, f.groceries, "50.00", makeDate(2026, 2, 1), "IFD*IFOOD.COM AGENCIA");
    const cases: [string, Record<string, unknown>, () => boolean][] = [
      ["tag_operations", { ids: [idOf(op)], tag: "Viagem" }, () => tags.tagsOf(ledger, op.id).join() === "Viagem"],
      [
        "name_merchant",
        { description: "IFD*IFOOD.COM AGENCIA", name: "iFood" },
        () => merchants.merchantOf(ledger, op.description) === "iFood",
      ],
      [
        "create_category_rule",
        { pattern: "ifood", category: "Lazer" },
        () => [...rules.rules(ledger).values()].some((r) => r.pattern === "IFOOD"),
      ],
      [
        "record_income",
        {
          account: "banco a",
          category: "Salário",
          amount: Dec.from("4000"),
          date: "2026-02-05",
          description: "Salário",
        },
        () => queries.balance(ledger, f.salary).toString() === "4000",
      ],
      [
        "record_expense",
        { account: "Banco A", category: "Saúde", amount: "R$ 1.234,56", date: "2026-02-06", description: "Exame" },
        () => queries.balance(ledger, category(ledger, "Saúde")).toString() === "1234.56",
      ],
      [
        "set_budget",
        { month: "2026-02", category: "Lazer", amount: "300" },
        () => budget.lineFor(ledger, category(ledger, "Lazer"), ym(2026, 2)) !== null,
      ],
    ];
    for (const [name, args, applied] of cases) {
      const c = make();
      c.ask(name);
      const before = ledger.changeCount;
      const [pending] = c.receive(turn([[name, args]]), ledger, ORIGIN).pending;
      expect(ledger.changeCount, name).toBe(before);
      expect(pending!.edit.summary, name).toBeTruthy();
      expect(c.resolve(pending!, true).startsWith("Aplicado"), name).toBe(true);
      expect(applied(), name).toBe(true);
    }
  });

  it("one that fails on apply is reported to the model", () => {
    const f = fam();
    const op = f.ledger.recordExpense(f.bank, f.groceries, "20.00", makeDate(2026, 2, 1), "PADARIA");
    const c = make();
    c.ask("x");
    const [pending] = c.receive(
      turn([["reclassify_operations", { ids: [idOf(op)], category: "Lazer", reason: "lanche" }]]),
      f.ledger,
      ORIGIN,
    ).pending;
    f.ledger.cancelOperation(op.id, "duplicado"); // changed after the proposal, before the approval
    const line = c.resolve(pending!, true);
    expect(line.startsWith("Não foi possível")).toBe(true);
    expect(lastContent(c)).toContain("erro");
  });
});

describe("wrong answers", () => {
  let f: Family;
  beforeEach(() => {
    f = fam();
  });

  const WRONG: [string, unknown, string][] = [
    ["apagar_tudo", {}, "Ferramenta desconhecida"],
    ["search_operations", { texto: "uber" }, "campo que não existe"],
    ["set_budget", { month: "2026-03", category: "Lazer" }, "amount: obrigatório"],
    ["set_budget", { month: "2026-03", category: "Lazer", amount: "0" }, "valor deve ser positivo"],
    ["set_budget", { month: "março", category: "Lazer", amount: "10" }, "AAAA-MM"],
    ["set_budget", { month: "2026-03", category: "Salário", amount: "10" }, "não é uma categoria de despesa"],
    ["set_budget", { month: "2026-03", category: "Lazer", amount: "10.001" }, "duas casas"],
    ["reclassify_operations", { ids: ["zz"], category: "Lazer", reason: "xxx" }, "id de lançamento"],
    [
      "record_expense",
      { account: "Banco A", category: "Inventada", amount: "1", date: "2026-01-02", description: "x" },
      "Não existe categoria",
    ],
    ["search_operations", "{não é json", "não são JSON"],
  ];

  it.each(WRONG)("go back to the model: %s", (tool, args, words) => {
    const c = make();
    c.ask("x");
    const before = f.ledger.changeCount;
    const step = c.receive(turn([[tool, args]]), f.ledger, ORIGIN);
    const error = JSON.parse(lastContent(c))["erro"] as string;
    expect(error).toContain(words);
    expect(again(step)).toBe(true);
    expect(step.pending).toHaveLength(0);
    expect(c.invalid).toBe(1);
    expect(f.ledger.changeCount).toBe(before);
  });

  it("a 0.5 amount is a valid budget: the float refusal is for JSON floats the model must send as text", () => {
    // The desktop test writes `amount: 0.5` (a Python float) and expects "valor ilegível"; over JSON a
    // fraction arrives as Dec, which is valid money (0.50), so the TS contract is "valor deve ser positivo"
    // for zero and a pending edit for 0.5.
    const c = make();
    c.ask("x");
    const step = c.receive(
      turn([["set_budget", { month: "2026-03", category: "Lazer", amount: Dec.parse("0.5") }]]),
      f.ledger,
      ORIGIN,
    );
    expect(step.pending).toHaveLength(1);
  });

  it("three in a row interrupt the question and a valid answer resets the count", () => {
    const c = make();
    c.ask("x");
    c.receive(turn([["nope", {}]]), f.ledger, ORIGIN);
    c.receive(turn([], ""), f.ledger, ORIGIN); // empty
    expect(c.invalid).toBe(2);
    c.receive(turn([["list_members", {}]]), f.ledger, ORIGIN); // a valid one
    expect(c.invalid).toBe(0);
    const steps = Array.from({ length: MAX_ATTEMPTS }, () =>
      c.receive(turn([], '{"name": "list_members", "arguments": {}}'), f.ledger, ORIGIN),
    );
    expect(steps.map((s) => s.stop !== null)).toEqual([...Array(MAX_ATTEMPTS - 1).fill(false), true]);
    const stop = steps.at(-1)!.stop!;
    expect(stop).toContain("3 vezes");
    expect(stop).toContain("texto");
    expect(lastContent(c)).toContain("Erro do aplicativo");
  });

  it("a question cannot loop forever", () => {
    const c = make();
    c.ask("x");
    for (let i = 0; i < MAX_STEPS - 1; i++)
      expect(c.receive(turn([["list_members", {}]]), f.ledger, ORIGIN).stop).toBeNull();
    const step = c.receive(turn([["list_members", {}]]), f.ledger, ORIGIN);
    expect(step.stop).toContain(String(MAX_STEPS));
  });

  it("ToolError is a plain message", () => {
    expect(new ToolError("x").message).toBe("x");
  });
});

describe("the client", () => {
  it("sends tool calls with exact money", async () => {
    const fake = new FakeOllama();
    fake.messages = [
      {
        content: "",
        tool_calls: [
          { function: { name: "set_budget", arguments: { month: "2026-03", category: "Lazer", amount: 300.1 } } },
        ],
      },
    ];
    const client = new OllamaClient("gemma4:12b", fake.transport);
    expect(await client.supportsTools()).toBe(true);
    const answer = await client.chatTools("sistema", [{ role: "user", content: "x" }], make().tools());
    const [call] = answer.tool_calls;
    expect(call!.name).toBe("set_budget");
    const args = call!.arguments as Record<string, unknown>;
    expect((args["amount"] as Dec).toString()).toBe("300.1");
    const sent = fake.received.at(-1)!;
    expect(sent["tools"]).toBeTruthy();
    expect(sent["think"]).toBe(false);
    expect(sent["stream"]).toBe(false);
    expect((sent["messages"] as unknown[])[0]).toEqual({ role: "system", content: "sistema" });
    fake.capabilities = ["completion"];
    expect(await client.supportsTools()).toBe(false);
    fake.capabilities = null;
    expect(await client.supportsTools()).toBeNull(); // an older server: not known
  });

  it("a model that refuses tools says what to do", async () => {
    const refusing: Transport = () =>
      Promise.resolve({ status: 400, text: () => Promise.resolve('{"error":"gemma does not support tools"}') });
    await expect(new OllamaClient("gemma", refusing).chatTools("s", [], [])).rejects.toThrow(AiUnavailable);
    await expect(new OllamaClient("gemma", refusing).chatTools("s", [], [])).rejects.toThrow(/não aceita ferramentas/);
  });
});
