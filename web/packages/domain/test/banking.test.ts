/**
 * Bank accounts (bank, branch, number, holders, parts), values at a date and investment
 * characteristics, with the embedded lists (COMPE banks, IRPF codes). Port of `tests/test_banking.py`.
 *
 * Not ported here: `test_maturity_shows_in_the_calendar_and_alerts` (needs `domain/agenda` and
 * `domain/alerts`). The conferência of `record_values` is checked through a test recorder until
 * `domain/balance_checks` is wired (TODO(W5-integration)).
 */
import { afterEach, describe, expect, it } from "vitest";

import { bank, banks, search } from "../src/catalogs/catalogs.ts";
import { ASSET_CODES, CHECKING, investmentCodes, isAssetCode, SAVINGS } from "../src/catalogs/irpf.ts";
import * as banking from "../src/domain/banking.ts";
import { DomainError, Ledger } from "../src/domain/ledger.ts";
import { AccountSubtype } from "../src/domain/model.ts";
import * as queries from "../src/domain/queries.ts";
import type { IsoDate } from "../src/lib/dates.ts";
import { Dec } from "../src/lib/dec.ts";
import type { Id } from "../src/lib/ids.ts";
import { AssetClass } from "../src/investments/model.ts";
import * as prof from "../src/investments/profile.ts";
import * as inv from "../src/investments/service.ts";
import * as declaration from "../src/tax/declaration.ts";
import * as ids from "../src/tax/ids.ts";
import { IncomeNature, NatureSubject, TaxSubject } from "../src/tax/model.ts";
import * as records from "../src/tax/records.ts";
import { family, type Family } from "./fixtures.ts";

const d = (s: string) => s as IsoDate;
const TODAY = d("2026-10-05");

afterEach(() => banking.setBalanceCheckRecorder(null));

describe("embedded lists", () => {
  it("the bank list is complete and consistent", () => {
    const listed = banks();
    expect(listed.length).toBeGreaterThan(400);
    expect(new Set(listed.map((b) => b.code)).size).toBe(listed.length);
    expect(listed.every((b) => b.code.length === 3 && /^\d+$/.test(b.code))).toBe(true);
    expect(listed.every((b) => !b.cnpj || ids.isCnpj(b.cnpj))).toBe(true);
    expect(bank("341")?.cnpj).toBe("60701190000104");
    expect(bank("1")?.code).toBe("001");
    expect(search("nu pagamentos").some((b) => b.code === "260")).toBe(true);
    const unknown = bank("999");
    expect(unknown === null || unknown.code === "999").toBe(true);
  });

  it("IRPF codes", () => {
    expect([...CHECKING]).toEqual(["06", "01"]);
    expect([...SAVINGS]).toEqual(["04", "01"]);
    expect(isAssetCode("04", "02") && isAssetCode("07", "03") && isAssetCode("99", "06")).toBe(true);
    expect(isAssetCode("04", "77")).toBe(false);
    expect(new Set(ASSET_CODES.keys())).toEqual(new Set(["01", "02", "03", "04", "05", "06", "07", "08", "99"]));
    const savingsName = ASSET_CODES.get("04")![1].get("01")!;
    expect(investmentCodes().some(([g, c, n]) => g === "04" && c === "01" && n === savingsName)).toBe(false);
  });
});

function makeBank(f: Family, options: { joint?: boolean; savings?: boolean } = {}) {
  const item = banking.build({
    name: "Itaú da Ana",
    bank_code: "341",
    bank_name: null,
    branch: "0123",
    number: "45678-X",
    holder_id: f.ana,
    co_holder_id: options.joint ? f.bruno : null,
  });
  return banking.create(f.ledger, item, {
    checking: true,
    savings: options.savings ?? true,
    opening: new Map([[banking.Part.CHECKING, [Dec.from("1000.00"), d("2025-01-02")] as const]]),
  });
}

describe("bank accounts", () => {
  it("creates its parts with holders and the bank's CNPJ", () => {
    const f = family();
    const item = makeBank(f, { joint: true });
    const ledger = f.ledger;
    expect(item.bank_name).toBe("ITAÚ UNIBANCO S.A.");
    expect(banking.where(item)).toBe("ITAÚ UNIBANCO S.A. (341), ag. 0123, conta 45678-X");
    const checking = ledger.account(item.checking_id!);
    const savings = ledger.account(item.savings_id!);
    expect(checking.subtype).toBe(AccountSubtype.CHECKING);
    expect(savings.subtype).toBe(AccountSubtype.SAVINGS);
    expect(checking.holders).toEqual([f.ana, f.bruno]); // first holder first
    expect(queries.balance(ledger, checking.id, d("2025-01-31")).eq("1000.00")).toBe(true);
    expect(records.identity(ledger, TaxSubject.ACCOUNT, checking.id)?.tax_id).toBe("60701190000104");
    const rows = new Map(declaration.assets(ledger, 2025).map((r) => [r.ref, r]));
    const row = rows.get(checking.id)!;
    expect([row.group, row.code, row.suggested]).toEqual(["06", "01", false]);
    expect(row.description).toContain("ag. 0123");
  });

  it("rules", () => {
    const f = family();
    const build = (fields: Partial<banking.BuildFields>) =>
      banking.build({
        name: "x",
        bank_code: "341",
        bank_name: null,
        branch: "1",
        number: "1",
        holder_id: f.ana,
        ...fields,
      });
    expect(() => build({ branch: "01 23" })).toThrow(DomainError);
    expect(() => build({ bank_code: "000" })).toThrow(DomainError);
    const item = build({ name: "", bank_code: null, bank_name: "Cooperativa Local", branch: "A1/b", number: "#9" });
    expect([item.bank_code, item.branch, item.number]).toEqual([null, "A1/b", "#9"]);
    const same = build({ co_holder_id: f.ana });
    expect(() => banking.create(f.ledger, same, { checking: true })).toThrow(DomainError);
    const first = makeBank(f, { savings: false });
    const other = build({ name: "y", bank_code: "001", number: "2" });
    // one ledger account belongs to one bank account
    expect(() => banking.create(f.ledger, other, { checking: first.checking_id! })).toThrow(DomainError);
    const updated = banking.update(f.ledger, { ...first, co_holder_id: f.bruno }, [banking.Part.SAVINGS]);
    expect(updated.savings_id).not.toBeNull();
    expect(f.ledger.account(updated.checking_id!).holders).toEqual([f.ana, f.bruno]);
  });

  it("values at a date: check, adjust and value investments", () => {
    const f = family();
    const ledger = f.ledger;
    const checks: { account: Id; informed: Dec }[] = [];
    banking.setBalanceCheckRecorder((_l, account, _on, informed) => checks.push({ account, informed }));
    const item = makeBank(f);
    const pos = inv.createPosition(ledger, "CDB Itaú", AssetClass.FIXED_INCOME, d("2025-02-01"), {
      initial_cost: "5000",
      from_account: item.checking_id,
    });
    prof.saveProfile(
      ledger,
      prof.InvestmentProfileSchema.parse({
        position_id: pos.id,
        bank_account_id: item.id,
        irpf_group: "04",
        irpf_code: "02",
      }),
    );
    expect(banking.positionsOf(ledger, item.id)).toEqual([pos.id]);
    const checking = item.checking_id!;
    const savings = item.savings_id!;
    const on = d("2025-06-30");
    const values = () => new Map(banking.valuesAt(ledger, item.id, on).map((v) => [v.ref, v.value]));
    const before = values();
    expect(before.get(checking)!.eq("-4000.00") && before.get(savings)!.isZero()).toBe(true);
    const done = banking.recordValues(
      ledger,
      item.id,
      on,
      new Map<Id, unknown>([
        [checking, "2500.00"],
        [savings, "300.00"],
        [pos.id, "5210.00"],
      ]),
      TODAY,
      { adjust: new Set([savings]) },
    );
    expect([done.checks, done.adjustments, done.valuations]).toEqual([2, 1, 1]);
    const after = values();
    expect(after.get(savings)!.eq("300.00")).toBe(true); // adjusted: reports and net worth follow
    expect(after.get(checking)!.eq("-4000.00")).toBe(true); // only checked: the difference stays visible
    expect(after.get(pos.id)!.eq("5210.00")).toBe(true);
    const check = checks.find((c) => c.account === checking)!;
    expect(check.informed.sub(queries.balance(ledger, checking, on)).eq("6500.00")).toBe(true);
    banking.recordValues(ledger, item.id, on, new Map([[pos.id, "5300.00"]]), TODAY); // corrected, not duplicated
    expect(values().get(pos.id)!.eq("5300.00")).toBe(true);
    expect(() => banking.recordValues(ledger, item.id, d("2999-01-01"), new Map([[pos.id, "1"]]), TODAY)).toThrow(
      DomainError,
    );
  });

  it("investment characteristics feed the tax sheets", () => {
    const f = family();
    const ledger = f.ledger;
    const item = makeBank(f);
    const pos = inv.createPosition(ledger, "LCA Banco X", AssetClass.FIXED_INCOME, d("2025-02-01"), {
      initial_cost: "3000",
      from_account: item.checking_id,
    });
    const saved = prof.saveProfile(
      ledger,
      prof.InvestmentProfileSchema.parse({
        position_id: pos.id,
        bank_account_id: item.id,
        irpf_group: "04",
        irpf_code: "03",
        issuer: "Banco X S.A.",
        issuer_tax_id: "11222333000181",
        indexer: prof.Indexer.CDI,
        rate: "95",
        applied_on: "2025-02-01",
        maturity: "2027-02-01",
        liquidity: prof.Liquidity.AT_MATURITY,
        tax: prof.TaxTreatment.EXEMPT,
        income_code: "isento:12",
        fgc: true,
      }),
    );
    expect(prof.yieldText(saved)).toBe("95% do CDI");
    expect(records.natureOf(ledger, NatureSubject.POSITION, pos.id)).toBe(IncomeNature.EXEMPT);
    const row = declaration.assets(ledger, 2025).find((r) => r.ref === pos.id)!;
    expect([row.group, row.code, row.suggested]).toEqual(["04", "03", false]);
    for (const text of ["Banco X S.A.", "95% do CDI", "ag. 0123"]) expect(row.description).toContain(text);
    expect(row.tax_id).toBe("60701190000104"); // the custodian bank, from the COMPE list
    inv.distribute(ledger, pos.id, "40.00", d("2025-08-01"), item.checking_id!);
    const other = declaration.income(ledger, 2025).other;
    expect(other).toHaveLength(1);
    expect(other[0]!.nature).toBe(IncomeNature.EXEMPT);
    expect(other[0]!.code).toBe("12");
    expect(() => prof.saveProfile(ledger, { ...saved, irpf_code: "77" })).toThrow(DomainError);
    expect(() => prof.saveProfile(ledger, { ...saved, income_code: "isento:99" })).toThrow(DomainError);
    expect(prof.classFor("07", "03")).toBe(AssetClass.REIT);
    expect(prof.classFor("03", "01")).toBe(AssetClass.STOCK);
  });

  it("bank records survive save", () => {
    const f = family();
    const item = makeBank(f);
    const restored = Ledger.fromRecords(JSON.parse(JSON.stringify(f.ledger.toRecords())));
    expect(banking.bankAccounts(restored).get(item.id)?.number).toBe("45678-X");
  });
});
