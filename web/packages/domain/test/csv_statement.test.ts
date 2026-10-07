/** The generic CSV bank statement (`csv-extrato-generico`): columns found by name, any bank. */
import { beforeEach, describe, expect, it } from "vitest";
import { AccountSubtype, AccountType, LedgerAccountSchema } from "../src/domain/model.ts";
import * as queries from "../src/domain/queries.ts";
import { BatchStatus, DocType, ItemKind } from "../src/importing/model.ts";
import { GenericStatementCsv, headerKey, readAmount, readDate } from "../src/importing/parsers/csv_statement.ts";
import * as pipeline from "../src/importing/pipeline.ts";
import { loadStructured } from "../src/importing/source.ts";
import { Session } from "../src/session.ts";
import { doc, extractor } from "./importing_helpers.ts";

const parser = new GenericStatementCsv();
const utf8 = (text: string) => new TextEncoder().encode(text);
/** Windows-1252 for the Latin-1 letters these files use (accents and ç). */
const cp1252 = (text: string) => Uint8Array.from([...text].map((c) => c.codePointAt(0)!));
const parse = (text: string, bytes = utf8) => parser.parse(loadStructured("extrato.csv", bytes(text)));
const rows = (result: ReturnType<typeof parse>) =>
  result.items.map((i) => [i.occurred_on, i.description, i.kind, i.amount?.toFixed(), i.bank_id]);

/** Itaú-like: lines about the account first, Brazilian amounts, an opening balance and daily balances. */
const ITAU = [
  "Extrato de conta corrente",
  "Agência: 1234;Conta: 56789-0",
  "Período: 01/02/2026 a 28/02/2026",
  "",
  "data;lançamento;ag./origem;valor (R$);saldos (R$)",
  "31/01/2026;SALDO ANTERIOR;;;1.000,00",
  "02/02/2026;PIX RECEBIDO EMPRESA Y;;1.500,00;2.500,00",
  "03/02/2026;FARMACIA SAO JOAO;;-89,90;2.410,10",
  "03/02/2026;SALDO DO DIA;;;2.410,10",
  '05/02/2026;=HYPERLINK("x");;-10,10;2.400,00',
].join("\n");

/** Bradesco-like: separate credit and debit columns, a document number, Windows-1252. */
const BRADESCO = [
  "Data;Histórico;Docto.;Crédito (R$);Débito (R$);Saldo (R$)",
  "01/03/2026;Transferência recebida;1001;250,00;;1.250,00",
  "02/03/2026;Conta de luz;1002;;180,35;1.069,65",
  "02/03/2026;Tarifa e estorno;1003;5,00;5,00;1.069,65",
  "Total;;;255,00;185,35;",
].join("\r\n");

describe("reading cells", () => {
  it("names columns without accents, case or punctuation", () => {
    expect(headerKey("Valor (R$)")).toBe("valor r");
    expect(headerKey(" Lançamento ")).toBe("lancamento");
    expect(headerKey("D/C")).toBe("d c");
  });

  it("reads Brazilian and dotted amounts with their sign; anything else is not an amount", () => {
    const comma = (t: string) => readAmount(t, "comma")?.toFixed() ?? null;
    expect(comma("R$ 1.234,56")).toBe("1234.56");
    expect(comma("-1.234,56")).toBe("-1234.56");
    expect(comma("1.234,56-")).toBe("-1234.56");
    expect(comma("(12,00)")).toBe("-12.00");
    expect(comma("12,00 D")).toBe("-12.00");
    expect(comma("12,00 C")).toBe("12.00");
    expect(comma("R$ -3,50")).toBe("-3.50");
    expect(comma("1.234")).toBe("1234");
    expect(comma("abc")).toBeNull();
    expect(comma("1,2,3")).toBeNull();
    expect(comma("")).toBeNull();
    expect(readAmount("-1,234.56", "dot")?.toFixed()).toBe("-1234.56");
    expect(readAmount("1.234,56", "dot")).toBeNull();
  });

  it("reads dates with or without separators' variety; impossible dates are unknown", () => {
    expect(readDate("05/02/2026")).toBe("2026-02-05");
    expect(readDate("5/2/26")).toBe("2026-02-05");
    expect(readDate("05-02-2026")).toBe("2026-02-05");
    expect(readDate("05.02.2026")).toBe("2026-02-05");
    expect(readDate("2026-02-05")).toBe("2026-02-05");
    expect(readDate("2026-02-05 10:31:00")).toBe("2026-02-05");
    expect(readDate("30/02/2026")).toBeNull();
    expect(readDate("ontem")).toBeNull();
  });
});

describe("generic CSV statement", () => {
  it("finds the header under the account lines and keeps balance lines out of the operations", () => {
    const src = loadStructured("extrato.csv", utf8(ITAU));
    expect(parser.detect(src)).toBe(0.7);
    const result = parser.parse(src);
    expect(rows(result)).toEqual([
      ["2026-02-02", "PIX RECEBIDO EMPRESA Y", ItemKind.CREDIT, "1500.00", null],
      ["2026-02-03", "FARMACIA SAO JOAO", ItemKind.DEBIT, "89.90", null],
      // a formula is only text: it is never run, and the export neutralizes it (docs/19)
      ["2026-02-05", '=HYPERLINK("x")', ItemKind.DEBIT, "10.10", null],
    ]);
    expect(result.items.every((i) => i.warnings.length === 0)).toBe(true);
    expect(result.unmapped.map((l) => l.text)).toEqual([
      "31/01/2026,SALDO ANTERIOR,,,1.000,00",
      "03/02/2026,SALDO DO DIA,,,2.410,10",
    ]);
    expect(result.header).toMatchObject({
      account_hint: "56789-0",
      period_start: "2026-02-01",
      period_end: "2026-02-28",
    });
    expect(result.header.opening_balance!.toFixed()).toBe("1000.00");
    expect(result.header.closing_balance!.toFixed()).toBe("2400.00");
  });

  it("reads separate credit and debit columns, a document number and Windows-1252", () => {
    const result = parse(BRADESCO, cp1252);
    expect(rows(result)).toEqual([
      ["2026-03-01", "Transferência recebida", ItemKind.CREDIT, "250.00", "1001"],
      ["2026-03-02", "Conta de luz", ItemKind.DEBIT, "180.35", "1002"],
    ]);
    // a line with both a credit and a debit is not guessed; the total line is not an operation
    expect(result.unmapped.map((l) => l.number)).toEqual([4, 5]);
    expect(result.header.opening_balance!.toFixed()).toBe("1000.00");
    expect(result.header.closing_balance!.toFixed()).toBe("1069.65");
  });

  it("reads dotted amounts with a D/C column, newest first, and checks each printed balance", () => {
    const result = parse(
      [
        "Date,Description,Amount,D/C,Balance",
        "2026-04-03,Mercado,45.10,D,954.90",
        "2026-04-02,Salário,500.00,C,1000.00",
        "2026-04-01,Aluguel,1000.00,D,400.00",
      ].join("\n"),
    );
    expect(rows(result).map((r) => [r[1], r[2], r[3]])).toEqual([
      ["Mercado", ItemKind.DEBIT, "45.10"],
      ["Salário", ItemKind.CREDIT, "500.00"],
      ["Aluguel", ItemKind.DEBIT, "1000.00"],
    ]);
    // read from the oldest line: 1400 − 1000 = 400, + 500 = 900 ≠ 1000 printed, then − 45.10 = 954.90
    expect(result.header.opening_balance!.toFixed()).toBe("1400.00");
    expect(result.header.closing_balance!.toFixed()).toBe("954.90");
    expect(result.items[1]!.warnings).toEqual([
      "O saldo da linha (1000.00) não confere com o saldo anterior mais o valor (900.00).",
    ]);
    expect(result.items[0]!.warnings).toEqual([]);
  });

  it("gives a date without year the year of the document's own dates, never the clock's", () => {
    const withYear = parse(["Data;Descrição;Valor", "28/12;Presente;-50,00", "03/01/2026;Padaria;-8,00"].join("\n"));
    expect(withYear.items[0]!.occurred_on).toBe("2025-12-28");
    const without = parse(["Data;Descrição;Valor", "28/12;Presente;-50,00"].join("\n"));
    expect(without.items[0]!.occurred_on).toBeNull();
    expect(without.items[0]!.warnings).toEqual(["Data sem ano e sem outra data no documento."]);
  });

  it("an amount it cannot read, a zero or a line without description is unmapped, never zero", () => {
    const result = parse(
      [
        "Data;Descrição;Valor",
        "01/02/2026;Algo;abc",
        "02/02/2026;Nada;0,00",
        "03/02/2026;;-5,00",
        "04/02/2026;Ok;-5,00",
      ].join("\n"),
    );
    expect(rows(result).map((r) => r[1])).toEqual(["Ok"]);
    expect(result.unmapped.map((l) => l.number)).toEqual([2, 3, 4]);
  });

  it("does not recognize a file without a date, a description and an amount", () => {
    const src = (text: string) => loadStructured("x.csv", utf8(text));
    expect(parser.detect(src("Nome;Telefone\nAna;1234"))).toBe(0);
    expect(parser.detect(src("Data;Valor\n01/02/2026;10,00"))).toBe(0);
    expect(parser.detect(src("Data;Descrição;Valor\nsem data;x;1,00"))).toBe(0);
    expect(() => parser.parse(src("Nome;Telefone\nAna;1234"))).toThrow();
  });

  it("leaves Nubank's files to Nubank's layouts (no ambiguity)", () => {
    for (const [name, id] of [
      ["nubank_account.csv", "nubank-conta-csv"],
      ["nubank_card.csv", "nubank-cartao-csv"],
    ] as const) {
      const [chosen, candidates] = pipeline.chooseParser(loadStructured(name, doc(name)));
      expect([chosen?.id, candidates]).toEqual([id, []]);
    }
  });
});

describe("importing a generic CSV statement", () => {
  let session: Session;
  beforeEach(() => {
    session = Session.new("Teste");
    const ana = session.ledger.addMember("Ana").id;
    session.ledger.addAccount(
      LedgerAccountSchema.parse({
        name: "Itaú CC",
        type: AccountType.ASSET,
        subtype: AccountSubtype.CHECKING,
        masked_number: "56789-0",
        holders: [ana],
      }),
    );
  });
  const bank = () => [...session.ledger.accounts.values()].find((a) => a.name === "Itaú CC")!;

  it("finds the account by its number, reconciles the balances and approves into operations", async () => {
    const batch = await pipeline.importDocument(session, { name: "itau.csv", data: utf8(ITAU) }, extractor);
    expect(batch.parser_id).toBe("csv-extrato-generico");
    expect(batch.doc_type).toBe(DocType.BANK_STATEMENT);
    expect(batch.account_id).toBe(bank().id);
    expect(batch.reconciliations.map((r) => [r.expected?.toFixed(), r.computed?.toFixed(), r.ok])).toEqual([
      ["2400.00", "2400.00", true],
    ]);
    const result = pipeline.approve(session.ledger, batch.id);
    expect(result.created).toBe(3);
    expect(pipeline.batches(session.ledger).get(batch.id)!.status).toBe(BatchStatus.APPROVED);
    // the opening balance was not in the ledger: only the operations of the file move it
    expect(queries.balance(session.ledger, bank().id).toFixed()).toBe("1400.00");
  });

  it("a printed balance that does not add up blocks approval until accepted with a reason", async () => {
    const wrong = ITAU.replace("2.400,00", "2.500,00");
    const batch = await pipeline.importDocument(session, { name: "itau.csv", data: utf8(wrong) }, extractor);
    expect(batch.reconciliations[0]!.ok).toBe(false);
    expect(() => pipeline.approve(session.ledger, batch.id)).toThrow();
    pipeline.approve(session.ledger, batch.id, null, { acceptDivergence: "tarifa fora do arquivo" });
    expect(pipeline.batches(session.ledger).get(batch.id)!.status).toBe(BatchStatus.APPROVED);
  });

  it("the same file twice is refused, as any document", async () => {
    await pipeline.importDocument(session, { name: "itau.csv", data: utf8(ITAU) }, extractor);
    await expect(pipeline.importDocument(session, { name: "copia.csv", data: utf8(ITAU) }, extractor)).rejects.toThrow(
      pipeline.ImportRefused,
    );
  });
});
