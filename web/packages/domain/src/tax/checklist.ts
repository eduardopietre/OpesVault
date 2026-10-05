/**
 * Documents of the year: which informes and receipts the return needs and which are still missing.
 * Port of `tax/checklist.py`.
 *
 * Built from what was recorded (accounts with movement, payers, deductible payments, loans and
 * goods bought or sold). A document counts as received when the app can see it (an informe
 * saved, every payment with its receipt attached) or when the user marks it by hand.
 */
import type { Ledger } from "../domain/ledger.ts";
import { AccountSubtype, AccountType, cashDate } from "../domain/model.ts";
import { ZERO } from "../domain/money.ts";
import * as queries from "../domain/queries.ts";
import { makeDate, yearOf } from "../lib/dates.ts";
import type { Id } from "../lib/ids.ts";
import { casefold, sortedBy } from "../lib/text.ts";
import * as declaration from "./declaration.ts";
import { ReportSource } from "./model.ts";
import * as records from "./records.ts";

export interface Expected {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly received: boolean;
  readonly by_hand: boolean; // the user's mark decides, not what the app sees
  readonly action: string; // "report", "receipts", "mark"
  readonly ref: unknown;
}

const SKIPPED: ReadonlySet<AccountSubtype> = new Set([
  AccountSubtype.CASH,
  AccountSubtype.INVESTMENT,
  AccountSubtype.CATEGORY,
  AccountSubtype.CREDIT_CARD,
  AccountSubtype.TAX_PAYABLE,
  AccountSubtype.OPENING_EQUITY,
]);

function activeAccounts(ledger: Ledger, year: number, people: ReadonlySet<Id> | null): Id[] {
  const start = makeDate(year, 1, 1);
  const end = makeDate(year, 12, 31);
  const before = makeDate(year - 1, 12, 31);
  const now = queries.balances(ledger, end);
  const then = queries.balances(ledger, before);
  const moved = new Set<Id>();
  for (const op of ledger.activeOperations()) {
    const when = cashDate(op);
    if (when !== null && start <= when && when <= end) for (const p of op.postings) moved.add(p.account_id);
  }
  const out: Id[] = [];
  for (const account of sortedBy([...ledger.accounts.values()], (a) => casefold(a.name))) {
    if (SKIPPED.has(account.subtype)) continue;
    if (account.type !== AccountType.ASSET && account.type !== AccountType.LIABILITY) continue;
    if ((now.get(account.id) ?? ZERO).isZero() && (then.get(account.id) ?? ZERO).isZero() && !moved.has(account.id)) {
      continue;
    }
    if (people !== null && !account.holders.some((h) => people.has(h))) continue;
    out.push(account.id);
  }
  return out;
}

export function expected(ledger: Ledger, year: number, people: ReadonlySet<Id> | null = null): Expected[] {
  const have = new Set(records.reportsOf(ledger, year).map((r) => `${r.source}|${r.source_id}`));
  const out: Expected[] = [];

  const add = (key: string, title: string, detail: string, seen: boolean, action: string, ref: unknown = null) => {
    const mark = records.markOf(ledger, year, key);
    const received = mark !== null ? mark.received : seen;
    out.push({ key, title, detail, received, by_hand: mark !== null, action, ref });
  };

  for (const accountId of activeAccounts(ledger, year, people)) {
    const account = ledger.account(accountId);
    const who = account.institution || account.name;
    if (account.type === AccountType.LIABILITY) {
      add(
        `divida:${accountId}`,
        `Saldo devedor em 31/12 — ${account.name}`,
        "Declaração do credor com o saldo do financiamento no fim do ano.",
        have.has(`${ReportSource.ACCOUNT}|${accountId}`),
        "report",
        [ReportSource.ACCOUNT, accountId],
      );
      continue;
    }
    add(
      `informe:conta:${accountId}`,
      `Informe de rendimentos — ${who}`,
      `Saldos em 31/12 e rendimentos da conta ${account.name}.`,
      have.has(`${ReportSource.ACCOUNT}|${accountId}`),
      "report",
      [ReportSource.ACCOUNT, accountId],
    );
  }
  const found = declaration.income(ledger, year, people);
  for (const sourceId of new Set(found.taxable.map((r) => r.source_id))) {
    const payer = found.taxable.find((r) => r.source_id === sourceId)!.payer;
    add(
      `informe:fonte:${sourceId}`,
      `Comprovante de rendimentos — ${payer}`,
      "Rendimentos do trabalho, imposto retido, INSS e 13º salário.",
      have.has(`${ReportSource.CATEGORY}|${sourceId}`),
      "report",
      [ReportSource.CATEGORY, sourceId],
    );
  }
  for (const row of declaration.payments(ledger, year, people)) {
    if (!row.paid.isPositive()) continue;
    const count = row.operations.length;
    const attached = count - row.without_receipt;
    add(
      `recibos:${row.kind}:${row.payee_key}:${row.beneficiary_id ?? "None"}`,
      `Recibos e notas — ${row.payee}`,
      `${attached} de ${count} pagamento(s) com comprovante anexado.`,
      row.without_receipt === 0,
      "receipts",
      [...row.operations],
    );
  }
  for (const item of records.declaredAssets(ledger).values()) {
    if (people !== null && (item.owner_id === null || !people.has(item.owner_id))) continue;
    for (const [when, what] of [
      [item.acquired_on, "compra"],
      [item.sold_on, "venda"],
    ] as const) {
      if (when !== null && yearOf(when) === year) {
        add(
          `bem:${what}:${item.id}`,
          `Documento de ${what} — ${item.name}`,
          "Escritura, contrato ou nota com o valor e a data.",
          false,
          "mark",
        );
      }
    }
  }
  return out;
}

export function missing(items: readonly Expected[]): Expected[] {
  return items.filter((i) => !i.received);
}
