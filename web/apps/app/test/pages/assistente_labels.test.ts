/** The pure parts of the Assistente: words for the tools, Livro refs, the CPF/CNPJ guard, the stoppable transport. */
import { Dec, type IsoDate } from "@opesvault/domain";
import { describe, expect, it } from "vitest";
import { plainNumbers, stoppable } from "../../src/pages/assistente/chat.ts";
import {
  TOOL_LABELS,
  callArguments,
  hasTaxId,
  livroRef,
  parseActivity,
  sanitize,
  toolLabel,
} from "../../src/pages/assistente/labels.ts";
import { parseReveal } from "../../src/pages/livro/rows.ts";

describe("tools in plain words", () => {
  it("names every tool of the registry", async () => {
    const { assistant } = await import("@opesvault/domain");
    const names = [...assistant.conversation.defaultRegistry().tools.keys()];
    for (const name of names) expect(TOOL_LABELS[name], name).toBeTruthy();
    expect(toolLabel("outra")).toBe("outra");
  });

  it("reads the arguments of a call, leaving out what is empty", () => {
    expect(callArguments({ text: "uber", start: "2026-09-01", end: "", limit: 5, member: null })).toEqual([
      { label: "texto", value: "uber" },
      { label: "início", value: "01/09/2026" },
      { label: "limite", value: "5" },
    ]);
    expect(callArguments({ amount: Dec.parse("87.40"), remove: true, ids: ["a1", "b2"] })).toEqual([
      { label: "valor", value: "87.40" },
      { label: "tirar", value: "sim" },
      { label: "lançamentos", value: "a1, b2" },
    ]);
    expect(callArguments('{"tag":"Viagem"}')).toEqual([{ label: "marcador", value: "Viagem" }]);
    expect(callArguments("não é json")).toEqual([{ label: "argumentos", value: "não é json" }]);
    expect(callArguments(undefined)).toEqual([]);
    expect(callArguments({ text: "x".repeat(300) })[0]?.value).toHaveLength(120);
  });

  it("reads the domain's activity line", () => {
    expect(parseActivity("Consultou search_operations (12 encontrado(s))")).toEqual({
      tool: "search_operations",
      found: 12,
    });
    expect(parseActivity("Consultou list_tags")).toEqual({ tool: "list_tags", found: null });
    expect(parseActivity("Resposta inválida do modelo (1 de 3): x")).toBeNull();
  });
});

describe("links to the Livro", () => {
  it("become refs the Livro reads back", () => {
    expect(parseReveal(livroRef(["tag", "Viagem 2026"]))).toEqual({ kind: "tag", id: "Viagem 2026" });
    expect(parseReveal(livroRef(["filter", "abc", null]))).toEqual({ kind: "account", id: "abc" });
    expect(parseReveal(livroRef(["filter", "abc", ["2026-08-01" as IsoDate, "2026-08-31" as IsoDate]]))).toMatchObject({
      kind: "filter",
      id: "abc",
      month: null,
      range: ["2026-08-01", "2026-08-31"],
    });
  });
});

describe("CPF and CNPJ", () => {
  it("finds valid ones in any writing and hides them; invalid numbers pass", () => {
    for (const text of ["529.982.247-25", "52998224725", "11.222.333/0001-81", "11222333000181"]) {
      expect(hasTaxId(`veja ${text} aqui`), text).toBe(true);
      expect(sanitize(`veja ${text} aqui`)).toMatch(/\[(CPF|CNPJ) oculto\]/);
    }
    expect(hasTaxId("123.456.789-00 e 12345678901234")).toBe(false);
    expect(sanitize("saldo de 1.234,56 em 2026-10-05")).toBe("saldo de 1.234,56 em 2026-10-05");
  });
});

describe("what goes back to the model", () => {
  it("carries exact numbers as the text they were", () => {
    expect(plainNumbers({ a: [Dec.parse("1.50")], b: { c: Dec.parse("2") }, d: "x", e: 3 })).toEqual({
      a: ["1.50"],
      b: { c: "2" },
      d: "x",
      e: 3,
    });
    expect(() => JSON.stringify(plainNumbers({ x: Dec.parse("87.4") }))).not.toThrow();
  });
});

describe("the stoppable transport", () => {
  const pending = () => new Promise<{ status: number; text(): Promise<string> }>(() => undefined);

  it("drops a request when the question is cancelled and refuses new ones", async () => {
    const controller = new AbortController();
    const transport = stoppable(pending, controller.signal);
    const init = { method: "POST", headers: {}, signal: new AbortController().signal } as const;
    const request = transport("http://127.0.0.1:11434/api/chat", init);
    controller.abort();
    await expect(request).rejects.toThrow("aborted");
    await expect(transport("http://127.0.0.1:11434/api/chat", init)).rejects.toThrow("aborted");
  });

  it("passes the answer through otherwise", async () => {
    const transport = stoppable(
      () => Promise.resolve({ status: 200, text: () => Promise.resolve("ok") }),
      new AbortController().signal,
    );
    const answer = await transport("http://127.0.0.1:11434/api/version", {
      method: "GET",
      headers: {},
      signal: new AbortController().signal,
    });
    expect(await answer.text()).toBe("ok");
  });
});
