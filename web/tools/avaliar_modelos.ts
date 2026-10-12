/**
 * Compares local Ollama models on the app's categorization task (tools/model_eval.ts).
 *
 *   node tools/avaliar_modelos.ts [MODELO ...] [--repeticoes 2] [--exemplos] [--porta 11434] [--out build/ia/avaliacao.json]
 *
 * Runs on the machine where Ollama is (it listens on loopback only); Node below 22.18 needs
 * `--experimental-strip-types`. Nothing is downloaded: install the models with `ollama pull <modelo>`.
 * Without models, it compares the recommended ones that are installed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AiUnavailable, OllamaClient, RECOMMENDED_MODELS, localUrl } from "../packages/domain/src/ai/ollama.ts";
import type { Transport } from "../packages/domain/src/ai/ollama.ts";
import { evaluate, ITEMS, table, type ModelReport } from "./model_eval.ts";

const transport: Transport = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: { ...init.headers },
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal,
  });
  return { status: response.status, text: () => response.text() };
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repeticoes: { type: "string", default: "2" },
    exemplos: { type: "boolean", default: false },
    porta: { type: "string", default: "11434" },
    out: { type: "string", default: resolve(import.meta.dirname, "../build/ia/avaliacao.json") },
  },
});
const repeats = Number(values.repeticoes);
if (!Number.isInteger(repeats) || repeats < 1) fail("--repeticoes precisa ser um inteiro a partir de 1.");
let baseUrl: string;
let info;
try {
  baseUrl = localUrl(Number(values.porta));
  info = await new OllamaClient(RECOMMENDED_MODELS[0], transport, baseUrl).serverInfo();
} catch (error) {
  if (error instanceof AiUnavailable) fail(`${error.message} Abra o Ollama (ollama serve) e tente de novo.`);
  throw error;
}
const asked = positionals.length ? positionals : RECOMMENDED_MODELS.filter((m) => info.installed(m));
const missing = asked.filter((m) => !info.installed(m));
if (missing.length) fail(`Não instalados: ${missing.join(", ")}. Instale com: ollama pull <modelo>`);
if (!asked.length) fail(`Nenhum dos recomendados está instalado: ${RECOMMENDED_MODELS.join(", ")}`);

const reports: ModelReport[] = [];
for (const model of asked.map((m) => info.installed(m)!)) {
  console.log(`avaliando ${model}…`);
  reports.push(await evaluate(model, { transport, baseUrl, repeats }));
  if (values.exemplos) {
    console.log(`avaliando ${model} com exemplos…`);
    reports.push(await evaluate(model, { transport, baseUrl, repeats, withExamples: true }));
  }
}

const out = resolve(values.out);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ ollama: info.version, items: ITEMS, models: reports }, null, 2) + "\n");
console.log(`\n${table(info.version, reports)}\n\nDetalhes em ${out}`);
