/** Port of the pipeline-free cases of `tests/test_rules.py` (the rest come with the import pipeline). */
import { describe, expect, it } from "vitest";

import { DomainError, Ledger } from "../src/domain/ledger.ts";
import { AccountType } from "../src/domain/model.ts";
import { addRule, match, rules, setActive, suggestPattern } from "../src/importing/rules.ts";
import { category, family } from "./fixtures.ts";

describe("category rules", () => {
  it("suggests a pattern without numbers and installments", () => {
    expect(suggestPattern("Uber *Trip 8812")).toBe("UBER *TRIP");
    expect(suggestPattern("Loja Eletro - Parcela 2/10")).toBe("LOJA ELETRO");
    expect(suggestPattern("Farmácia São João")).toBe("FARMACIA SAO JOAO");
    expect(suggestPattern("LOJA TV (6x)")).toBe("LOJA TV");
    expect(suggestPattern("Curso Online 10X")).toBe("CURSO ONLINE");
    expect(suggestPattern("Posto 24 - 123")).toBe("POSTO");
  });

  it("prefers the account-scoped rule, then the longest text", () => {
    const f = family();
    const leisure = category(f.ledger, "Lazer");
    const health = category(f.ledger, "Saúde");
    addRule(f.ledger, "farmacia", health);
    addRule(f.ledger, "farmácia são", leisure);
    expect(match(f.ledger, "FARMACIA SAO JOAO", null, AccountType.EXPENSE)?.target_account_id).toBe(leisure);
    addRule(f.ledger, "farm", health, f.card_account);
    expect(match(f.ledger, "FARMACIA SAO JOAO", f.card_account, AccountType.EXPENSE)?.target_account_id).toBe(health);
    expect(match(f.ledger, "FARMACIA SAO JOAO", null, AccountType.INCOME)).toBeNull();
  });

  it("validates and deactivates", () => {
    const f = family();
    const leisure = category(f.ledger, "Lazer");
    expect(() => addRule(f.ledger, "ab", leisure)).toThrow(DomainError);
    expect(() => addRule(f.ledger, "cinema", f.bank)).toThrow(DomainError);
    const rule = addRule(f.ledger, "cinema", leisure);
    expect(() => addRule(f.ledger, " CINEMA ", leisure)).toThrow(DomainError);
    setActive(f.ledger, rule.id, false, "não uso mais");
    expect(match(f.ledger, "Cinema", null, AccountType.EXPENSE)).toBeNull();
    expect(rules(f.ledger).get(rule.id)!.version).toBe(2);
    const restored = Ledger.fromRecords(JSON.parse(JSON.stringify(f.ledger.toRecords())));
    expect(rules(restored).get(rule.id)!.active).toBe(false);
  });
});
