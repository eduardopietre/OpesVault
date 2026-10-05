/** Port of the pipeline cases of `tests/test_rules.py` (rules applied to items in review). */
import { describe, expect, it } from "vitest";

import { DomainError } from "../src/domain/ledger.ts";
import { AccountType } from "../src/domain/model.ts";
import * as pipeline from "../src/importing/pipeline.ts";
import * as rules from "../src/importing/rules.ts";
import { Session } from "../src/session.ts";
import { category, family } from "./fixtures.ts";
import { doc, extractor } from "./importing_helpers.ts";

async function sessionWithBill() {
  const f = family();
  const session = Session.new();
  session.ledger = f.ledger;
  const batch = await pipeline.importDocument(session, { name: "nu.pdf", data: doc("nubank_card.pdf") }, extractor);
  return { f, session, batch };
}

describe("rules in review", () => {
  it("test_user_rule_wins_over_builtin_and_history", async () => {
    const { session, batch } = await sessionWithBill();
    const ledger = session.ledger;
    const leisure = category(ledger, "Lazer");
    const market = pipeline.itemsOf(ledger, batch.id).find((i) => i.description.includes("Mercado"))!;
    expect(market.suggestion_source).toBe("rule"); // built-in keyword rule (MERCADO → Alimentação)
    const rule = rules.addRule(ledger, "mercado bom", leisure);
    expect(rule.pattern).toBe("MERCADO BOM");
    expect(pipeline.applyRules(ledger, batch.id)).toBe(2); // two "Mercado Bom Preço" lines
    const updated = pipeline.items(ledger).get(market.id)!;
    expect(updated.target_account_id).toBe(leisure);
    expect(updated.suggestion_source).toBe(`user_rule:${rule.id}`);
    expect(rules.usage(ledger, rule.id)).toBe(2);
  });

  it("test_manual_choice_is_never_overridden", async () => {
    const { session, batch } = await sessionWithBill();
    const ledger = session.ledger;
    const item = pipeline.itemsOf(ledger, batch.id).find((i) => i.description.includes("Padaria"))!;
    const health = category(ledger, "Saúde");
    pipeline.correctItem(ledger, item.id, "target_account_id", health);
    rules.addRule(ledger, "padaria", category(ledger, "Lazer"));
    pipeline.applyRules(ledger, batch.id);
    expect(pipeline.items(ledger).get(item.id)!.target_account_id).toBe(health);
  });

  it("test_account_scoped_rule_is_more_specific", async () => {
    const { f, session } = await sessionWithBill();
    const ledger = session.ledger;
    const general = rules.addRule(ledger, "amazon", category(ledger, "Lazer"));
    const scoped = rules.addRule(ledger, "amazon", category(ledger, "Educação"), f.card_account);
    expect(rules.match(ledger, "AMAZON.COM", f.card_account, AccountType.EXPENSE)?.id).toBe(scoped.id);
    expect(rules.match(ledger, "AMAZON.COM", f.bank, AccountType.EXPENSE)?.id).toBe(general.id);
    // An expense rule never categorizes income.
    expect(rules.match(ledger, "AMAZON.COM", f.bank, AccountType.INCOME)).toBeNull();
  });

  it("test_validation_and_deactivation", async () => {
    const { f, session, batch } = await sessionWithBill();
    const ledger = session.ledger;
    expect(() => rules.addRule(ledger, "ab", category(ledger, "Lazer"))).toThrow(DomainError);
    expect(() => rules.addRule(ledger, "uber", f.bank)).toThrow(DomainError); // not a category
    const rule = rules.addRule(ledger, "padaria", category(ledger, "Lazer"));
    expect(() => rules.addRule(ledger, "Padaria", category(ledger, "Saúde"))).toThrow(DomainError); // duplicate text
    pipeline.applyRules(ledger);
    rules.setActive(ledger, rule.id, false, "não era lazer");
    expect(pipeline.applyRules(ledger)).toBeGreaterThanOrEqual(1); // its suggestions are withdrawn or replaced
    const item = pipeline.itemsOf(ledger, batch.id).find((i) => i.description.includes("Padaria"))!;
    expect(item.suggestion_source).not.toBe(`user_rule:${rule.id}`);
    expect(ledger.historyOf(rule.id).at(-1)!.reason).toBe("não era lazer");
  });
});
