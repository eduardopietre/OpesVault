/**
 * The conversation API the Assistant uses (`chatTools`, `supportsTools`) and the JSON reading it
 * relies on: numbers in tool arguments arrive exact, as Python's `json.loads(parse_float=Decimal)`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { Dec } from "../src/lib/dec.ts";
import { AiUnavailable, dumpJson, OllamaClient, parseJson } from "../src/ai/ollama.ts";
import * as prompts from "../src/ai/prompts.ts";
import { FakeOllama } from "./fake_ollama.ts";

let fake: FakeOllama;
beforeEach(() => {
  fake = new FakeOllama();
});
const tools = [{ type: "function", function: { name: "buscar", description: "x", parameters: { type: "object" } } }];

describe("chatTools", () => {
  it("sends the app's tools with thinking off and a longer context, and reads tool calls exactly", async () => {
    fake.messages = [
      { content: "", tool_calls: [{ function: { name: "buscar", arguments: { valor: 12.5, n: 3, texto: "a" } } }] },
    ];
    const client = new OllamaClient("gemma4:12b", fake.transport);
    const turn = await client.chatTools(prompts.ASSISTANT_SYSTEM, [{ role: "user", content: "quanto gastei?" }], tools);
    const sent = fake.received.at(-1)!;
    expect(sent["tools"]).toEqual(tools);
    expect(sent["think"]).toBe(false);
    expect(sent["options"]).toEqual({ temperature: 0, num_ctx: 16384 });
    expect((sent["messages"] as { role: string }[]).map((m) => m.role)).toEqual(["system", "user"]);
    expect(turn.tool_calls).toHaveLength(1);
    expect(turn.tool_calls[0]!.name).toBe("buscar");
    const args = turn.tool_calls[0]!.arguments as Record<string, unknown>;
    expect(args["valor"]).toBeInstanceOf(Dec); // money never passes through float
    expect((args["valor"] as Dec).toString()).toBe("12.5");
    expect(args["n"]).toBe(3);
    expect(turn.raw["role"]).toBe("assistant");
  });

  it("refuses models without tools and says where to choose another", async () => {
    fake.capabilities = ["completion"];
    const client = new OllamaClient("m", fake.transport);
    expect(await client.supportsTools()).toBe(false);
    fake.capabilities = null;
    expect(await client.supportsTools()).toBeNull();
    fake.capabilities = ["tools"];
    expect(await client.supportsTools()).toBe(true);
  });

  it("an answer sent back with a Decimal argument fails as on the desktop (json.dumps TypeError)", async () => {
    fake.messages = [
      { content: "", tool_calls: [{ function: { name: "buscar", arguments: { valor: 1.5 } } }] },
      { content: "ok" },
    ];
    const client = new OllamaClient("m", fake.transport);
    const turn = await client.chatTools("S", [], tools);
    await expect(client.chatTools("S", [turn.raw], tools)).rejects.toThrow(TypeError);
  });

  it("a malformed message is unavailable, not a crash", async () => {
    fake.messages = [{}];
    fake.rawBody = '{"nada": 1}';
    await expect(new OllamaClient("m", fake.transport).chatTools("S", [], tools)).rejects.toThrow(AiUnavailable);
  });
});

describe("JSON as Python reads it", () => {
  it("keeps the last duplicate key, accepts NaN and Infinity, refuses extra data and raw control characters", () => {
    expect(parseJson('{"a": 1, "a": 2}')).toEqual({ a: 2 });
    expect(Number.isNaN(parseJson("NaN") as number)).toBe(true);
    expect(parseJson("-Infinity")).toBe(-Infinity);
    expect(() => parseJson('{"a": 1} x')).toThrow();
    expect(() => parseJson('"a\nb"')).toThrow();
    expect(parseJson(' \t\n{"a": "\\u00e7\\n"} ')).toEqual({ a: "ç\n" });
    expect(() => parseJson("01")).toThrow();
    expect(() => parseJson("{'a': 1}")).toThrow();
  });

  it("exact: fractions and exponents become Dec, big integers bigint", () => {
    const value = parseJson('{"v": 0.1, "w": 1e2, "n": 7, "big": 123456789012345678901234567890}', true) as Record<
      string,
      unknown
    >;
    expect((value["v"] as Dec).toString()).toBe("0.1");
    expect((value["w"] as Dec).toString()).toBe("1E+2");
    expect(value["n"]).toBe(7);
    expect(value["big"]).toBe(123456789012345678901234567890n);
  });

  it("a key named __proto__ is data, never the prototype", () => {
    const value = parseJson('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("dumps big integers as numbers and refuses Dec", () => {
    expect(dumpJson({ n: 10n ** 30n })).toBe('{"n":1000000000000000000000000000000}');
    expect(() => dumpJson({ v: Dec.parse("1.5") })).toThrow(TypeError);
  });
});
