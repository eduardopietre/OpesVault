/** Deliberate exports (RF-20). Port of `tests/test_exports.py`. */
import { describe, expect, it } from "vitest";

import { Ledger, type LedgerRecord } from "../src/domain/ledger.ts";
import { dump } from "../src/domain/model.ts";
import { Dec } from "../src/lib/dec.ts";
import type { IsoDate } from "../src/lib/dates.ts";
import { interchangeJson, isoNow, ledgerCsv } from "../src/exports.ts";
import { family } from "./fixtures.ts";

const d = (s: string) => s as IsoDate;

/** `csv.DictReader(..., delimiter=";")` over text with the quoting `ledgerCsv` writes. */
function readCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [[]];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ";") {
      rows.at(-1)!.push(field);
      field = "";
    } else if (c === "\n") {
      rows.at(-1)!.push(field);
      field = "";
      rows.push([]);
    } else field += c;
  }
  rows.pop();
  const [header = [], ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

describe("exports", () => {
  it("the ledger CSV re-balances", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.bank, "1000.00", d("2026-01-01"));
    f.ledger.recordCardPurchase(f.card, f.groceries, "99.99", d("2026-01-05"), "Mercado; com ponto e vírgula");
    const bytes = ledgerCsv(f.ledger);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM, so spreadsheets read UTF-8
    const rows = readCsv(new TextDecoder("utf-8").decode(bytes.slice(3)));
    expect(rows.reduce((sum, r) => sum.add(Dec.parse(r["valor"]!)), Dec.from(0)).isZero()).toBe(true);
    expect(rows.some((r) => r["descricao"] === "Mercado; com ponto e vírgula")).toBe(true);
  });

  it("the interchange round-trips the entities", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.bank, "1000.00", d("2026-01-01"));
    const payload = JSON.parse(new TextDecoder().decode(interchangeJson(f.ledger, isoNow(new Date())))) as {
      formato: string;
      versao_formato: number;
      entidades: { id: string; tipo: string; dados: Record<string, unknown> }[];
    };
    expect(payload.formato).toBe("opesvault-intercambio");
    expect(payload.versao_formato).toBe(1);
    const rows: LedgerRecord[] = payload.entidades.map((e) => ({ id: e.id, kind: e.tipo, payload: e.dados }));
    const restored = Ledger.fromRecords(rows);
    expect([...restored.operations.values()].map(dump)).toEqual([...f.ledger.operations.values()].map(dump));
  });

  it("the timestamp is Python's isoformat in UTC", () => {
    expect(isoNow(new Date("2026-10-05T12:00:00.000Z"))).toBe("2026-10-05T12:00:00+00:00");
    expect(isoNow(new Date("2026-10-05T12:00:00.123Z"))).toBe("2026-10-05T12:00:00.123000+00:00");
  });
});
