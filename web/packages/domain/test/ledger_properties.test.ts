/**
 * Port of `tests/test_ledger_properties.py`: properties of the ledger under random sequences of
 * everyday actions (docs/04 §2, docs/03 §5), now including installment plans and tags.
 *
 * The sequences come from a seeded generator of their own (Python's `random` is not reproduced):
 * the properties are what is ported, not the exact walks. The Session of the desktop is replaced
 * by the ledger's own undo stack and dirty tracking.
 */
import { describe, expect, it } from "vitest";

import { recordInstallmentPurchase } from "../src/domain/cards.ts";
import { reclassify } from "../src/domain/edits.ts";
import { DomainError, Ledger } from "../src/domain/ledger.ts";
import { AccountType } from "../src/domain/model.ts";
import * as queries from "../src/domain/queries.ts";
import * as tags from "../src/domain/tags.ts";
import { addDays, type IsoDate } from "../src/lib/dates.ts";
import { Dec } from "../src/lib/dec.ts";
import { UndoStack } from "../src/undo.ts";
import { category, type Family, family } from "./fixtures.ts";

const SEEDS = Array.from({ length: 20 }, (_, i) => i);
const ACTIONS = 40;
const START = "2026-01-01" as IsoDate;

type Records = Map<string, unknown>;

function records(ledger: Ledger): Records {
  return new Map(ledger.toRecords().map((r) => [`${r.kind}:${r.id}`, r.payload]));
}

/** mulberry32: reproducible on purpose, a failing seed fails again the same way. */
function rng(seed: number) {
  let a = seed + 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    random: next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    choice: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
}
type Rng = ReturnType<typeof rng>;

function amount(r: Rng): string {
  const cents = r.choice([1, 5, 99, 100, 1234, 50_000, 999_999, r.int(1, 2_000_000)]);
  return Dec.from(cents).div(100).quantize("0.01").toFixed();
}

/** Chooses one action at a time from what the ledger already holds. */
class Walker {
  readonly expenses: string[];
  readonly incomes: string[];
  readonly cash: string[];
  readonly f: Family;
  readonly r: Rng;

  constructor(f: Family, r: Rng) {
    this.f = f;
    this.r = r;
    this.expenses = f.ledger.categories(AccountType.EXPENSE).map((a) => a.id);
    this.incomes = f.ledger.categories(AccountType.INCOME).map((a) => a.id);
    this.cash = [f.bank, f.savings, f.joint];
  }

  day(): IsoDate {
    return addDays(START, this.r.int(0, 200));
  }

  action(): () => unknown {
    const { f, r } = this;
    const ledger = f.ledger;
    const ops = [...ledger.activeOperations()].filter((op) => op.kind !== "opening_balance");
    const choices: (() => unknown)[] = [
      () => ledger.recordIncome(r.choice(this.cash), r.choice(this.incomes), amount(r), this.day(), "Receita"),
      () => ledger.recordExpense(r.choice(this.cash), r.choice(this.expenses), amount(r), this.day(), "Despesa"),
      () => ledger.recordTransfer(r.choice(this.cash), r.choice(this.cash), amount(r), this.day(), "Transferência"),
      () => ledger.recordCardPurchase(f.card, r.choice(this.expenses), amount(r), this.day(), "Compra"),
      () => ledger.recordExpense(f.bank, f.groceries, "-1.00", this.day(), "Inválida"),
      () => ledger.recordCardPayment(f.card, f.bank, amount(r), this.day()),
      () =>
        recordInstallmentPurchase(
          ledger,
          f.card,
          r.choice(this.expenses),
          amount(r),
          this.day(),
          "Parcelada",
          r.int(2, 6),
        ),
    ];
    if (ops.length) {
      const op = r.choice(ops);
      choices.push(
        () => ledger.cancelOperation(op.id, "teste"),
        () => ledger.reverseOperation(op.id, this.day(), "teste"),
        () => ledger.updateOperation({ ...op, description: "Corrigida" }, "teste"),
        () => reclassify(ledger, [op.id], r.choice(this.expenses), "teste"),
        () => tags.addTag(ledger, [op.id], r.choice(["Viagem", "Casa", "Obra"])),
        () => tags.removeTag(ledger, [op.id], "Viagem"),
      );
    }
    return r.choice(choices);
  }
}

interface World {
  f: Family;
  stack: UndoStack;
}

function world(): World {
  const f = family();
  const stack = new UndoStack(() => f.ledger);
  f.ledger.recordOpeningBalance(f.bank, "5000.00", START);
  f.ledger.recordOpeningBalance(f.savings, "300.00", START);
  stack.seal();
  stack.undoSteps.length = 0; // the starting point, not something to undo
  return { f, stack };
}

/** Applies `actions` random actions, one undo step each; returns how many were accepted. */
function run(w: World, r: Rng, actions: number): number {
  const walker = new Walker(w.f, r);
  let accepted = 0;
  for (let i = 0; i < actions; i++) {
    const act = walker.action();
    const before = records(w.f.ledger);
    try {
      act();
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      expect(records(w.f.ledger), "a rejected action left a change behind").toEqual(before);
      w.stack.journal.length = 0;
      continue;
    }
    w.stack.seal();
    accepted += 1;
  }
  return accepted;
}

function assertBalanced(ledger: Ledger): void {
  for (const op of ledger.operations.values()) {
    expect(Dec.sum(op.postings.map((p) => p.amount)).isZero(), op.description).toBe(true);
  }
  const index = queries.index(ledger); // raw balances: debits positive, whatever the account type
  expect(Dec.sum(index.accounts().map((a) => index.rawBalance(a, null))).isZero()).toBe(true);
}

describe("ledger properties", () => {
  it.each(SEEDS)("random days keep the books balanced and undoable (seed %i)", (seed) => {
    const w = world();
    const ledger = w.f.ledger;
    const start = records(ledger);
    const accepted = run(w, rng(seed), ACTIONS);
    expect(accepted, "the walk must mostly do things, not only fail").toBeGreaterThan(Math.floor(ACTIONS / 3));
    assertBalanced(ledger);
    const end = records(ledger);
    while (w.stack.undo() !== null);
    expect(records(ledger)).toEqual(start);
    while (w.stack.redo() !== null);
    expect(records(ledger)).toEqual(end);
    assertBalanced(ledger);
  });

  it.each(SEEDS)("records read back as the same ledger (seed %i)", (seed) => {
    const w = world();
    run(w, rng(seed), ACTIONS);
    const again = Ledger.fromRecords(JSON.parse(JSON.stringify(w.f.ledger.toRecords())));
    expect(records(again)).toEqual(records(w.f.ledger));
    const a = [...queries.balances(again)].map(([k, v]) => [k, v.toFixed()]);
    const b = [...queries.balances(w.f.ledger)].map(([k, v]) => [k, v.toFixed()]);
    expect(a).toEqual(b);
  });

  it.each(SEEDS)("an incremental save carries every change (seed %i)", (seed) => {
    const w = world();
    const ledger = w.f.ledger;
    const r = rng(seed);
    run(w, r, ACTIONS / 2);
    const saved = records(ledger); // what the project holds after a sync
    ledger.markClean(ledger.changeCount);
    run(w, r, ACTIONS / 2);
    if (r.random() < 0.5) w.stack.undo(); // undoing part of the unsynced work is a change too
    const rebuilt = new Map(saved);
    for (const { kind, id } of ledger.dirtyKeys()) {
      const payload = ledger.recordFor(kind, id);
      if (payload === null) rebuilt.delete(`${kind}:${id}`);
      else rebuilt.set(`${kind}:${id}`, payload);
    }
    expect(rebuilt).toEqual(records(ledger));
  });

  it("an expense moves exactly its amount", () => {
    const w = world();
    const f = w.f;
    const r = rng(7);
    const leisure = category(f.ledger, "Lazer");
    for (let i = 0; i < 50; i++) {
      const value = amount(r);
      const before = queries.balance(f.ledger, f.bank);
      const spent = queries.balance(f.ledger, leisure);
      f.ledger.recordExpense(f.bank, leisure, value, START, "Cinema");
      expect(queries.balance(f.ledger, f.bank).eq(before.sub(value))).toBe(true);
      expect(queries.balance(f.ledger, leisure).eq(spent.add(value))).toBe(true);
    }
  });
});
