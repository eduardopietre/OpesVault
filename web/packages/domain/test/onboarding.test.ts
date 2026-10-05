/** Port of `tests/test_onboarding.py`. */
import { describe, expect, it } from "vitest";

import { DomainError, Ledger } from "../src/domain/ledger.ts";
import { AccountSubtype } from "../src/domain/model.ts";
import { accountPlan, applySetup, cardPlan, type SetupPlan, setupPlan } from "../src/domain/onboarding.ts";
import * as queries from "../src/domain/queries.ts";
import type { IsoDate } from "../src/lib/dates.ts";
import { Dec } from "../src/lib/dec.ts";

const JAN1 = "2026-01-01" as IsoDate;

function plan(changes: Partial<SetupPlan> = {}): SetupPlan {
  return setupPlan({
    members: ["Ana", "Bruno"],
    accounts: [
      accountPlan("Banco A", AccountSubtype.CHECKING, ["Ana"], "Banco", Dec.parse("1500.00"), JAN1),
      accountPlan("Conjunta", AccountSubtype.CHECKING, ["Ana", "Bruno"]),
      accountPlan("Financiamento", AccountSubtype.LOAN, [], null, Dec.parse("90000.00"), JAN1),
    ],
    cards: [cardPlan("Cartão Ana", "Ana", "1234", 3, 10, "Banco A")],
    ...changes,
  });
}

describe("onboarding", () => {
  it("setup creates everything", () => {
    const ledger = Ledger.new("Projeto");
    const result = applySetup(ledger, plan());
    expect([result.members, result.accounts, result.cards, result.openingBalances]).toEqual([2, 3, 1, 2]);
    const accounts = new Map([...ledger.accounts.values()].map((a) => [a.name, a]));
    expect(queries.balance(ledger, accounts.get("Banco A")!.id).toFixed()).toBe("1500.00");
    expect(queries.balance(ledger, accounts.get("Conjunta")!.id).isZero()).toBe(true);
    // A liability balance is reported as the amount owed.
    expect(queries.balance(ledger, accounts.get("Financiamento")!.id).toFixed()).toBe("90000.00");
    const card = [...ledger.cards.values()][0]!;
    expect(card.settlement_account_id).toBe(accounts.get("Banco A")!.id);
    expect(accounts.get("Cartão Ana")!.subtype).toBe(AccountSubtype.CREDIT_CARD);
    expect(accounts.get("Conjunta")!.holders.length).toBe(2);
  });

  it.each<[string, Partial<SetupPlan>]>([
    ["same member twice", { members: ["Ana", "ana"] }],
    ["blank member", { members: ["Ana", " "] }],
    ["unknown holder", { accounts: [accountPlan("X", AccountSubtype.CHECKING, ["Carla"])] }],
    ["balance without date", { accounts: [accountPlan("X", AccountSubtype.CHECKING, [], null, Dec.parse("1"), null)] }],
    [
      "repeated account",
      { accounts: [accountPlan("X", AccountSubtype.CHECKING), accountPlan("x", AccountSubtype.SAVINGS)] },
    ],
    ["card subtype as account", { accounts: [accountPlan("X", AccountSubtype.CREDIT_CARD)] }],
    ["bad last digits", { cards: [cardPlan("C", "Ana", "12a4", 3, 10)] }],
    ["bad closing day", { cards: [cardPlan("C", "Ana", "1234", 0, 10)] }],
    ["unknown holder of a card", { cards: [cardPlan("C", "Zé", "1234", 3, 10)] }],
    ["unknown payment account", { cards: [cardPlan("C", "Ana", "1234", 3, 10, "Inexistente")] }],
    // Only the domain knows a loan cannot pay a card: caught by the dry run.
    ["a loan cannot pay a card", { cards: [cardPlan("C", "Ana", "1234", 3, 10, "Financiamento")] }],
  ])("an invalid plan changes nothing: %s", (_name, changes) => {
    const ledger = Ledger.new("Projeto");
    const before = ledger.changeCount;
    expect(() => applySetup(ledger, plan(changes))).toThrow(DomainError);
    expect(ledger.changeCount).toBe(before);
  });
});
