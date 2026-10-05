/** Port of the ledger cases in `tests/test_domain_ledger.py` and `tests/test_member_role.py`. */
import { describe, expect, it } from "vitest";

import { DomainError, Ledger, SCHEMA_VERSION } from "../src/domain/ledger.ts";
import {
  AccountSubtype,
  AccountType,
  CardSchema,
  cashDate,
  competence,
  HistoryAction,
  isActive,
  LedgerAccountSchema,
  MemberRole,
  operation,
  OperationKind,
  OperationStatus,
} from "../src/domain/model.ts";
import { allocate } from "../src/domain/money.ts";
import * as queries from "../src/domain/queries.ts";
import { type IsoDate, ym } from "../src/lib/dates.ts";
import { Dec } from "../src/lib/dec.ts";
import { newId } from "../src/lib/ids.ts";
import { category, family } from "./fixtures.ts";

const JAN = ym(2026, 1);
const FEB = ym(2026, 2);
const d = (s: string) => s as IsoDate;
const D = (s: string) => Dec.parse(s);
const p = (account_id: string, amount: string, member_id: string | null = null) => ({
  account_id,
  amount: D(amount),
  member_id,
});

describe("invariants", () => {
  it("rejects an unbalanced operation", () => {
    const f = family();
    expect(() =>
      f.ledger.addOperation(
        operation({
          kind: OperationKind.OTHER,
          description: "x",
          postings: [p(f.bank, "10"), p(f.groceries, "-9.99")],
        }),
      ),
    ).toThrow(DomainError);
  });

  it("rejects fractions of a cent and unknown accounts", () => {
    const f = family();
    expect(() => f.ledger.recordExpense(f.bank, f.groceries, "10.001", d("2026-01-05"), "x")).toThrow(DomainError);
    expect(() => f.ledger.recordExpense(f.bank, newId(), "10", d("2026-01-05"), "x")).toThrow(DomainError);
  });

  it("rejects floats in postings", () => {
    expect(() =>
      operation({ kind: OperationKind.OTHER, description: "x", postings: [{ account_id: newId(), amount: 0.1 }] }),
    ).toThrow();
  });

  it("opening balance is equity, not income", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.bank, "1000.00", d("2026-01-01"));
    expect(queries.incomeStatement(f.ledger, JAN).totalIncome.isZero()).toBe(true);
    expect(queries.balance(f.ledger, f.bank).toFixed()).toBe("1000.00");
    expect(queries.netWorth(f.ledger).net.toFixed()).toBe("1000.00");
  });

  it("opening balance of a card is a debt", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.card_account, "300.00", d("2026-01-01"));
    expect(queries.netWorth(f.ledger).liabilities.toFixed()).toBe("300.00");
  });
});

describe("accounting scenarios (docs/08)", () => {
  it("card purchase and bill payment (TA-15)", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.bank, "1000.00", d("2026-01-01"));
    f.ledger.recordCardPurchase(f.card, f.groceries, "100.00", d("2026-01-05"), "Mercado");
    f.ledger.recordCardPayment(f.card, f.bank, "100.00", d("2026-02-10"));
    const byCat = queries.expensesByCategory(f.ledger, JAN, FEB);
    expect([...byCat].map(([k, v]) => [k, v.toFixed()])).toEqual([[f.groceries, "100.00"]]);
    expect(queries.balance(f.ledger, f.card_account).isZero()).toBe(true);
    expect(queries.balance(f.ledger, f.bank).toFixed()).toBe("900.00");
    const flows = queries.cashFlow(f.ledger, JAN, FEB);
    expect(flows.get("2026-01")!.outflow.isZero()).toBe(true); // the purchase did not touch cash
    expect(flows.get("2026-02")!.outflow.toFixed()).toBe("100.00");
  });

  it("own transfer (TA-16)", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.bank, "1000.00", d("2026-01-01"));
    f.ledger.recordTransfer(f.bank, f.savings, "500.00", d("2026-01-15"));
    expect(queries.incomeStatement(f.ledger, JAN).totalIncome.isZero()).toBe(true);
    expect(queries.netWorth(f.ledger).net.toFixed()).toBe("1000.00");
    const flows = queries.cashFlow(f.ledger, JAN, JAN);
    expect(flows.get("2026-01")!.inflow.isZero() && flows.get("2026-01")!.outflow.isZero()).toBe(true);
    // Seen from the bank account alone, the transfer is an outflow.
    expect(queries.cashFlow(f.ledger, JAN, JAN, [f.bank]).get("2026-01")!.outflow.toFixed()).toBe("500.00");
  });

  it("joint account counts once (TA-18)", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.joint, "2000.00", d("2026-01-01"));
    expect(queries.netWorth(f.ledger).assets.toFixed()).toBe("2000.00");
  });

  it("rateio by member", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.joint, "2000.00", d("2026-01-01"));
    const [anaPart, brunoPart] = allocate(D("100.01"), [D("1"), D("1")]);
    f.ledger.addOperation(
      operation({
        kind: OperationKind.EXPENSE,
        description: "Mercado",
        postings: [
          { account_id: f.groceries, amount: anaPart!, member_id: f.ana },
          { account_id: f.groceries, amount: brunoPart!, member_id: f.bruno },
          p(f.joint, "-100.01"),
        ],
        occurred_on: d("2026-01-03"),
      }),
    );
    const total = queries.incomeStatement(f.ledger, JAN).totalExpense;
    const ana = queries.incomeStatement(f.ledger, JAN, f.ana).totalExpense;
    const bruno = queries.incomeStatement(f.ledger, JAN, f.bruno).totalExpense;
    expect(total.toFixed()).toBe("100.01");
    expect(ana.add(bruno).eq(total)).toBe(true);
  });

  it("split must sum the total", () => {
    const f = family();
    const housing = category(f.ledger, "Moradia");
    expect(() =>
      f.ledger.recordExpense(
        f.bank,
        [
          [f.groceries, "10"],
          [housing, "5"],
        ],
        "20",
        d("2026-01-01"),
        "x",
      ),
    ).toThrow(DomainError);
    const op = f.ledger.recordExpense(
      f.bank,
      [
        [f.groceries, "10"],
        [housing, "5"],
      ],
      "15",
      d("2026-01-01"),
      "x",
    );
    expect(op.postings).toHaveLength(3);
  });

  it("salary income and competence", () => {
    const f = family();
    f.ledger.recordIncome(f.bank, f.salary, "5000.00", d("2026-02-05"), "Salário", { accrual_month: JAN });
    expect(queries.incomeStatement(f.ledger, JAN).totalIncome.toFixed()).toBe("5000.00");
    expect(queries.incomeStatement(f.ledger, FEB).totalIncome.isZero()).toBe(true);
    expect(queries.cashFlow(f.ledger, FEB, FEB).get("2026-02")!.inflow.toFixed()).toBe("5000.00");
  });

  it("does not fill an unknown date", () => {
    const f = family();
    const op = f.ledger.addOperation(
      operation({
        kind: OperationKind.EXPENSE,
        description: "sem data",
        postings: [p(f.groceries, "5"), p(f.bank, "-5")],
      }),
    );
    expect(cashDate(op)).toBeNull();
    expect(competence(op)).toBeNull();
    expect(queries.balance(f.ledger, f.bank, d("2030-01-01")).isZero()).toBe(true);
  });
});

describe("history and corrections (RF-22)", () => {
  it("a correction keeps the previous version and the reason", () => {
    const f = family();
    f.ledger.operator = "Ana";
    const op = f.ledger.recordExpense(f.bank, f.groceries, "10.00", d("2026-01-01"), "Padaria");
    const fixed = { ...op, postings: [p(f.groceries, "12.00"), p(f.bank, "-12.00")] };
    expect(() => f.ledger.updateOperation(fixed, " ")).toThrow(DomainError);
    f.ledger.updateOperation(fixed, "valor errado");
    const entries = f.ledger.historyOf(op.id);
    expect(entries.map((e) => e.action)).toEqual([HistoryAction.CREATE, HistoryAction.UPDATE]);
    expect(entries[1]!.reason).toBe("valor errado");
    expect(entries[1]!.operator).toBe("Ana");
    expect(entries[1]!.before!["postings"]).toEqual([
      { account_id: f.groceries, amount: "10.00", member_id: null },
      { account_id: f.bank, amount: "-10.00", member_id: null },
    ]);
    expect(f.ledger.operations.get(op.id)!.version).toBe(2);
  });

  it("cancel and reverse", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.bank, "100.00", d("2026-01-01"));
    const op = f.ledger.recordExpense(f.bank, f.groceries, "10.00", d("2026-01-02"), "x");
    f.ledger.reverseOperation(op.id, d("2026-01-03"), "compra devolvida");
    expect(queries.balance(f.ledger, f.bank).toFixed()).toBe("100.00");
    expect(() => f.ledger.cancelOperation(op.id, "")).toThrow(DomainError);
    f.ledger.cancelOperation(op.id, "lançado em duplicidade");
    expect(isActive(f.ledger.operations.get(op.id)!)).toBe(false);
  });

  it("member names are unique, ignoring case", () => {
    const f = family();
    expect(() => f.ledger.addMember("ana")).toThrow(DomainError);
  });

  it("a card requires a credit card account", () => {
    const f = family();
    expect(() =>
      f.ledger.addCard(
        CardSchema.parse({
          name: "x",
          liability_account_id: f.bank,
          holder_id: f.ana,
          last4: "0000",
          closing_day: 1,
          due_day: 8,
        }),
      ),
    ).toThrow(DomainError);
  });

  it("rejects a category cycle", () => {
    const f = family();
    const parent = f.ledger.addAccount(
      LedgerAccountSchema.parse({ name: "Pai", type: AccountType.EXPENSE, subtype: AccountSubtype.CATEGORY }),
    );
    const child = f.ledger.addAccount(
      LedgerAccountSchema.parse({
        name: "Filho",
        type: AccountType.EXPENSE,
        subtype: AccountSubtype.CATEGORY,
        parent_id: parent.id,
      }),
    );
    expect(() => f.ledger.updateAccount({ ...parent, parent_id: child.id }, "x")).toThrow(DomainError);
  });
});

describe("persistence", () => {
  it("round-trips records", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.bank, "1000.00", d("2026-01-01"));
    f.ledger.recordCardPurchase(f.card, f.groceries, "99.99", d("2026-01-05"), "Mercado");
    const json = JSON.parse(JSON.stringify(f.ledger.toRecords()));
    const restored = Ledger.fromRecords(json);
    expect(JSON.stringify([...restored.operations])).toBe(JSON.stringify([...f.ledger.operations]));
    expect(JSON.stringify([...restored.accounts])).toBe(JSON.stringify([...f.ledger.accounts]));
    expect(restored.history.length).toBe(f.ledger.history.length);
    expect(restored.changeCount).toBe(0);
    expect(queries.balance(restored, f.bank).toFixed()).toBe("1000.00");
  });

  it("refuses a newer schema and unknown kinds", () => {
    const rows = Ledger.new("x").toRecords();
    const newer = rows.map((r) =>
      r.kind === "ledger.meta" ? { ...r, payload: { ...r.payload, schema_version: 999 } } : r,
    );
    expect(() => Ledger.fromRecords(newer)).toThrow(DomainError);
    expect(() => Ledger.fromRecords([...rows, { id: newId(), kind: "future_thing", payload: {} }])).toThrow(
      DomainError,
    );
  });

  it("the query index follows every change, even a direct write", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.bank, "100.00", d("2026-01-01"));
    expect(queries.balance(f.ledger, f.bank).toFixed()).toBe("100.00");
    const op = f.ledger.recordExpense(f.bank, f.groceries, "10.00", d("2026-01-02"), "x");
    expect(queries.balance(f.ledger, f.bank).toFixed()).toBe("90.00");
    f.ledger.operations.set(op.id, { ...op, status: OperationStatus.CANCELLED });
    expect(queries.balance(f.ledger, f.bank).toFixed()).toBe("100.00");
    expect(queries.balance(f.ledger, f.bank, d("2025-12-31")).isZero()).toBe(true);
  });

  it("dirty tracking and markClean", () => {
    const f = family();
    const restored = Ledger.fromRecords(f.ledger.toRecords());
    expect(restored.dirty.size).toBe(0);
    restored.addMember("Carla");
    const seq = restored.changeCount;
    expect(new Set(restored.dirtyKeys().map((k) => k.kind))).toEqual(new Set(["member", "history"]));
    restored.addMember("Davi");
    restored.markClean(seq);
    expect(restored.dirtyKeys().filter((k) => k.kind === "member")).toHaveLength(1);
  });
});

describe("member role (schema 2)", () => {
  it("new members are holders unless said otherwise", () => {
    const ledger = Ledger.new("Projeto");
    expect(ledger.addMember("Ana").role).toBe(MemberRole.HOLDER);
    expect(ledger.addMember("Lia", MemberRole.DEPENDENT).role).toBe(MemberRole.DEPENDENT);
  });

  it("migrates a schema 1 project with every member a holder", () => {
    const f = family();
    const old = f.ledger.toRecords().map((r) => {
      if (r.kind === "ledger.meta") return { ...r, payload: { ...r.payload, schema_version: 1 } };
      if (r.kind === "member") {
        const { role: _role, ...rest } = r.payload;
        return { ...r, payload: rest };
      }
      return r;
    });
    const restored = Ledger.fromRecords(old);
    expect(restored.migratedFrom).toBe(1);
    expect(restored.meta.schema_version).toBe(SCHEMA_VERSION);
    expect(Object.fromEntries([...restored.members.values()].map((m) => [m.name, m.role]))).toEqual({
      Ana: "holder",
      Bruno: "holder",
    });
  });
});
