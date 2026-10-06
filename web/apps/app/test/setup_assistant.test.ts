/**
 * The first-run assistant hands the domain a plan (desktop `SetupWizard` → `onboarding.apply_setup`): what was typed
 * becomes integrantes, contas with titulares and saldo de abertura, and cartões, or nothing at all when one entry is
 * wrong. W12 found it collected and threw everything away.
 */
import { AccountSubtype, DomainError, Ledger, dec, dom, queries } from "@opesvault/domain";
import { describe, expect, it } from "vitest";
import { setupPlanOf } from "../src/screens/projects.tsx";

const account = (name: string, changes: Record<string, unknown> = {}) => ({
  name,
  subtype: AccountSubtype.CHECKING,
  holders: [] as string[],
  institution: "",
  balance: "",
  date: "06/10/2026",
  ...changes,
});
const card = (name: string, changes: Record<string, unknown> = {}) => ({
  name,
  holder: "Ana",
  last4: "1234",
  closing: "3",
  due: "10",
  payer: "",
  ...changes,
});

describe("first-run assistant", () => {
  it("turns what was typed into the project's first records, in one go", () => {
    const ledger = Ledger.new("Casa");
    ledger.addMember("Ana");
    const plan = setupPlanOf(
      ["Ana"],
      ["Ana", "Bruno"],
      [
        account("Banco A", { holders: ["Ana", "Bruno"], balance: "1.500,00", institution: " Banco do Povo " }),
        account("Carteira", { subtype: AccountSubtype.CASH }),
      ],
      [card("Cartão Azul", { payer: "Banco A" })],
    );
    expect(plan.members).toEqual(["Bruno"]); // Ana is already in the project
    expect(plan.accounts[0]!.openingBalance?.toString()).toBe("1500.00");
    expect(plan.accounts[0]!.openingDate).toBe("2026-10-06");
    expect(plan.accounts[1]!.openingBalance).toBeNull(); // not informed: unknown, not zero
    expect(plan.accounts[1]!.openingDate).toBeNull();
    const result = dom.onboarding.applySetup(ledger, plan);
    expect(result).toMatchObject({ members: 1, accounts: 2, cards: 1, openingBalances: 1 });
    const bank = [...ledger.accounts.values()].find((a) => a.name === "Banco A")!;
    expect(bank.institution).toBe("Banco do Povo");
    expect(bank.holders.map((id) => ledger.members.get(id)!.name)).toEqual(["Ana", "Bruno"]);
    expect(queries.balance(ledger, bank.id).eq(dec("1500.00"))).toBe(true);
    const azul = [...ledger.cards.values()].find((c) => c.name === "Cartão Azul")!;
    expect(azul.settlement_account_id).toBe(bank.id);
  });

  it.each([
    ["a card without its last four digits", [], [card("Azul", { last4: "12" })], "4 últimos dígitos"],
    ["an account balance in the wrong format", [account("Banco", { balance: "mil reais" })], [], "Valor inválido"],
    ["an account balance without a date", [account("Banco", { balance: "10,00", date: "" })], [], "data do saldo"],
    ["a card whose holder is not a member", [], [card("Azul", { holder: "Zé" })], "portador"],
  ])("refuses %s and writes nothing", (_what, accounts, cards, words) => {
    const ledger = Ledger.new("Casa");
    ledger.addMember("Ana");
    const before = ledger.toRecords().length;
    expect(() =>
      dom.onboarding.applySetup(ledger, setupPlanOf(["Ana"], ["Ana"], accounts as never, cards as never)),
    ).toThrow(DomainError);
    try {
      dom.onboarding.applySetup(ledger, setupPlanOf(["Ana"], ["Ana"], accounts as never, cards as never));
    } catch (error) {
      expect((error as Error).message).toContain(words);
    }
    expect(ledger.toRecords().length).toBe(before);
  });
});
