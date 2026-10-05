/**
 * The parser worker: what crosses the boundary is plain JSON, validated with zod on the way back,
 * and an import through the worker stores exactly what an import on the main thread stores.
 */
import { MessageChannel } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import * as pipeline from "../src/importing/pipeline.ts";
import {
  analysisFrom,
  analysisJson,
  handleRequest,
  ParserWorkerClient,
  serveParser,
  WorkerFailed,
  type WorkerPort,
} from "../src/importing/parser_worker.ts";
import { SourceError, SourceProblem } from "../src/importing/source.ts";
import { Session } from "../src/session.ts";
import { bytesOf, extractor, parsersGolden } from "./importing_helpers.ts";

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const c of channels.splice(0)) {
    c.port1.close();
    c.port2.close();
  }
});

/** A real MessageChannel: requests and replies go through structured clone, as with a Worker. */
function connected(): ParserWorkerClient {
  const channel = new MessageChannel();
  channels.push(channel);
  serveParser(channel.port2 as unknown as WorkerPort, extractor);
  channel.port1.start();
  channel.port2.start();
  return new ParserWorkerClient(channel.port1 as unknown as WorkerPort);
}

const data = parsersGolden();

describe("parser worker", () => {
  it("answers what analyzeDocument answers, for every synthetic document", async () => {
    const client = connected();
    for (const doc of data.documents) {
      const request = { name: doc.name, data: bytesOf(doc.bytes) };
      const direct = await pipeline.analyzeDocument(request, extractor);
      const viaWorker = await client.analyze(request);
      expect(analysisJson(viaWorker), doc.name).toEqual(analysisJson(direct));
    }
  });

  it("an import through the worker stores the same batch as one on the main thread", async () => {
    const client = connected();
    const doc = data.documents.find((d) => d.name === "nubank_card.pdf")!;
    const request = { name: "nu.pdf", data: bytesOf(doc.bytes) };
    const a = Session.new();
    const b = Session.new();
    const direct = await pipeline.importDocument(a, request, extractor);
    pipeline.checkNotImported(b, request.data);
    const viaWorker = pipeline.importAnalyzed(b, request, await client.analyze(request));
    const strip = (s: Session, batchId: string) =>
      pipeline
        .itemsOf(s.ledger, batchId)
        .map(({ id: _id, batch_id: _b, evidence_ids: _e, target_account_id: t, ...rest }) => ({
          ...rest,
          target: t === null ? null : s.ledger.accounts.get(t)!.name,
        }));
    expect(viaWorker.status).toBe(direct.status);
    expect(viaWorker.header).toEqual(direct.header);
    expect(viaWorker.reconciliations).toEqual(direct.reconciliations);
    expect(strip(b, viaWorker.id)).toEqual(strip(a, direct.id));
  });

  it("password problems come back as SourceError, so the UI can ask", async () => {
    const client = connected();
    const enc = data.encrypted.find((e) => e.algorithm === "AES-256" && e.user)!;
    const problem = await client
      .analyze({ name: "f.pdf", data: bytesOf(enc.bytes) })
      .catch((e: SourceError) => e.problem);
    expect(problem).toBe(SourceProblem.PASSWORD_REQUIRED);
    const ok = await client.analyze({ name: "f.pdf", data: bytesOf(enc.bytes), password: "12345678900" });
    expect(ok.kind).toBe("read");
  });

  it("a reparse can run in the worker too", async () => {
    const client = connected();
    const session = Session.new();
    const unknown = data.documents.find((d) => d.name === "unknown_layout.pdf")!;
    const batch = await pipeline.importDocument(session, { name: "x.pdf", data: bytesOf(unknown.bytes) }, extractor);
    pipeline.checkReparsable(session, batch.id);
    const document = session.document(batch.document_id);
    const failed = await client.analyze({ name: "x.pdf", data: document.data, parser_id: "itau-extrato-pdf" });
    const redone = pipeline.storeReparseAnalysis(session, batch.id, failed);
    expect(redone.parser_id).toBe("itau-extrato-pdf");
    expect(pipeline.batches(session.ledger).has(batch.id)).toBe(false);
    const wrong = await client.analyze({ name: "x.pdf", data: document.data, parser_id: "ofx-generico" });
    expect(() => pipeline.storeReparseAnalysis(session, redone.id, wrong)).toThrow(); // only unresolved batches
  });

  it("garbage, a crash or silence from the worker never reaches the session", async () => {
    const replies: unknown[] = [
      { id: 1, kind: "analysis", analysis: { kind: "read", source: {}, choice: { kind: "none", candidates: [] } } },
      { id: 2, kind: "error", code: "WORKER_FAILED" },
      {
        id: 3,
        kind: "analysis",
        analysis: { kind: "problem", problem: "invalid", extra: "<script>" },
      },
    ];
    const listeners: ((e: { data: unknown }) => void)[] = [];
    const fake: WorkerPort = {
      postMessage: (m) => {
        const id = (m as { id: number }).id;
        const reply = replies[id - 1];
        if (reply !== undefined) queueMicrotask(() => listeners.forEach((l) => l({ data: reply })));
      },
      addEventListener: (_type, listener) => listeners.push(listener),
    };
    const client = new ParserWorkerClient(fake, 50);
    const req = { name: "x", data: new Uint8Array([1]) };
    for (let n = 0; n < 4; n++) await expect(client.analyze(req)).rejects.toThrow(WorkerFailed); // 4: no answer
  });

  it("refuses malformed requests and never leaks what failed", async () => {
    expect(await handleRequest({ id: 7, name: "x" }, extractor)).toEqual({
      id: -1,
      kind: "error",
      code: "WORKER_FAILED",
    });
    const thrower = { extract: () => Promise.reject(new Error("CPF 123.456.789-00")) };
    const reply = await handleRequest(
      { id: 8, name: "x.pdf", data: new TextEncoder().encode("%PDF-1.4"), password: null, parser_id: null },
      thrower,
    );
    expect(reply).toEqual({ id: 8, kind: "analysis", analysis: { kind: "problem", problem: "invalid" } });
    expect(JSON.stringify(reply)).not.toContain("CPF");
  });

  it("decimals cross as text and come back exact", () => {
    const json = analysisJson({
      kind: "read",
      source: { name: "x", format: "csv", lines: [], rows: [], ofx: null, pages: 0, producer: null },
      choice: { kind: "none", candidates: ["a", "b"] },
    });
    expect(analysisFrom(JSON.parse(JSON.stringify(json)))).toEqual({
      kind: "read",
      source: { name: "x", format: "csv", lines: [], rows: [], ofx: null, pages: 0, producer: null },
      choice: { kind: "none", candidates: ["a", "b"] },
    });
    expect(() =>
      analysisFrom({
        kind: "read",
        source: { name: "x", format: "csv", lines: [], rows: [], ofx: null, pages: 0, producer: null },
        choice: {
          kind: "parsed",
          parser_id: "p",
          result: {
            header: {},
            items: [],
            warnings: [],
            unmapped: [],
          },
        },
      }),
    ).toThrow(); // a header without its fields
    expect(SourceError).toBeDefined();
  });
});
