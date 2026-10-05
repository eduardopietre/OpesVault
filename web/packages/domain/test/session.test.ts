/**
 * The in-memory session: documents, undo of an import, and what a sync sends. Ports the import
 * case of `tests/test_undo.py`, the session cases of `tests/test_misc.py` and
 * `tests/test_acceptance_gaps.py` (TA-31), the receipts case of `tests/test_planning_more.py` and
 * the pipeline cases of `tests/test_pdf_password.py`.
 */
import { describe, expect, it } from "vitest";

import * as attachments from "../src/domain/attachments.ts";
import { DomainError } from "../src/domain/ledger.ts";
import { AccountSubtype, AccountType, LedgerAccountSchema } from "../src/domain/model.ts";
import * as queries from "../src/domain/queries.ts";
import { makeDate } from "../src/lib/dates.ts";
import { BatchStatus } from "../src/importing/model.ts";
import * as pipeline from "../src/importing/pipeline.ts";
import { SourceError, SourceProblem } from "../src/importing/source.ts";
import { documentFromBytes, Session, sha256Hex, verifyDocument } from "../src/session.ts";
import { UndoStack } from "../src/undo.ts";
import { category, family } from "./fixtures.ts";
import { bytesOf, doc, extractor, parsersGolden } from "./importing_helpers.ts";

function setup() {
  const f = family();
  const session = Session.new();
  session.ledger = f.ledger;
  f.ledger.recordOpeningBalance(f.bank, "1000.00", makeDate(2026, 1, 1));
  return { f, session, stack: new UndoStack(() => session.ledger) };
}

describe("documents", () => {
  it("hashes the bytes with SHA-256 and verifies them", () => {
    const document = documentFromBytes("a.txt", new TextEncoder().encode("abc"));
    expect(document.meta.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(document.meta.size).toBe(3);
    expect(verifyDocument(document)).toBe(true);
    expect(verifyDocument({ ...document, data: new TextEncoder().encode("abd") })).toBe(false);
    expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("test_ta31_domain_sessions_share_no_state", () => {
    const a = Session.new("A");
    const b = Session.new("B");
    const bank = a.ledger.addAccount(
      LedgerAccountSchema.parse({ name: "X", type: AccountType.ASSET, subtype: AccountSubtype.CHECKING }),
    ).id;
    a.ledger.recordOpeningBalance(bank, "10.00", makeDate(2026, 1, 1));
    a.addDocument("n.pdf", doc("nubank_card.pdf"));
    expect(b.ledger.accounts.has(bank)).toBe(false);
    expect(b.ledger.operations.size).toBe(0);
    expect(b.documents).toHaveLength(0);
    expect(a.projectId).not.toBe(b.projectId);
  });
});

describe("undo (tests/test_undo.py)", () => {
  it("test_undo_an_import_removes_document_batch_and_items", async () => {
    const { session, stack } = setup();
    stack.seal();
    const batch = await pipeline.importDocument(session, { name: "nu.pdf", data: doc("nubank_card.pdf") }, extractor);
    expect(stack.seal()).not.toBeNull();
    expect(session.documents).toHaveLength(1);
    stack.undo();
    expect(session.documents).toEqual([]);
    expect(pipeline.batches(session.ledger).has(batch.id)).toBe(false);
    expect(pipeline.items(session.ledger).size).toBe(0);
    const pending = session.pendingSync();
    expect(pending.full || pending.documentsAdded.length === 0).toBe(true);
    stack.redo();
    expect(session.documents).toHaveLength(1);
    expect(pipeline.batches(session.ledger).has(batch.id)).toBe(true);
  });

  it("an undone import after a sync is sent as deletions, the document as removed", async () => {
    const { session, stack } = setup();
    session.markSynced(session.pendingSync());
    stack.clear();
    const batch = await pipeline.importDocument(session, { name: "nu.pdf", data: doc("nubank_card.pdf") }, extractor);
    stack.seal();
    const before = session.pendingSync();
    expect(before.full).toBe(false);
    expect(before.documentsAdded.map((d) => d.meta.original_name)).toEqual(["nu.pdf"]);
    expect(before.upserts.some((r) => r.id === batch.id)).toBe(true);
    stack.undo();
    const after = session.pendingSync();
    expect(after.documentsAdded).toEqual([]); // added and removed before a sync: nothing to send
    expect(after.documentsRemoved).toEqual([]);
    expect(after.deletes.some((d) => d.id === batch.id && d.kind === "import_batch")).toBe(true);
    expect(after.upserts.some((r) => r.id === batch.id)).toBe(false);
  });

  it("test_undo_redo_of_an_expense_restores_balances_and_history", () => {
    const { f, session, stack } = setup();
    const ledger = session.ledger;
    const historyBefore = ledger.history.length;
    const op = ledger.recordExpense(f.bank, category(ledger, "Lazer"), "200.00", makeDate(2026, 1, 5), "Show");
    expect(stack.seal()?.label).toBe("lançamento");
    expect(queries.balance(ledger, f.bank).toFixed()).toBe("800.00");
    stack.undo();
    expect(ledger.operations.has(op.id)).toBe(false);
    expect(ledger.history.length).toBe(historyBefore);
    expect(queries.balance(ledger, f.bank).toFixed()).toBe("1000.00");
    stack.redo();
    expect(ledger.operations.get(op.id)).toBe(op);
  });
});

describe("sync (tests/test_misc.py, test_undo.py)", () => {
  it("test_new_session_is_dirty_until_saved", () => {
    const session = Session.new();
    expect(session.dirty).toBe(true);
    const pending = session.pendingSync();
    expect(pending.full).toBe(true);
    session.markSynced(pending);
    expect(session.dirty).toBe(false);
    expect(session.pendingSync().full).toBe(false);
    expect(session.pendingSync().upserts).toEqual([]);
  });

  it("test_edits_during_save_stay_unsaved", () => {
    const session = Session.new();
    const pending = session.pendingSync();
    const before = pending.upserts.length;
    session.ledger.addMember("Ana");
    session.markSynced(pending);
    expect(session.dirty).toBe(true);
    expect(pending.upserts.length).toBe(before);
    expect(
      session
        .pendingSync()
        .upserts.map((r) => r.kind)
        .sort(),
    ).toEqual(["history", "member"]);
  });

  it("test_undone_changes_are_saved_as_deletions", () => {
    const { f, session, stack } = setup();
    session.markSynced(session.pendingSync());
    stack.clear();
    const op = session.ledger.recordExpense(
      f.bank,
      category(session.ledger, "Lazer"),
      "9.00",
      makeDate(2026, 1, 9),
      "X",
    );
    stack.seal();
    stack.undo();
    const pending = session.pendingSync();
    expect(pending.deletes.some((d) => d.id === op.id)).toBe(true);
    expect(pending.upserts.every((r) => r.id !== op.id)).toBe(true);
  });

  it("documents removed after a sync are sent as removed", () => {
    const session = Session.new();
    const document = session.addDocument("a.pdf", doc("nubank_card.pdf"));
    session.markSynced(session.pendingSync());
    expect(session.documentChanges()).toEqual({ added: [], removed: [] });
    session.removeDocument(document.meta.id);
    expect(session.pendingSync().documentsRemoved).toEqual([document.meta.id]);
    expect(() => session.document(document.meta.id)).toThrow();
    expect(session.findDocumentByHash(document.meta.sha256)).toBeNull();
  });
});

describe("receipts (tests/test_planning_more.py)", () => {
  const PDF = new TextEncoder().encode("%PDF-1.4\n%fake receipt\n");
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(16).fill(0)]);

  it("test_receipts_are_vault_documents_linked_beside_the_operation", () => {
    const f = family();
    const session = Session.new();
    session.ledger = f.ledger;
    const op = f.ledger.recordExpense(f.bank, f.groceries, "80.00", makeDate(2026, 1, 5), "Dentista");
    // TODO(W6-integration): the desktop closes January first (domain/periods, W4) to show a receipt never changes a figure.
    const first = attachments.attach(session, op.id, "recibo.pdf", PDF);
    expect(session.documents.map((d) => d.meta.original_name)).toEqual(["recibo.pdf"]);
    const other = f.ledger.recordExpense(f.bank, f.groceries, "10.00", makeDate(2026, 2, 5), "Outro");
    attachments.attach(session, other.id, "mesmo.pdf", PDF); // the same bytes: one document, two links
    expect(session.documents).toHaveLength(1);
    expect(attachments.ofDocument(f.ledger, first.document_id)).toHaveLength(2);
    expect(() => attachments.attach(session, op.id, "de novo.pdf", PDF)).toThrow(/já está anexado/);
    expect(() => attachments.attach(session, op.id, "nota.txt", new TextEncoder().encode("texto qualquer"))).toThrow(
      /PDF ou uma imagem/,
    );
    const photo = attachments.attach(session, op.id, "foto.png", PNG);
    expect(attachments.kindOf(PNG)).toBe("png");
    expect(session.documents).toHaveLength(2);
    attachments.detach(session, first.id);
    expect(session.documents).toHaveLength(2); // still used by the other operation
    attachments.detach(session, photo.id);
    expect(session.documents.map((d) => d.meta.original_name)).toEqual(["recibo.pdf"]);
    expect(() => attachments.attach(session, "00000000-0000-4000-8000-000000000000", "x.pdf", PDF)).toThrow(
      DomainError,
    );
    expect(attachments.kindOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
  });
});

describe("PDF passwords in the pipeline (tests/test_pdf_password.py)", () => {
  const PASSWORD = "12345678900";
  const encrypted = (algorithm: string) =>
    bytesOf(parsersGolden().encrypted.find((e) => e.algorithm === algorithm)!.bytes);

  it("test_import_with_password_keeps_the_original_and_not_the_password", async () => {
    const data = encrypted("AES-256");
    const session = Session.new();
    await expect(pipeline.importDocument(session, { name: "fatura.pdf", data }, extractor)).rejects.toThrow(
      SourceError,
    );
    expect(session.documents).toHaveLength(0); // nothing stored before the password is right
    const batch = await pipeline.importDocument(session, { name: "fatura.pdf", data, password: PASSWORD }, extractor);
    expect(batch.status).toBe(BatchStatus.IN_REVIEW);
    expect(session.documents).toHaveLength(1);
    expect(session.documents[0]!.data).toEqual(data); // the evidence is the bank's file, still encrypted
    const stored = JSON.stringify(session.ledger.toRecords()) + JSON.stringify(batch);
    expect(stored).not.toContain(PASSWORD);
  });

  it("test_choosing_a_layout_again_needs_the_password", async () => {
    const data = encrypted("AES-128");
    const session = Session.new();
    const batch = await pipeline.importDocument(
      session,
      { name: "fatura.pdf", data, password: PASSWORD, parser_id: "nubank-cartao-pdf" },
      extractor,
    );
    pipeline.batches(session.ledger).set(batch.id, { ...batch, status: BatchStatus.AMBIGUOUS });
    const missing = await pipeline
      .reparseWith(session, batch.id, "nubank-cartao-pdf", null, extractor)
      .catch((e: SourceError) => e.problem);
    expect(missing).toBe(SourceProblem.PASSWORD_REQUIRED);
    const redone = await pipeline.reparseWith(session, batch.id, "nubank-cartao-pdf", PASSWORD, extractor);
    expect(redone.status).toBe(BatchStatus.IN_REVIEW);
  });
});
