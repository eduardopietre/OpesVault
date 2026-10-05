/** Parity of `domain/onboarding.py` (golden/onboarding.json, scripts/golden/cases_onboarding.py). */
import { describe, expect, it } from "vitest";

import { DomainError, Ledger } from "../src/domain/ledger.ts";
import type { AccountSubtype } from "../src/domain/model.ts";
import { type AccountPlan, accountPlan, applySetup, type CardPlan, cardPlan } from "../src/domain/onboarding.ts";
import * as queries from "../src/domain/queries.ts";
import type { IsoDate } from "../src/lib/dates.ts";
import { Dec } from "../src/lib/dec.ts";
import { golden } from "./golden.ts";

type Row = unknown[];
interface Case {
  existing: string[];
  plan: { members: string[]; accounts: Row[]; cards: Row[] };
  result: unknown;
}

const { cases } = golden<{ cases: Case[] }>("onboarding");

function account(row: Row): AccountPlan {
  const [name, subtype, holders, institution, balance, on] = row as [
    string,
    AccountSubtype,
    string[]?,
    (string | null)?,
    (string | null)?,
    (string | null)?,
  ];
  return accountPlan(
    name,
    subtype,
    holders ?? [],
    institution ?? null,
    balance != null ? Dec.parse(balance) : null,
    (on ?? null) as IsoDate | null,
  );
}

function card(row: Row): CardPlan {
  const [name, holder, last4, closing, due, settlement, institution] = row as [
    string,
    string,
    string,
    number,
    number,
    (string | null)?,
    (string | null)?,
  ];
  return cardPlan(name, holder, last4, closing, due, settlement ?? null, institution ?? null);
}

function describeLedger(ledger: Ledger): unknown {
  const members = new Map([...ledger.members.values()].map((m) => [m.id, m.name]));
  const accounts = new Map([...ledger.accounts.values()].map((a) => [a.id, a.name]));
  return {
    accounts: [...ledger.accounts.values()].map((a) => ({
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      institution: a.institution,
      masked_number: a.masked_number,
      holders: a.holders.map((h) => members.get(h)),
      balance: queries.balance(ledger, a.id).toFixed(),
    })),
    cards: [...ledger.cards.values()].map((c) => ({
      name: c.name,
      liability: accounts.get(c.liability_account_id),
      holder: members.get(c.holder_id),
      last4: c.last4,
      closing_day: c.closing_day,
      due_day: c.due_day,
      settlement: c.settlement_account_id ? accounts.get(c.settlement_account_id) : null,
    })),
    operations: [...ledger.operations.values()].map((o) => ({
      kind: o.kind,
      description: o.description,
      occurred_on: String(o.occurred_on),
      postings: o.postings.map((p) => [accounts.get(p.account_id), p.amount.toFixed()]),
    })),
    members: [...ledger.members.values()].map((m) => [m.name, m.role]),
    history: ledger.history.length,
  };
}

describe("onboarding golden", () => {
  it.each(cases.map((c, i) => [i, c] as const))("case %i", (_i, c) => {
    const ledger = Ledger.new("Projeto");
    for (const name of c.existing) ledger.addMember(name);
    const before = ledger.changeCount;
    const plan = {
      members: c.plan.members,
      accounts: c.plan.accounts.map(account),
      cards: c.plan.cards.map(card),
    };
    let result: unknown;
    try {
      const r = applySetup(ledger, plan);
      result = { ok: [r.members, r.accounts, r.cards, r.openingBalances], state: describeLedger(ledger) };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      result = { error: error.message, unchanged: ledger.changeCount === before };
    }
    expect(result).toEqual(c.result);
  });
});
