/** Port of `tests/test_learning.py`: suggestions, rule proposals and contradictions. */
import { beforeEach, describe, expect, it } from "vitest";

import { reclassify } from "../src/domain/edits.ts";
import { AccountType, type Operation } from "../src/domain/model.ts";
import { makeDate } from "../src/lib/dates.ts";
import type { Id } from "../src/lib/ids.ts";
import * as learning from "../src/importing/learning.ts";
import * as pipeline from "../src/importing/pipeline.ts";
import * as rules from "../src/importing/rules.ts";
import { Session } from "../src/session.ts";
import { category, type Family, family } from "./fixtures.ts";
import { doc, extractor } from "./importing_helpers.ts";

let f: Family;
beforeEach(() => {
  f = family();
});

function spend(name: string, description: string, day: number, account: Id | null = null): Operation {
  return f.ledger.recordExpense(
    account ?? f.bank,
    category(f.ledger, name),
    "42.00",
    makeDate(2026, 3, day),
    description,
  );
}

describe("learning", () => {
  it("test_the_merchant_key_drops_what_changes_between_purchases", () => {
    expect(learning.merchantKey("Uber *Trip 8812 PARCELA 2/3")).toBe("UBER *TRIP");
    expect(learning.merchantKey("Padaria São João 03/10")).toBe("PADARIA SAO JOAO");
  });

  it("test_a_choice_made_twice_is_suggested_for_the_next_purchase", () => {
    spend("Transporte", "UBER *TRIP 1234", 1);
    spend("Transporte", "UBER *TRIP 5678", 2);
    const found = learning.suggest(f.ledger, "Uber *Trip 9999", AccountType.EXPENSE);
    expect(found?.category_id).toBe(category(f.ledger, "Transporte"));
    expect([found!.agreeing, found!.considered, found!.source]).toEqual([2, 2, "learned:2/2"]);
    expect(learning.suggest(f.ledger, "UBER *TRIP", AccountType.INCOME)).toBeNull(); // an expense teaches no income
  });

  it("test_the_family_changing_its_mind_is_followed", () => {
    for (const day of [1, 2, 3]) spend("Alimentação", "FEIRA DO BAIRRO", day);
    for (const day of [4, 5]) spend("Lazer", "FEIRA DO BAIRRO", day);
    let found = learning.suggest(f.ledger, "FEIRA DO BAIRRO", AccountType.EXPENSE);
    expect(found?.category_id).toBe(category(f.ledger, "Alimentação")); // 3 of the last 5
    spend("Lazer", "FEIRA DO BAIRRO", 6);
    found = learning.suggest(f.ledger, "FEIRA DO BAIRRO", AccountType.EXPENSE);
    expect(found?.category_id).toBe(category(f.ledger, "Lazer")); // now 3 of the last 5
    expect(found!.source).toBe("learned:3/5");
  });

  it("test_a_tie_goes_to_the_newest_choice", () => {
    spend("Alimentação", "LOJA CENTRAL", 1);
    spend("Lazer", "LOJA CENTRAL", 2);
    expect(learning.suggest(f.ledger, "LOJA CENTRAL", AccountType.EXPENSE)?.category_id).toBe(
      category(f.ledger, "Lazer"),
    );
  });

  it("test_a_later_reclassification_is_what_is_learned", () => {
    const op = spend("Alimentação", "CASA DO PAO", 1);
    const leisure = category(f.ledger, "Lazer");
    reclassify(f.ledger, [op.id], leisure, "era um presente");
    expect(learning.suggest(f.ledger, "CASA DO PAO", AccountType.EXPENSE)?.category_id).toBe(leisure);
  });

  it("test_choices_made_on_the_same_account_come_first", () => {
    spend("Alimentação", "MERCADINHO", 1, f.bank);
    spend("Alimentação", "MERCADINHO", 2, f.bank);
    spend("Lazer", "MERCADINHO", 3, f.joint);
    expect(learning.suggest(f.ledger, "MERCADINHO", AccountType.EXPENSE, f.joint)?.category_id).toBe(
      category(f.ledger, "Lazer"),
    );
    expect(learning.suggest(f.ledger, "MERCADINHO", AccountType.EXPENSE, f.bank)?.category_id).toBe(
      category(f.ledger, "Alimentação"),
    );
    expect(learning.suggest(f.ledger, "MERCADINHO", AccountType.EXPENSE, f.savings)?.category_id).toBe(
      category(f.ledger, "Alimentação"), // all choices
    );
  });

  it("test_a_longer_description_starting_with_a_learned_one_is_recognized", () => {
    spend("Serviços e assinaturas", "NETFLIX.COM", 1);
    expect(learning.suggest(f.ledger, "NETFLIX.COM SAO PAULO BR", AccountType.EXPENSE)?.category_id).toBe(
      category(f.ledger, "Serviços e assinaturas"),
    );
    expect(learning.suggest(f.ledger, "NETFLIXCOMPRAS", AccountType.EXPENSE)).toBeNull(); // not on a word boundary
  });

  it("test_generic_and_split_operations_teach_nothing", () => {
    spend("Lazer", "PIX 123456", 1); // key "PIX" is too short to mean a merchant
    expect(learning.suggest(f.ledger, "PIX 999", AccountType.EXPENSE)).toBeNull();
    f.ledger.recordTransfer(f.bank, f.savings, "100.00", makeDate(2026, 3, 2), "RESERVA MENSAL");
    expect(learning.suggest(f.ledger, "RESERVA MENSAL", AccountType.EXPENSE)).toBeNull();
  });

  // test_a_purchase_in_installments_is_one_choice needs domain/cards.record_installment_purchase (W4).

  it("test_cancelled_operations_and_archived_categories_are_forgotten", () => {
    const op = spend("Lazer", "CINEMA CENTRAL", 1);
    f.ledger.cancelOperation(op.id, "lançado em dobro");
    expect(learning.suggest(f.ledger, "CINEMA CENTRAL", AccountType.EXPENSE)).toBeNull();
  });

  it("test_repeated_choices_are_offered_as_a_rule", () => {
    for (const day of [1, 2, 3]) spend("Transporte", `POSTO IPIRANGA ${day}`, day);
    spend("Lazer", "BOLICHE", 4);
    expect(learning.proposals(f.ledger).map((p) => [p.pattern, p.category_id, p.count])).toEqual([
      ["POSTO IPIRANGA", category(f.ledger, "Transporte"), 3],
    ]);
    rules.addRule(f.ledger, "POSTO IPIRANGA", category(f.ledger, "Transporte"));
    expect(learning.proposals(f.ledger)).toEqual([]); // the rule already says so
  });

  it("test_choices_that_disagree_are_not_offered_as_a_rule", () => {
    for (const [day, name] of [
      [1, "Transporte"],
      [2, "Transporte"],
      [3, "Lazer"],
    ] as const)
      spend(name, "AUTO POSTO", day);
    expect(learning.proposals(f.ledger)).toEqual([]);
  });

  it("test_a_rule_the_family_keeps_overriding_is_reported", () => {
    const rule = rules.addRule(f.ledger, "PADARIA", category(f.ledger, "Alimentação"));
    spend("Alimentação", "PADARIA REAL", 1);
    expect(learning.contradictions(f.ledger).size).toBe(0);
    spend("Lazer", "PADARIA REAL CAFE", 2);
    spend("Lazer", "PADARIA REAL CAFE", 3);
    const found = learning.contradictions(f.ledger);
    expect([...found.keys()]).toEqual([rule.id]);
    expect([found.get(rule.id)!.matched, found.get(rule.id)!.contrary]).toEqual([3, 2]);
    expect(found.get(rule.id)!.usual_category_id).toBe(category(f.ledger, "Lazer"));
  });

  it("test_learning_is_recomputed_only_when_operations_or_accounts_change", () => {
    spend("Lazer", "TEATRO MUNICIPAL", 1);
    const first = learning.knowledge(f.ledger);
    f.ledger.addMember("Carla"); // a member is not an operation or an account
    expect(learning.knowledge(f.ledger)).toBe(first);
    spend("Lazer", "TEATRO MUNICIPAL", 2);
    expect(learning.knowledge(f.ledger)).not.toBe(first);
  });

  it("test_review_labels_say_how_many_choices_agree", () => {
    expect(learning.describeSource("learned:3/3")).toBe("aprendida: 3 escolha(s) iguais");
    expect(learning.describeSource("learned:3/5")).toBe("aprendida: 3 de 5 escolhas recentes");
    expect(learning.describeSource("rule")).toBeNull();
  });

  it("test_import_trusts_the_users_rule_then_what_was_learned_then_keywords", async () => {
    const ledger = f.ledger;
    const leisure = category(ledger, "Lazer");
    const health = category(ledger, "Saúde");
    for (const day of [1, 2])
      ledger.recordCardPurchase(f.card, leisure, "30.00", makeDate(2025, 12, day), "MERCADO BOM PRECO");
    const session = Session.new();
    session.ledger = ledger;
    const batch = await pipeline.importDocument(session, { name: "nu.pdf", data: doc("nubank_card.pdf") }, extractor);
    const market = pipeline.itemsOf(ledger, batch.id).find((i) => i.description.includes("Mercado"))!;
    // the keyword rule says Alimentação; this family files it under Lazer
    expect(market.target_account_id).toBe(leisure);
    expect(market.suggestion_source).toBe("learned:2/2");
    rules.addRule(ledger, "mercado bom", health);
    pipeline.applyRules(ledger, batch.id);
    expect(pipeline.items(ledger).get(market.id)!.target_account_id).toBe(health); // an explicit rule wins
  });
});
