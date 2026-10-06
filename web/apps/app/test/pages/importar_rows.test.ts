/**
 * Importar e revisar without React: the words the review uses, the rows of the queue and of the items, the
 * verdict of each check and the evidence box as a share of the page.
 */
import { Dec, demoSession, importing, type IsoDate } from "@opesvault/domain";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_TARGET,
  ITEM_STATUS_LABELS,
  KIND_LABELS,
  STATUS_LABELS,
  batchRows,
  boxStyle,
  evidenceOf,
  factsLine,
  itemNotes,
  itemRows,
  needsLayout,
  queueContext,
  sourceLabel,
  targetOptions,
  totalCheck,
  verdicts,
  waitingItems,
} from "../../src/pages/importar/rows.ts";

type Session = Awaited<ReturnType<typeof demoSession>>;
let session: Session;
beforeAll(async () => {
  session = await demoSession();
});

const { BatchStatus, ItemKind, ItemStatus } = importing.importModel;

describe("the words of the review", () => {
  it("names every state of a document, of an item and every kind of item", () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual(Object.values(BatchStatus).sort());
    expect(Object.keys(ITEM_STATUS_LABELS).sort()).toEqual(Object.values(ItemStatus).sort());
    expect(Object.keys(KIND_LABELS).sort()).toEqual(Object.values(ItemKind).sort());
    expect(STATUS_LABELS[BatchStatus.AMBIGUOUS]).toBe("Escolher layout");
    expect(ITEM_STATUS_LABELS[ItemStatus.DUPLICATE]).toBe("Já registrado");
    expect(KIND_LABELS[ItemKind.CARD_CREDIT]).toBe("Crédito/estorno");
  });

  it("says where a suggested category came from, in the person's words", () => {
    expect(sourceLabel("learned:3/3")).toBe("sugestão (aprendida: 3 escolha(s) iguais)");
    expect(sourceLabel("learned:3/4")).toBe("sugestão (aprendida: 3 de 4 escolhas recentes)");
    expect(sourceLabel("user_rule:abc")).toBe("sugestão (sua regra)");
    expect(sourceLabel("ollama:gemma4:12b:p4@abc123")).toBe("sugestão (IA local, gemma4:12b)");
    expect(sourceLabel("history")).toBe("sugestão (histórico)");
    expect(sourceLabel("rule")).toBe("sugestão (regra padrão)");
    expect(sourceLabel("outra")).toBe("sugestão (outra)");
  });

  it("puts the warnings, the installment, the card, the origin and the duplicate notice in the notes of an item", () => {
    const base = [...importing.pipeline.items(session.ledger).values()][0]!;
    const item = {
      ...base,
      warnings: ["Valor lido com ressalva."],
      installment: [2, 5] as [number, number],
      foreign_amount: Dec.parse("10.50"),
      foreign_currency: "USD",
      card_last4: "1234",
      suggestion_source: "learned:3/3",
      status: ItemStatus.DUPLICATE,
    };
    expect(itemNotes(item)).toBe(
      "Valor lido com ressalva.; parcela 2/5; USD 10.50; cartão final 1234; sugestão (aprendida: 3 escolha(s) iguais); " +
        "já existe no livro: aprovar só vincula a evidência",
    );
    expect(
      itemNotes({
        ...base,
        warnings: [],
        installment: null,
        foreign_amount: null,
        card_last4: null,
        suggestion_source: null,
        status: ItemStatus.READY,
      }),
    ).toBe("");
  });
});

describe("the queue", () => {
  it("has a row per document, newest first, with its institution, state and what waits for review", () => {
    const rows = batchRows(session.ledger, session.documents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "fatura-nubank-03.pdf",
      institution: "Nubank",
      status: BatchStatus.IN_REVIEW,
    });
    expect(rows[0]!.pending).toBe(rows[0]!.items);
    expect(waitingItems(session.ledger)).toBe(rows[0]!.pending);
    expect(queueContext(rows, 8)).toBe("1 documento(s) · 8 item(ns) aguardando revisão");
    expect(queueContext([], 0)).toBe("");
  });

  it("flags a total that diverges in the state, and reads the verdict of each check in words", () => {
    const batch = [...importing.pipeline.batches(session.ledger).values()][0]!;
    expect(totalCheck(batch)).toBe("ok");
    const diverging = {
      ...batch,
      reconciliations: [
        { label: "Soma dos itens", expected: Dec.parse("10"), computed: Dec.parse("12.5"), ok: false },
        { label: "Saldo final", expected: null, computed: Dec.parse("1"), ok: null },
        { label: "Pagamentos", expected: Dec.parse("3"), computed: Dec.parse("3"), ok: true },
      ],
    };
    expect(totalCheck(diverging)).toBe("divergent");
    expect(verdicts(diverging).map((v) => [v.label, v.verdict, v.tone])).toEqual([
      ["Soma dos itens", "diverge", "negative"],
      ["Saldo final", "não comparável", "neutral"],
      ["Pagamentos", "confere", "positive"],
    ]);
    expect(verdicts(diverging)[1]!.expected).toBe("—");
    expect(totalCheck({ ...batch, reconciliations: [{ label: "x", expected: null, computed: null, ok: null }] })).toBe(
      "incomparable",
    );
    expect(totalCheck({ ...batch, reconciliations: [] })).toBe("none");
  });

  it("writes one line of facts and knows which documents need a layout", () => {
    const batch = [...importing.pipeline.batches(session.ledger).values()][0]!;
    const line = factsLine(batch);
    expect(line).toContain("Nubank");
    expect(line).toContain("Em revisão");
    expect(line).toContain(`layout ${batch.parser_id} v${batch.parser_version}`);
    expect(line).toMatch(/vencimento \d{2}\/\d{2}\/\d{4}/);
    expect(factsLine({ ...batch, header: { ...batch.header, institution: null } })).toContain(
      "Instituição não identificada",
    );
    expect(needsLayout({ ...batch, status: BatchStatus.AMBIGUOUS })).toBe(true);
    expect(needsLayout({ ...batch, status: BatchStatus.UNSUPPORTED })).toBe(true);
    expect(needsLayout(batch)).toBe(false);
  });
});

describe("the items", () => {
  it("lists a document's items by date, with unknown dates last, and says which can still get a category", () => {
    const batch = [...importing.pipeline.batches(session.ledger).values()][0]!;
    const rows = itemRows(session.ledger, batch.id);
    const dates = rows.map((r) => r.date).filter((d): d is IsoDate => d !== null);
    expect(dates).toEqual([...dates].sort());
    expect(rows.every((r) => r.editable)).toBe(true);
    const padaria = rows.find((r) => r.description === "Padaria")!;
    expect(padaria.targetName).toBe("Alimentação");
    expect(padaria.notes).toContain("sugestão (regra padrão)");
    const eletro = rows.find((r) => r.description === "Loja Eletro")!;
    expect(eletro.targetName).toBe("—");
  });

  it("offers each kind of item the categories and accounts it can go to, led by the default", () => {
    const ledger = session.ledger;
    const labels = (kind: Parameters<typeof targetOptions>[1]) => targetOptions(ledger, kind).map((o) => o.label);
    expect(targetOptions(ledger, ItemKind.PURCHASE)[0]).toEqual({ id: DEFAULT_TARGET, label: "(padrão)" });
    expect(labels(ItemKind.PURCHASE).some((l) => l.startsWith("↔"))).toBe(false);
    expect(labels(ItemKind.DEBIT).some((l) => l.startsWith("↔"))).toBe(true);
    expect(labels(ItemKind.DEBIT)).toContain("Alimentação");
    expect(labels(ItemKind.CREDIT)).toContain("Salário");
    expect(labels(ItemKind.CREDIT)).not.toContain("Alimentação");
    // a card payment goes to an account, never to a category
    const payment = labels(ItemKind.CARD_PAYMENT).slice(1);
    expect(payment.length).toBeGreaterThan(0);
    expect(payment.every((l) => l.startsWith("↔"))).toBe(true);
  });

  it("finds the evidence of an item: a page and a box for a PDF", () => {
    const batch = [...importing.pipeline.batches(session.ledger).values()][0]!;
    const item = importing.pipeline.itemsOf(session.ledger, batch.id)[0]!;
    const found = evidenceOf(session.ledger, item)!;
    expect(found.page).toBe(1);
    expect(found.box).toHaveLength(4);
    expect(found.text.length).toBeGreaterThan(0);
    expect(evidenceOf(session.ledger, { ...item, evidence_ids: [] })).toBeNull();
  });
});

describe("the evidence box", () => {
  const page = { width: 600, height: 800 };

  it("is a share of the page, with a little air around the text", () => {
    expect(boxStyle([60, 80, 300, 100], page)).toEqual({
      left: "9.667%",
      top: "9.750%",
      width: "40.667%",
      height: "3.000%",
    });
  });

  it("never leaves the page", () => {
    const style = boxStyle([0, 0, 600, 800], page);
    expect(style).toEqual({ left: "0.000%", top: "0.000%", width: "100.000%", height: "100.000%" });
  });
});
