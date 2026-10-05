/** Port of `tests/test_importing.py` (parsers, sources and the import pipeline). */
import { beforeEach, describe, expect, it } from "vitest";

import { DomainError } from "../src/domain/ledger.ts";
import {
  AccountSubtype,
  AccountType,
  CardSchema,
  LedgerAccountSchema,
  OperationKind,
  type LedgerAccount,
} from "../src/domain/model.ts";
import * as queries from "../src/domain/queries.ts";
import { Dec } from "../src/lib/dec.ts";
import { makeDate, ym } from "../src/lib/dates.ts";
import { registerInstallmentPlanFinder } from "../src/importing/checks.ts";
import { BatchStatus, DocType, ItemKind, ItemStatus } from "../src/importing/model.ts";
import { noteComputedNet } from "../src/importing/parsers/brokerage.ts";
import { PARSERS, parserById } from "../src/importing/parsers/index.ts";
import * as pipeline from "../src/importing/pipeline.ts";
import { ImportRefused, importDocument, type ImportRequest } from "../src/importing/pipeline.ts";
import { loadSource, SourceError, SourceProblem } from "../src/importing/source.ts";
import { Session } from "../src/session.ts";
import { doc, extractor } from "./importing_helpers.ts";

const D = (s: string) => Dec.parse(s);
const enc = (s: string) => new TextEncoder().encode(s);
const req = (name: string, data: Uint8Array, extra: Partial<ImportRequest> = {}): ImportRequest => ({
  name,
  data,
  ...extra,
});
const imp = (session: Session, name: string, data: Uint8Array, extra: Partial<ImportRequest> = {}) =>
  importDocument(session, req(name, data, extra), extractor);

async function detect(name: string, data: Uint8Array): Promise<string> {
  const src = await loadSource(name, data, null, extractor);
  let best = PARSERS[0]!;
  for (const p of PARSERS) if (p.detect(src) > best.detect(src)) best = p; // max() keeps the first
  return best.id;
}

async function parse(parserId: string, data: Uint8Array, name = "doc.pdf") {
  return parserById(parserId).parse(await loadSource(name, data, null, extractor));
}

describe("parsers", () => {
  it.each([
    ["nubank_card.pdf", "nu.pdf", "nubank-cartao-pdf"],
    ["itau_card.pdf", "itau.pdf", "itau-cartao-pdf"],
    ["bradesco_card.pdf", "brad.pdf", "bradesco-cartao-pdf"],
    ["itau_bank.pdf", "extrato.pdf", "itau-extrato-pdf"],
    ["nubank_account.csv", "nu.csv", "nubank-conta-csv"],
    ["nubank_card.csv", "nucard.csv", "nubank-cartao-csv"],
    ["bank.ofx", "x.ofx", "ofx-generico"],
    ["sinacor_note.pdf", "nota.pdf", "sinacor-nota-pdf"],
  ])("test_layout_detection %s", async (builder, name, parserId) => {
    expect(await detect(name, doc(builder))).toBe(parserId);
  });

  it("test_nubank_card_quirks", async () => {
    const result = await parse("nubank-cartao-pdf", doc("nubank_card.pdf"));
    expect(result.header.due_on).toBe("2026-01-10");
    expect(result.header.closing_on).toBe("2026-01-03");
    const kinds = result.items.map((i) => [i.kind, i.description, i.amount?.toFixed(), i.occurred_on]);
    // Year comes from the header, never from the clock; December belongs to 2025.
    expect(kinds).toContainEqual([ItemKind.PURCHASE, "Mercado Bom Preço", "100.00", "2025-12-05"]);
    expect(kinds.filter((k) => k[1] === "Mercado Bom Preço")).toHaveLength(2); // equal purchases are both kept
    const amazon = result.items.find((i) => i.description === "Amazon.com")!;
    expect(amazon.amount!.eq(D("104.00")) && amazon.foreign_amount!.eq(D("20.00"))).toBe(true);
    expect(amazon.foreign_currency).toBe("USD");
    expect(amazon.lines).toHaveLength(3);
    expect(result.items.find((i) => i.description.startsWith("IOF"))!.kind).toBe(ItemKind.CARD_CHARGE);
    const installment = result.items.find((i) => i.installment)!;
    expect(installment.installment).toEqual([1, 3]);
    expect(installment.description).toBe("Loja Eletro");
    expect(result.items.find((i) => i.description === "Pagamento recebido")!.kind).toBe(ItemKind.CARD_PAYMENT);
    expect(result.items.find((i) => i.description.startsWith("Estorno"))!.kind).toBe(ItemKind.CARD_CREDIT);
    expect(result.items.every((i) => i.description !== "Saldo restante")).toBe(true);
  });

  it("test_itau_card_skips_future_installments_and_reads_iof", async () => {
    const result = await parse("itau-cartao-pdf", doc("itau_card.pdf"));
    const descriptions = result.items.map((i) => i.description);
    expect(descriptions.filter((d) => d === "PROQUALITY")).toHaveLength(1);
    expect(descriptions.filter((d) => d === "LOJAS RENNER")).toHaveLength(1);
    const renner = result.items.find((i) => i.description === "LOJAS RENNER")!;
    expect(renner.occurred_on).toBe("2025-12-28");
    expect(renner.installment).toEqual([2, 3]);
    expect(renner.amount!.toFixed()).toBe("171.70"); // installment number is never part of the value
    expect(new Set(result.items.filter((i) => i.description === "POSTO SHELL").map((i) => i.card_last4))).toEqual(
      new Set(["5678"]),
    );
    const iof = result.items.find((i) => i.kind === ItemKind.CARD_CHARGE)!;
    expect(iof.amount!.toFixed()).toBe("30.00");
    expect(iof.warnings.length).toBeGreaterThan(0);
  });

  it("test_bradesco_suffix_sign_and_holders", async () => {
    const result = await parse("bradesco-cartao-pdf", doc("bradesco_card.pdf"));
    expect(result.items.find((i) => i.kind === ItemKind.CARD_PAYMENT)!.amount!.toFixed()).toBe("500.00");
    expect(new Set(result.items.map((i) => i.card_last4))).toEqual(new Set(["4321", "8765"]));
    expect(result.items.some((i) => i.description.includes("Total para"))).toBe(false);
  });

  it("test_itau_bank_statement_balances", async () => {
    const result = await parse("itau-extrato-pdf", doc("itau_bank.pdf"));
    expect(result.header.opening_balance!.eq(D("1000.00"))).toBe(true);
    expect(result.header.closing_balance!.eq(D("1320.00"))).toBe(true);
    expect(result.header.period_start).toBe("2026-01-01");
    expect(result.items.filter((i) => i.kind === ItemKind.DEBIT)).toHaveLength(3);
  });

  it("test_ofx_reader", async () => {
    const result = await parse("ofx-generico", doc("bank.ofx"), "x.ofx");
    expect(result.items.map((i) => i.bank_id)).toEqual(["F001", "F002"]);
    expect(result.items[0]!.occurred_on).toBe("2026-01-05");
    expect(result.header.closing_balance!.toFixed()).toBe("3500.00");
  });

  it("test_sinacor_note", async () => {
    const result = await parse("sinacor-nota-pdf", doc("sinacor_note.pdf"));
    const trades = result.items.filter((i) => i.kind === ItemKind.TRADE);
    expect(trades.map((t) => t.ticker)).toEqual(["PETR4", "ITSA4", "VALE3"]);
    expect(trades[0]!.quantity!.eq(D("100")) && trades[0]!.unit_price!.eq(D("30.00"))).toBe(true);
    expect(result.header.net_amount!.toFixed()).toBe("-106.95");
    expect(result.header.note_number).toBe("123456");
    expect(noteComputedNet(result.items).toFixed()).toBe("-106.95");
  });

  it("test_scanned_pdf_is_unsupported", async () => {
    const error = await loadSource("scan.pdf", doc("scanned.pdf"), null, extractor).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).problem).toBe(SourceProblem.NO_TEXT);
  });

  it("test_unknown_format", async () => {
    const data = new Uint8Array(2560).map((_, i) => i % 256);
    await expect(loadSource("x.bin", data, null, extractor)).rejects.toThrow(SourceError);
  });
});

// ── pipeline ─────────────────────────────────────────

let session: Session;

function account(fields: Partial<LedgerAccount> & Pick<LedgerAccount, "name" | "type" | "subtype">): LedgerAccount {
  return session.ledger.addAccount(LedgerAccountSchema.parse(fields));
}

beforeEach(() => {
  session = Session.new("Teste");
  const ledger = session.ledger;
  const ana = ledger.addMember("Ana").id;
  const bank = account({
    name: "Itaú CC",
    type: AccountType.ASSET,
    subtype: AccountSubtype.CHECKING,
    masked_number: "56789-0",
    holders: [ana],
  });
  account({ name: "Poupança", type: AccountType.ASSET, subtype: AccountSubtype.SAVINGS });
  const liability = account({ name: "Nubank", type: AccountType.LIABILITY, subtype: AccountSubtype.CREDIT_CARD });
  ledger.addCard(
    CardSchema.parse({
      name: "Nubank",
      liability_account_id: liability.id,
      holder_id: ana,
      last4: "0001",
      closing_day: 3,
      due_day: 10,
      settlement_account_id: bank.id,
    }),
  );
});

const bankOf = () => [...session.ledger.accounts.values()].find((a) => a.name === "Itaú CC")!;
const ops = () => [...session.ledger.operations.values()];

describe("pipeline", () => {
  it("test_card_import_review_and_approve", async () => {
    const batch = await imp(session, "nu.pdf", doc("nubank_card.pdf"));
    expect(batch.status).toBe(BatchStatus.IN_REVIEW);
    expect(batch.doc_type).toBe(DocType.CARD_STATEMENT);
    expect(batch.card_id).not.toBeNull(); // the only card was chosen automatically
    expect(batch.reconciliations[0]!.ok).toBe(true);
    const items = pipeline.itemsOf(session.ledger, batch.id);
    expect(items.find((i) => i.description.startsWith("IOF"))!.suggestion_source).toBe("rule"); // never documentary
    const result = pipeline.approve(session.ledger, batch.id);
    expect(result.created).toBe(items.length);
    expect(pipeline.batches(session.ledger).get(batch.id)!.status).toBe(BatchStatus.APPROVED);
    const card = [...session.ledger.cards.values()][0]!;
    // Card debt: purchases + IOF − refund − payment (previous balance was not in the ledger).
    expect(queries.balance(session.ledger, card.liability_account_id).toFixed()).toBe("550.30");
    const op = ops().find((o) => o.description === "Amazon.com")!;
    expect(op.origin.evidence_ids.length).toBeGreaterThan(0);
    expect(op.notes).toContain("USD 20.00");
  });

  it("test_reimport_same_file_is_refused_ta12", async () => {
    await imp(session, "nu.pdf", doc("nubank_card.pdf"));
    await expect(imp(session, "copia.pdf", doc("nubank_card.pdf"))).rejects.toThrow(ImportRefused);
  });

  it("test_pending_items_stay_out_of_results_rf07", async () => {
    await imp(session, "nu.pdf", doc("nubank_card.pdf"));
    expect(ops().some((op) => op.origin.kind === "import")).toBe(false);
  });

  it("test_divergent_total_blocks_approval", async () => {
    const batch = await imp(session, "nu.pdf", doc("nubank_card_divergent.pdf"));
    expect(batch.reconciliations[0]!.ok).toBe(false);
    expect(() => pipeline.approve(session.ledger, batch.id)).toThrow(DomainError);
    pipeline.approve(session.ledger, batch.id, null, { acceptDivergence: "fatura com encargo não listado" });
    expect(pipeline.batches(session.ledger).get(batch.id)!.warnings.at(-1)).toContain("Divergência aceita");
  });

  it("test_partial_approval_requires_reason", async () => {
    const batch = await imp(session, "nu.csv", doc("nubank_account.csv"), { account_id: bankOf().id });
    const first = pipeline.itemsOf(session.ledger, batch.id)[0]!;
    expect(() => pipeline.approve(session.ledger, batch.id, [first.id])).toThrow(DomainError);
    pipeline.approve(session.ledger, batch.id, [first.id], { partialReason: "restante amanhã" });
    expect(pipeline.batches(session.ledger).get(batch.id)!.status).toBe(BatchStatus.PARTIAL);
  });

  it("test_two_equal_legit_purchases_are_kept_ta14", async () => {
    const batch = await imp(session, "nu.csv", doc("nubank_account.csv"), { account_id: bankOf().id });
    pipeline.approve(session.ledger, batch.id);
    expect(ops().filter((o) => o.description.includes("FARMACIA"))).toHaveLength(2);
  });

  it("test_overlapping_statements_link_evidence_ta13", async () => {
    const bank = bankOf();
    const ofxA = enc(new TextDecoder("latin1").decode(doc("bank.ofx")).replaceAll("<FITID>F", "<FITID>A"));
    const first = await imp(session, "jan.ofx", ofxA, { account_id: bank.id });
    pipeline.approve(session.ledger, first.id);
    const opsBefore = session.ledger.operations.size;
    // Same transactions exported again as PDF (different file, no FITID): duplicates by content.
    const second = await imp(session, "jan.pdf", doc("itau_bank.pdf"), { account_id: bank.id });
    const statuses = new Map(pipeline.itemsOf(session.ledger, second.id).map((i) => [i.description, i.status]));
    expect(statuses.get("SALARIO EMPRESA X")).toBe(ItemStatus.DUPLICATE);
    pipeline.approve(session.ledger, second.id);
    const salaryOps = ops().filter((o) => o.description.includes("SALARIO"));
    expect(salaryOps).toHaveLength(1);
    expect(salaryOps[0]!.origin.evidence_ids).toHaveLength(2);
    expect(session.ledger.operations.size).toBe(opsBefore + 3); // aluguel PDF line differs, TED, fatura
  });

  it("test_same_fitid_is_duplicate", async () => {
    const bank = bankOf();
    const ofx = new TextDecoder("latin1").decode(doc("bank.ofx")).replaceAll("<FITID>F", "<FITID>Z");
    const first = await imp(session, "a.ofx", enc(ofx), { account_id: bank.id });
    pipeline.approve(session.ledger, first.id);
    const data = enc(ofx.replace("PIX ALUGUEL", "PIX ALUGUEL REF"));
    const second = await imp(session, "b.ofx", data, { account_id: bank.id });
    expect(pipeline.itemsOf(session.ledger, second.id).every((i) => i.status === ItemStatus.DUPLICATE)).toBe(true);
  });

  it("test_bill_payment_seen_in_bank_and_card_is_one_settlement", async () => {
    const bank = bankOf();
    const card = [...session.ledger.cards.values()][0]!;
    // Bank statement first: the user maps the payment line to the card.
    const batch = await imp(session, "extrato.pdf", doc("itau_bank.pdf"), { account_id: bank.id });
    const payment = pipeline.itemsOf(session.ledger, batch.id).find((i) => i.description.includes("FATURA"))!;
    pipeline.correctItem(session.ledger, payment.id, "target_account_id", card.liability_account_id, "é a fatura");
    pipeline.approve(session.ledger, batch.id);
    const op = session.ledger.operations.get(pipeline.items(session.ledger).get(payment.id)!.operation_id!)!;
    expect(op.kind).toBe(OperationKind.CARD_PAYMENT);
    // The card CSV later shows a payment of the same value: linked, not duplicated.
    const cardBatch = await imp(session, "card.csv", doc("card_payment.csv"), { card_id: card.id });
    const cardItems = new Map(pipeline.itemsOf(session.ledger, cardBatch.id).map((i) => [i.description, i]));
    expect(cardItems.get("Pagamento recebido")!.status).toBe(ItemStatus.DUPLICATE);
    expect(cardItems.get("Pagamento recebido")!.duplicate_of).toBe(op.id);
  });

  it("test_own_transfer_appears_in_both_statements", async () => {
    const bank = bankOf();
    const savings = [...session.ledger.accounts.values()].find((a) => a.name === "Poupança")!;
    const batch = await imp(session, "extrato.pdf", doc("itau_bank.pdf"), { account_id: bank.id });
    const ted = pipeline.itemsOf(session.ledger, batch.id).find((i) => i.description.includes("TED"))!;
    pipeline.correctItem(session.ledger, ted.id, "target_account_id", savings.id, "transferência própria");
    pipeline.approve(session.ledger, batch.id);
    const other = await imp(session, "poup.csv", doc("savings.csv"), { account_id: savings.id });
    const item = pipeline.itemsOf(session.ledger, other.id)[0]!;
    expect(item.status).toBe(ItemStatus.DUPLICATE);
    pipeline.approve(session.ledger, other.id);
    expect(queries.balance(session.ledger, savings.id).toFixed()).toBe("500.00");
    const salary = session.ledger.categories(AccountType.INCOME).find((a) => a.name === "Salário")!.id;
    const income = queries.incomeStatement(session.ledger, ym(2026, 1)).income;
    expect([...income.entries()].map(([k, v]) => [k, v.toFixed()])).toEqual([[salary, "5000.00"]]);
  });

  it("test_correction_keeps_previous_value", async () => {
    const batch = await imp(session, "nu.csv", doc("nubank_account.csv"), { account_id: bankOf().id });
    const item = pipeline.itemsOf(session.ledger, batch.id)[0]!;
    session.ledger.operator = "Ana";
    const fixed = pipeline.correctItem(session.ledger, item.id, "amount", D("1500.01"), "valor no PDF difere");
    expect(fixed.corrections.at(-1)!.before).toBe("1500.00");
    expect(fixed.corrections.at(-1)!.after).toBe("1500.01");
    expect(fixed.corrections.at(-1)!.operator).toBe("Ana");
  });

  it("test_suggestion_learns_from_history", async () => {
    const bank = bankOf();
    const housing = session.ledger.categories(AccountType.EXPENSE).find((a) => a.name === "Moradia")!;
    const ofx = new TextDecoder("latin1").decode(doc("bank.ofx"));
    const batch = await imp(session, "a.ofx", enc(ofx.replaceAll("<FITID>F", "<FITID>H")), { account_id: bank.id });
    const rent = pipeline.itemsOf(session.ledger, batch.id).find((i) => i.description.includes("ALUGUEL"))!;
    pipeline.correctItem(session.ledger, rent.id, "target_account_id", housing.id);
    pipeline.approve(session.ledger, batch.id);
    const data = ofx
      .replaceAll("<FITID>F", "<FITID>J")
      .replaceAll("20260110", "20260210")
      .replaceAll("20260105", "20260205");
    const again = await imp(session, "b.ofx", enc(data), { account_id: bank.id });
    const rent2 = pipeline.itemsOf(session.ledger, again.id).find((i) => i.description.includes("ALUGUEL"))!;
    expect(rent2.target_account_id).toBe(housing.id);
    expect(rent2.suggestion_source).toBe("learned:1/1");
  });

  it("test_unknown_layout_and_scanned_are_kept_as_pending", async () => {
    const unknown = await imp(session, "x.pdf", doc("unknown_layout.pdf"));
    expect(unknown.status).toBe(BatchStatus.UNSUPPORTED);
    const scanned = await imp(session, "scan.pdf", doc("scanned.pdf"));
    expect(scanned.status).toBe(BatchStatus.UNSUPPORTED);
    expect(scanned.warnings[0]).toContain("OCR");
    expect(session.documents).toHaveLength(2); // originals are preserved
  });

  it("test_failure_of_one_file_does_not_affect_others_rf05", async () => {
    const good = await imp(session, "nu.pdf", doc("nubank_card.pdf"));
    await imp(session, "scan.pdf", doc("scanned.pdf"));
    expect(pipeline.batches(session.ledger).get(good.id)!.status).toBe(BatchStatus.IN_REVIEW);
  });

  it("test_brokerage_note_is_not_approved_as_bank_items", async () => {
    const batch = await imp(session, "nota.pdf", doc("sinacor_note.pdf"));
    expect(batch.doc_type).toBe(DocType.BROKERAGE_NOTE);
    expect(batch.reconciliations[0]!.ok).toBe(true);
    expect(() => pipeline.approve(session.ledger, batch.id)).toThrow(DomainError);
  });

  it("test_import_state_survives_save (records and documents round-trip)", async () => {
    const batch = await imp(session, "nu.pdf", doc("nubank_card.pdf"));
    pipeline.approve(session.ledger, batch.id);
    const sent = session.pendingSync();
    const reopened = Session.fromRecords(session.projectId, JSON.parse(JSON.stringify(sent.upserts)), [
      ...sent.documentsAdded,
    ]);
    expect(pipeline.batches(reopened.ledger).get(batch.id)!.status).toBe(BatchStatus.APPROVED);
    expect(pipeline.evidence(reopened.ledger).size).toBe(pipeline.evidence(session.ledger).size);
    expect(reopened.documents[0]!.data).toEqual(doc("nubank_card.pdf"));
  });
});

describe("installment plans (tests/test_finance.py, hook for domain/cards)", () => {
  it("an imported installment of a registered plan is linked, not a new expense", async () => {
    // domain/cards.find_plan_for_installment (W4) registers here; a stand-in answers for one plan.
    const card = [...session.ledger.cards.values()][0]!;
    const groceries = session.ledger.categories(AccountType.EXPENSE).find((a) => a.name === "Alimentação")!;
    const op = session.ledger.recordCardPurchase(card.id, groceries.id, "30.00", makeDate(2026, 1, 20), "Loja Z");
    const asked: unknown[] = [];
    registerInstallmentPlanFinder((_l, cardId, description, number, count, amount) => {
      asked.push([cardId, description, number, count, amount.toFixed()]);
      return description === "Loja Z" ? { plan_id: op.id, operation_id: op.id } : null;
    });
    try {
      const csv = enc("date,title,amount\n2026-01-20,Loja Z - Parcela 2/5,30.00\n2026-02-25,Uber,10.00\n");
      const batch = await imp(session, "c.csv", csv, { card_id: card.id });
      const statuses = new Map(pipeline.itemsOf(session.ledger, batch.id).map((i) => [i.description, i.status]));
      expect(statuses.get("Loja Z")).toBe(ItemStatus.DUPLICATE);
      expect(statuses.get("Uber")).toBe(ItemStatus.READY);
      expect(asked).toEqual([[card.id, "Loja Z", 2, 5, "30.00"]]); // only items with an installment
    } finally {
      registerInstallmentPlanFinder(null);
    }
  });
});
