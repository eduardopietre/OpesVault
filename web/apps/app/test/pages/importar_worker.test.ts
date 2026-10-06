/**
 * The way documents are read off the main thread: the page's service over the domain's worker protocol (with an
 * in-process stand-in for the Worker), what happens when the worker fails, hangs or answers garbage, cancelling,
 * and the store where files dropped anywhere wait for the import page.
 */
import { importing, type IsoDate } from "@opesvault/domain";
import { afterEach, describe, expect, it } from "vitest";
import { BANK_OFX, NUBANK_CARD_CSV } from "../../../../packages/domain/src/demo_docs/index.ts";
import {
  addDroppedFiles,
  hasDroppedFiles,
  subscribeDroppedFiles,
  takeDroppedFiles,
} from "../../src/data/dropped_files.ts";
import { READ_FAILED, ReadCancelled, parser, setParserPortFactory } from "../../src/data/parser_client.ts";
import { installFakeWorker } from "./importar_harness.tsx";

const { SourceError, SourceProblem } = importing.source;
const request = (name: string, data: Uint8Array, password: string | null = null) => ({ name, data, password });

afterEach(() => {
  setParserPortFactory(null);
  takeDroppedFiles();
});

describe("reading in the worker", () => {
  it("answers what analyzeDocument finds, validated, for an OFX, a CSV and a document with no layout", async () => {
    installFakeWorker();
    const ofx = await parser.analyze(request("extrato.ofx", BANK_OFX));
    expect(ofx.kind).toBe("read");
    if (ofx.kind !== "read" || ofx.choice.kind !== "parsed") throw new Error("not parsed");
    expect(ofx.choice.parser_id).toBe("ofx-generico");
    // decimals are rebuilt from text and dates stay ISO text: nothing went through a float
    const first = ofx.choice.result.items[0]!;
    expect(first.amount?.toString()).toBe("5000.00");
    expect(first.occurred_on).toBe("2026-01-05" as IsoDate);

    const csv = await parser.analyze(request("fatura.csv", NUBANK_CARD_CSV));
    expect(csv.kind === "read" && csv.choice.kind === "parsed" && csv.choice.result.items.length).toBe(3);

    const unknown = await parser.analyze(request("a.csv", new TextEncoder().encode("a;b\n1;2\n")));
    expect(unknown.kind === "read" && unknown.choice.kind).toBe("none");
  });

  it("reports a corrupt PDF as a problem of the document, not a failure of the worker", async () => {
    installFakeWorker();
    const analysis = await parser.analyze(
      request("quebrado.pdf", new TextEncoder().encode("%PDF-1.4 isto não é um PDF")),
    );
    expect(analysis).toEqual({ kind: "problem", problem: SourceProblem.INVALID });
  });

  it("forces the layout the person chose", async () => {
    installFakeWorker();
    const analysis = await parser.analyze({
      ...request("fatura.csv", NUBANK_CARD_CSV),
      parser_id: "nubank-cartao-csv",
    });
    expect(analysis.kind === "read" && analysis.choice.kind === "parsed" && analysis.choice.parser_id).toBe(
      "nubank-cartao-csv",
    );
  });

  it("throws SourceError for a protected PDF without its password, so the page asks", async () => {
    const worker = installFakeWorker();
    const { protectedPdf } = await import("../../e2e/protected_pdf.ts");
    await expect(parser.analyze(request("p.pdf", new Uint8Array(protectedPdf())))).rejects.toBeInstanceOf(SourceError);
    await expect(parser.analyze(request("p.pdf", new Uint8Array(protectedPdf()), "errada"))).rejects.toMatchObject({
      problem: SourceProblem.WRONG_PASSWORD,
    });
    const ok = await parser.analyze(request("p.pdf", new Uint8Array(protectedPdf()), "segredo"));
    expect(ok.kind).toBe("read");
    expect(worker.received.map((m) => m["password"])).toEqual([null, "errada", "segredo"]);
  });
});

describe("when the worker goes wrong", () => {
  it("gives up on a worker that never answers, ends it and starts a fresh one for the next file", async () => {
    const worker = installFakeWorker(60);
    worker.hang = true;
    await expect(parser.analyze(request("extrato.ofx", BANK_OFX))).rejects.toMatchObject({ name: "WorkerFailed" });
    expect(worker.terminated).toBe(1);
    worker.hang = false;
    const analysis = await parser.analyze(request("extrato.ofx", BANK_OFX));
    expect(analysis.kind).toBe("read");
    expect(worker.started).toBe(2);
  });

  it("does not trust an answer that does not have the shape the protocol says", async () => {
    const worker = installFakeWorker();
    worker.garbage = true;
    await expect(parser.analyze(request("extrato.ofx", BANK_OFX))).rejects.toMatchObject({ name: "WorkerFailed" });
  });

  it("cancels what is being read: the waiting call fails with ReadCancelled and the worker ends", async () => {
    const worker = installFakeWorker();
    worker.hang = true;
    const waiting = parser.analyze(request("extrato.ofx", BANK_OFX));
    expect(parser.busy).toBe(true);
    parser.cancel();
    await expect(waiting).rejects.toBeInstanceOf(ReadCancelled);
    expect(worker.terminated).toBe(1);
    expect(parser.busy).toBe(false);
    // and a late answer of the ended worker cannot disturb the next reading
    worker.hang = false;
    expect((await parser.analyze(request("extrato.ofx", BANK_OFX))).kind).toBe("read");
  });

  it("fails every waiting call when the worker dies, and says nothing from the document", async () => {
    const listeners: Record<string, ((event: { data: unknown }) => void)[]> = {};
    setParserPortFactory(() => ({
      postMessage: () => undefined,
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
        (listeners[type] ??= []).push(listener);
      },
      terminate: () => undefined,
    }));
    const waiting = parser.analyze(request("extrato.ofx", BANK_OFX));
    listeners["error"]!.forEach((listener) => listener({ data: null }));
    await expect(waiting).rejects.toMatchObject({ name: "WorkerFailed", message: "WORKER_FAILED" });
    expect(READ_FAILED).not.toContain("extrato");
  });

  it("fails clearly where there is no Worker at all", async () => {
    setParserPortFactory(null);
    const saved = (globalThis as { Worker?: unknown }).Worker;
    delete (globalThis as { Worker?: unknown }).Worker;
    try {
      await expect(parser.analyze(request("extrato.ofx", BANK_OFX))).rejects.toMatchObject({ name: "WorkerFailed" });
    } finally {
      if (saved !== undefined) (globalThis as { Worker?: unknown }).Worker = saved;
    }
  });
});

describe("files dropped anywhere in the app", () => {
  it("wait in a store that hands them over once and tells the page when more arrive", () => {
    let calls = 0;
    const stop = subscribeDroppedFiles(() => calls++);
    expect(hasDroppedFiles()).toBe(false);
    expect(addDroppedFiles([new File(["a"], "a.pdf"), new File(["b"], "b.csv")])).toBe(2);
    expect(addDroppedFiles([])).toBe(0);
    expect(calls).toBe(1);
    expect(hasDroppedFiles()).toBe(true);
    expect(takeDroppedFiles().map((f) => f.name)).toEqual(["a.pdf", "b.csv"]);
    expect(takeDroppedFiles()).toEqual([]);
    stop();
    addDroppedFiles([new File(["c"], "c.ofx")]);
    expect(calls).toBe(1);
  });
});
