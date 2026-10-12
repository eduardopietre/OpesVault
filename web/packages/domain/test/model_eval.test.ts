/** The model comparison tool (tools/model_eval.ts) scores with the app's own client, never a real Ollama. */
import { describe, expect, it } from "vitest";
import { BATCH_SIZE } from "../src/ai/ollama.ts";
import { EARNINGS, evaluate, ITEMS, NONE, score, SPENDING, table } from "../../../tools/model_eval.ts";
import { FakeOllama } from "./fake_ollama.ts";

/**
 * The model's answers with the expected category for every row of one group, one per batch of
 * BATCH_SIZE descriptions (indexes within the batch), as the client asks them.
 */
function answersFor(rows: readonly (readonly [string, string])[], skip: (category: string) => boolean = () => false) {
  const batches: string[] = [];
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const suggestions = rows
      .slice(start, start + BATCH_SIZE)
      .flatMap(([, category], index) => (category === NONE || skip(category) ? [] : [{ index, category }]));
    batches.push(JSON.stringify({ suggestions }));
  }
  return batches;
}

describe("model evaluation", () => {
  it("scores right, wrong, abstained and answered injection lines", () => {
    const expected = [...SPENDING, ...EARNINGS].map(([, c]) => c);
    const answers = new Map<number, string>();
    expected.forEach((c, i) => c !== NONE && answers.set(i, c));
    answers.set(0, "Lazer"); // wrong: iFood is Alimentação
    answers.delete(1); // abstained
    const injection = expected.indexOf(NONE);
    answers.set(injection, "Salário"); // followed the text in the description
    const result = score(answers);
    const labelled = ITEMS - 2;
    expect(result).toMatchObject({ abstained: 1, wrong: 1 });
    expect(result.accuracy).toBe(Math.round(((labelled - 2) / labelled) * 1000) / 1000);
    expect(result.answered_injection_lines).toEqual([SPENDING[injection]![0]]);
    expect(result.most_common_misses).toEqual(
      expect.arrayContaining([
        ["Alimentação → Lazer", 1],
        ["Alimentação → NENHUMA", 1],
      ]),
    );
  });

  it("asks spending and earnings apart, times the load apart and frees the GPU at the end", async () => {
    const fake = new FakeOllama();
    fake.gpuShare = 50;
    // each attempt: one answer for SPENDING, one for EARNINGS; the second run drops Transporte (unstable)
    const perfect = [...answersFor(SPENDING), ...answersFor(EARNINGS)];
    const unstable = [...answersFor(SPENDING, (c) => c === "Transporte"), ...answersFor(EARNINGS)];
    fake.answers = [...perfect, ...perfect, ...unstable];
    let clock = 0;
    const report = await evaluate("gemma4:12b", {
      transport: fake.transport,
      repeats: 2,
      now: () => (clock += 500),
    });
    expect(report).toMatchObject({
      model: "gemma4:12b",
      examples: false,
      accuracy: 1,
      wrong: 0,
      abstained: 0,
      answered_injection_lines: [],
      stable_between_runs: false,
      first_call_s: 0.5,
      seconds_per_run: 0.5,
      invalid_answers: 0,
      memory: { size_gb: 8, gpu_share: 0.5 },
    });
    const chats = fake.received.filter((body) => "messages" in body);
    expect(chats).toHaveLength(3 * perfect.length); // the load run and two timed runs
    // earnings are never asked with expense categories, nor the other way round
    const prompt = (body: Record<string, unknown>) => JSON.stringify(body["messages"]);
    expect(prompt(chats[0]!)).toContain("Transporte");
    expect(prompt(chats[0]!)).not.toContain("Salário");
    expect(prompt(chats[perfect.length - 1]!)).toContain("Salário");
    expect(fake.received.at(-1)).toMatchObject({ model: "gemma4:12b", keep_alive: 0 });
  });

  it("sends the family's examples only when asked, and reports a model that is missing", async () => {
    const fake = new FakeOllama();
    fake.answer = answersFor(SPENDING)[0]!;
    await evaluate("gemma4:12b", { transport: fake.transport, repeats: 1, withExamples: true });
    expect(JSON.stringify(fake.received[0]!["messages"])).toContain("PETZ COMERCIO DE PRODUTOS");
    const missing = new FakeOllama();
    missing.missingModel = true;
    const report = await evaluate("llama9", { transport: missing.transport, repeats: 1 });
    expect(report.accuracy).toBeUndefined();
    expect(report.invalid_answers).toBe(2);
    expect(report.errors?.[0]).toMatch(/ollama pull llama9|não está instalado/);
  });

  it("prints one line per model, with examples marked", () => {
    const text = table("0.35.1", [
      {
        model: "gemma4:12b",
        examples: true,
        accuracy: 0.97,
        wrong: 1,
        abstained: 1,
        answered_injection_lines: [],
        stable_between_runs: true,
        seconds_per_run: 10,
        invalid_answers: 0,
        memory: { gpu_share: 1 },
      },
    ]);
    expect(text).toContain(`Ollama 0.35.1 · ${ITEMS} lançamentos sintéticos`);
    expect(text.split("\n").at(-1)).toMatch(/^gemma4:12b \+ex\s+97%\s+1\s+1\s+0\s+sim\s+10\s+100%$/);
  });
});
