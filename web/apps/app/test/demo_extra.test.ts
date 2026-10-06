/** The web demonstration's extra data (docs/18 W12): each path the e2e tests need is there, on a fixed date. */
import { demoSession, dom, makeDate, tax, ymOf, type IsoDate } from "@opesvault/domain";
import { describe, expect, it } from "vitest";
import { applyDemoExtras } from "../src/data/demo_extra.ts";
import { PdfJsExtractor } from "../../../packages/domain/src/importing/source.ts";

const TODAY: IsoDate = makeDate(2026, 10, 6);

async function demo(extras: boolean) {
  const session = await demoSession({ today: TODAY, extractor: new PdfJsExtractor() });
  if (extras) applyDemoExtras(session, TODAY);
  return session.ledger;
}

describe("demonstration extras", () => {
  it("leaves the domain's demonstration alone unless asked", async () => {
    const plain = await demo(false);
    expect(dom.sharing.balances(plain)).toEqual([]);
    expect([...dom.recurrence.rules(plain).values()].map((rule) => rule.description)).toEqual(["Aluguel"]);
  });

  it("has a debt between members: Bruno owes Ana for a purchase on her card", async () => {
    const ledger = await demo(true);
    const [balance] = dom.sharing.balances(ledger);
    expect(balance).toBeDefined();
    expect(ledger.members.get(balance!.debtorId)?.name).toBe("Bruno");
    expect(ledger.members.get(balance!.creditorId)?.name).toBe("Ana");
    expect(balance!.amount.toFixed()).toBe("180.00");
  });

  it("has a recurrence due today with exactly one operation to link, and a charge that repeats without a rule", async () => {
    const ledger = await demo(true);
    const suggestions = dom.recurrence.autoSuggestions(ledger, makeDate(2026, 10, 1), makeDate(2026, 10, 31), TODAY);
    expect(suggestions.map(([forecast, op]) => [forecast.description, op.description, forecast.dueOn])).toEqual([
      ["Condomínio", "Condomínio", TODAY],
    ]);
    const candidates = dom.subscriptions.candidates(ledger, TODAY);
    expect(
      candidates.map((candidate) => [candidate.description, candidate.months, candidate.amount.toFixed()]),
    ).toEqual([["Academia Fit", 3, "119.90"]]);
  });

  it("has a stock sold with a result, and a card bill due in the current month", async () => {
    const ledger = await demo(true);
    const sales = tax.variableIncome.trades(ledger);
    expect(sales).toHaveLength(1);
    expect(tax.variableIncome.tradeResult(sales[0]!).toFixed()).toBe("253.14");
    const card = [...ledger.cards.values()][0]!;
    const [bill] = dom.cards.bills(ledger, card.id, [ymOf(TODAY)]);
    expect(bill!.total.toFixed()).toBe("329.90");
    expect(bill!.cycle.due).toBe(makeDate(2026, 10, 10));
  });
});
