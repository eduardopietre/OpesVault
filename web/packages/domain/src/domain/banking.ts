/**
 * Bank accounts as the bank sees them: bank (COMPE), branch, number, holders and what is inside.
 * Port of `domain/banking.py`.
 *
 * A bank account groups the ledger accounts that live at the same branch and number: the
 * checking account, the savings account and the investments held there (any mix, or none).
 * The money stays in the ledger accounts and positions, so balances, reports, the overview and
 * the tax sheets keep working unchanged; this record only says where things are and whose.
 *
 * One holder, or a joint account with a first and a second holder; the order is kept in the
 * ledger accounts' `holders` (first = principal).
 *
 * Values at a date: the balance the bank shows on a day is recorded as a check (conferência) and,
 * when the user asks, the difference becomes an adjustment against opening equity, so the app's
 * balance on that day equals the bank's. Investments get a valuation on that date.
 */
import { z } from "zod";

import { bank as catalogBank } from "../catalogs/catalogs.ts";
import { ValueNature } from "../investments/model.ts";
import { valueAt } from "../investments/performance.ts";
import { profiles } from "../investments/profile.ts";
import { addValuation, assets, correctValuation, positions, valuationsOf } from "../investments/service.ts";
import { formatDateBr, type IsoDate } from "../lib/dates.ts";
import { record as recordBalanceCheck } from "./balance_checks.ts";
import { collapseSpaces, getOrKeyError, head, pyEquals } from "../lib/py.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { zId } from "../lib/schema.ts";
import * as records from "../tax/records.ts";
import { TaxSubject } from "../tax/model.ts";
import { DomainError, Ledger } from "./ledger.ts";
import {
  AccountSubtype,
  AccountType,
  type LedgerAccount,
  LedgerAccountSchema,
  type Operation,
  OperationKind,
  operation,
  zEntityId,
} from "./model.ts";
import { isCents, toDecimal, ZERO } from "./money.ts";
import * as queries from "./queries.ts";

/** Letters, digits and symbols; no spaces. */
export const TOKEN = /^\S{1,30}$/u;

export const BankAccountSchema = z.strictObject({
  id: zEntityId,
  name: z.string().min(1).max(120), // how the family calls it
  bank_code: z
    .string()
    .regex(/^\d{3}$/)
    .nullable()
    .default(null), // COMPE
  bank_name: z.string().min(1).max(150),
  branch: z.string().regex(TOKEN).nullable().default(null),
  number: z.string().regex(TOKEN).nullable().default(null),
  holder_id: zId,
  co_holder_id: zId.nullable().default(null), // joint account: the second holder
  checking_id: zId.nullable().default(null),
  savings_id: zId.nullable().default(null),
  archived: z.boolean().default(false),
});
export type BankAccount = Readonly<z.output<typeof BankAccountSchema>>;

Ledger.registerKind("bank_account", BankAccountSchema);

export const Part = { CHECKING: "checking", SAVINGS: "savings" } as const;
export type Part = (typeof Part)[keyof typeof Part];

export const PART_LABELS: Readonly<Record<Part, string>> = { checking: "Conta corrente", savings: "Poupança" };
export const PART_SUBTYPES: Readonly<Record<Part, AccountSubtype>> = {
  checking: AccountSubtype.CHECKING,
  savings: AccountSubtype.SAVINGS,
};

/** Python's `BankAccount.joint` property. */
export function joint(item: BankAccount): boolean {
  return item.co_holder_id !== null;
}

/** Python's `BankAccount.holders` property. */
export function holders(item: BankAccount): Id[] {
  return item.co_holder_id ? [item.holder_id, item.co_holder_id] : [item.holder_id];
}

/** 'Banco X (341), ag. 0001, conta 12345-6' (Python's `BankAccount.where`). */
export function where(item: BankAccount): string {
  const bankText = item.bank_code ? `${item.bank_name} (${item.bank_code})` : item.bank_name;
  const parts = [bankText];
  if (item.branch) parts.push(`ag. ${item.branch}`);
  if (item.number) parts.push(`conta ${item.number}`);
  return parts.join(", ");
}

/** Python's `BankAccount.components()`. */
export function components(item: BankAccount): [Part, Id][] {
  const out: [Part, Id][] = [];
  if (item.checking_id) out.push([Part.CHECKING, item.checking_id]);
  if (item.savings_id) out.push([Part.SAVINGS, item.savings_id]);
  return out;
}

export function bankAccounts(ledger: Ledger) {
  return ledger.entities<BankAccount>("bank_account");
}

/** The bank account a ledger account belongs to. */
export function ofAccount(ledger: Ledger, accountId: Id): BankAccount | null {
  return (
    [...bankAccounts(ledger).values()].find((b) => accountId === b.checking_id || accountId === b.savings_id) ?? null
  );
}

export function positionsOf(ledger: Ledger, bankId: Id): Id[] {
  const held = new Set(
    [...profiles(ledger).values()].filter((p) => p.bank_account_id === bankId).map((p) => p.position_id),
  );
  return [...positions(ledger).values()].filter((p) => held.has(p.id) && !p.closed).map((p) => p.id);
}

function clean(value: string | null, label: string): string | null {
  const text = (value || "").trim();
  if (!text) return null;
  if (!TOKEN.test(text)) throw new DomainError(`${label}: use letras, números e símbolos, sem espaços (até 30).`);
  return text;
}

function check(ledger: Ledger, item: BankAccount): void {
  if (!ledger.members.has(item.holder_id)) throw new DomainError("Escolha o titular da conta.");
  if (item.co_holder_id !== null) {
    if (!ledger.members.has(item.co_holder_id)) throw new DomainError("Escolha o segundo titular.");
    if (item.co_holder_id === item.holder_id) throw new DomainError("O segundo titular precisa ser outra pessoa.");
  }
  if (item.bank_code !== null && catalogBank(item.bank_code) === null) {
    throw new DomainError("Banco fora da lista de códigos COMPE.");
  }
  for (const [part, accountId] of components(item)) {
    const account = ledger.accounts.get(accountId);
    if (account === undefined || account.subtype !== PART_SUBTYPES[part]) {
      throw new DomainError(`A ${PART_LABELS[part].toLowerCase()} escolhida não é do tipo certo.`);
    }
    const other = ofAccount(ledger, accountId);
    if (other !== null && other.id !== item.id) {
      throw new DomainError(`${account.name} já pertence à conta bancária ${other.name}.`);
    }
  }
}

export interface BuildFields {
  readonly name: string;
  readonly bank_code: string | null;
  readonly bank_name: string | null;
  readonly branch: string | null;
  readonly number: string | null;
  readonly holder_id: Id;
  readonly co_holder_id?: Id | null;
}

export function build(fields: BuildFields): BankAccount {
  const found = catalogBank(fields.bank_code);
  if (fields.bank_code && found === null) throw new DomainError("Banco fora da lista de códigos COMPE.");
  const label = found ? found.name : collapseSpaces(fields.bank_name ?? "");
  if (!label) throw new DomainError("Escolha o banco ou informe o nome da instituição.");
  const title = collapseSpaces(fields.name) || (found ? found.short_name : label);
  return BankAccountSchema.parse({
    name: head(title, 120),
    bank_code: found ? found.code : null,
    bank_name: head(label, 150),
    branch: clean(fields.branch, "Agência"),
    number: clean(fields.number, "Conta"),
    holder_id: fields.holder_id,
    co_holder_id: fields.co_holder_id ?? null,
  });
}

function newPartAccount(ledger: Ledger, item: BankAccount, part: Part): LedgerAccount {
  return ledger.addAccount(
    LedgerAccountSchema.parse({
      name: head(`${item.name} — ${PART_LABELS[part].toLowerCase()}`, 120),
      type: AccountType.ASSET,
      subtype: PART_SUBTYPES[part],
      institution: head(item.bank_name, 120),
      masked_number: masked(item),
      holders: holders(item),
    }),
  );
}

export interface CreateOptions {
  /** Each part is new (true), an existing ledger account (its id) or absent (false). */
  readonly checking?: boolean | Id;
  readonly savings?: boolean | Id;
  readonly opening?: ReadonlyMap<Part, readonly [Dec, IsoDate]> | null;
}

/** Saves a bank account. Each part is new (true), an existing ledger account (its id) or absent. */
export function create(ledger: Ledger, item: BankAccount, options: CreateOptions = {}): BankAccount {
  if (bankAccounts(ledger).has(item.id)) throw new DomainError("Conta bancária já cadastrada.");
  const wanted: [Part, boolean | Id][] = [
    [Part.CHECKING, options.checking ?? false],
    [Part.SAVINGS, options.savings ?? false],
  ];
  const ids = new Map<Part, Id | null>();
  for (const [part, want] of wanted) ids.set(part, typeof want === "string" ? want : null);
  const draft: BankAccount = { ...item, checking_id: ids.get(Part.CHECKING)!, savings_id: ids.get(Part.SAVINGS)! };
  check(ledger, draft);
  for (const [part, want] of wanted) {
    if (want === true) ids.set(part, newPartAccount(ledger, item, part).id);
  }
  const saved = ledger.put("bank_account", {
    ...draft,
    checking_id: ids.get(Part.CHECKING)!,
    savings_id: ids.get(Part.SAVINGS)!,
  });
  sync(ledger, saved);
  for (const [part, [value, on]] of options.opening ?? new Map<Part, readonly [Dec, IsoDate]>()) {
    const accountId = ids.get(part) ?? null;
    if (accountId !== null && !value.isZero()) ledger.recordOpeningBalance(accountId, value, on);
  }
  return saved;
}

/** Saves changes (bank, numbers, holders) and adds missing parts; ledger accounts follow. */
export function update(ledger: Ledger, item: BankAccount, add: readonly Part[] = []): BankAccount {
  const current = bankAccounts(ledger).get(item.id);
  if (current === undefined) throw new DomainError("Conta bancária inexistente.");
  check(ledger, item);
  let next = item;
  for (const part of add) {
    if (!components(next).some(([p]) => p === part)) {
      const account = newPartAccount(ledger, next, part);
      next = part === Part.CHECKING ? { ...next, checking_id: account.id } : { ...next, savings_id: account.id };
    }
  }
  const saved = pyEquals(next, current)
    ? next
    : ledger.put("bank_account", next, { reason: "conta bancária alterada" });
  sync(ledger, saved);
  return saved;
}

export function archive(ledger: Ledger, bankId: Id): void {
  const item = bankAccounts(ledger).get(bankId);
  if (item !== undefined && !item.archived) {
    ledger.put("bank_account", { ...item, archived: true }, { reason: "conta bancária encerrada" });
  }
}

function masked(item: BankAccount): string | null {
  const parts = [item.branch ? `ag ${item.branch}` : "", item.number ? `c ${item.number}` : ""];
  const text = parts.filter(Boolean).join(" ");
  return head(text, 32) || null;
}

/** Holders, institution and number go to the ledger accounts and the investments held there. */
function sync(ledger: Ledger, item: BankAccount): void {
  for (const [, accountId] of components(item)) {
    const account = ledger.account(accountId);
    const updated: LedgerAccount = {
      ...account,
      holders: holders(item),
      institution: head(item.bank_name, 120),
      masked_number: masked(item),
    };
    if (!pyEquals(updated, account)) ledger.updateAccount(updated, "dados da conta bancária");
  }
  for (const positionId of positionsOf(ledger, item.id)) {
    const pos = getOrKeyError(positions(ledger), positionId);
    if (pos.holder_id !== item.holder_id) {
      ledger.put("position", { ...pos, holder_id: item.holder_id }, { reason: "titular da conta" });
      const account = ledger.accounts.get(pos.account_id);
      if (account !== undefined && !pyEquals(account.holders, [item.holder_id])) {
        ledger.updateAccount({ ...account, holders: [item.holder_id] }, "titular da conta");
      }
    }
  }
  identifyBank(ledger, item);
}

/** The bank's CNPJ (from the COMPE list) for the tax sheets, unless the user set another. */
function identifyBank(ledger: Ledger, item: BankAccount): void {
  const found = catalogBank(item.bank_code);
  if (found === null || !found.cnpj) return;
  for (const [, accountId] of components(item)) {
    if (records.identity(ledger, TaxSubject.ACCOUNT, accountId) === null) {
      records.setIdentity(ledger, TaxSubject.ACCOUNT, accountId, found.cnpj, found.name);
    }
  }
}

// ── values at a date ──────────

export interface Value {
  readonly label: string;
  readonly kind: string; // "checking", "savings" or "investment"
  readonly ref: Id; // ledger account or position
  readonly value: Dec | null; // null: unknown on that date (an investment never valued)
}

/** What the app has for each part of the bank account at the end of a day. */
export function valuesAt(ledger: Ledger, bankId: Id, on: IsoDate): Value[] {
  const item = getOrKeyError(bankAccounts(ledger), bankId);
  const out: Value[] = components(item).map(([part, accountId]) => ({
    label: PART_LABELS[part],
    kind: part,
    ref: accountId,
    value: queries.balance(ledger, accountId, on),
  }));
  for (const positionId of positionsOf(ledger, bankId)) {
    const pos = getOrKeyError(positions(ledger), positionId);
    const observed = valueAt(ledger, positionId, on);
    out.push({
      label: getOrKeyError(assets(ledger), pos.asset_id).name,
      kind: "investment",
      ref: positionId,
      value: observed ? observed.valuation.value : null,
    });
  }
  return out;
}

export function total(values: readonly Value[]): Dec | null {
  const known = values.flatMap((v) => (v.value !== null ? [v.value] : []));
  return known.length ? Dec.sum(known, ZERO) : null;
}

export interface Recorded {
  readonly checks: number;
  readonly adjustments: number;
  readonly valuations: number;
}

export interface RecordValuesOptions {
  readonly adjust?: ReadonlySet<Id> | null;
  readonly note?: string | null;
}

export const SOURCE = "valor informado";

/**
 * Values the bank shows on `on`, by ledger account or position id.
 *
 * Accounts: a conferência; for those in `adjust`, the difference is posted so the app's balance
 * equals the bank's that day. Investments: a valuation of that date ("valor informado").
 * `today` replaces Python's `date.today()` (a date in the future is refused).
 */
export function recordValues(
  ledger: Ledger,
  bankId: Id,
  on: IsoDate,
  values: ReadonlyMap<Id, unknown>,
  today: IsoDate,
  options: RecordValuesOptions = {},
): Recorded {
  const item = bankAccounts(ledger).get(bankId);
  if (item === undefined) throw new DomainError("Conta bancária inexistente.");
  if (on > today) throw new DomainError("A data não pode estar no futuro.");
  const accounts = new Set(components(item).map(([, accountId]) => accountId));
  const held = new Set(positionsOf(ledger, bankId));
  let checks = 0;
  let adjustments = 0;
  let valuations = 0;
  const text = (options.note ?? "").trim() || "valor informado";
  const adjust = options.adjust ?? null;
  for (const [ref, raw] of values) {
    const value = raw instanceof Dec ? raw : toDecimal(raw);
    if (!isCents(value)) throw new DomainError("Use valores em reais e centavos.");
    if (accounts.has(ref)) {
      recordBalanceCheck(ledger, ref, on, value, text);
      checks += 1;
      if (adjust && adjust.size && adjust.has(ref) && adjustBalance(ledger, ref, on, value) !== null) adjustments += 1;
    } else if (held.has(ref)) {
      if (value.isNegative()) throw new DomainError("O valor de um investimento não pode ser negativo.");
      const same = valuationsOf(ledger, ref).find((v) => v.on === on && v.source === SOURCE);
      if (same === undefined) {
        addValuation(ledger, ref, on, value, ValueNature.GROSS, { source: SOURCE, note: text });
      } else if (!same.value.eq(value)) {
        correctValuation(ledger, same.id, value, "valor informado de novo");
      }
      valuations += 1;
    } else {
      throw new DomainError("Esse item não pertence a esta conta bancária.");
    }
  }
  return { checks, adjustments, valuations };
}

/** Posts the difference against opening equity so the balance at the end of `on` is `informed`. */
export function adjustBalance(ledger: Ledger, accountId: Id, on: IsoDate, informed: Dec): Operation | null {
  const account = ledger.account(accountId);
  if (account.type !== AccountType.ASSET) throw new DomainError("Só contas de dinheiro recebem ajuste de saldo.");
  const difference = informed.sub(queries.balance(ledger, accountId, on));
  if (difference.isZero()) return null;
  const equity = ledger.meta.opening_equity_id;
  if (equity === null) throw new DomainError("Cofre sem conta de patrimônio de abertura.");
  let first = true;
  for (const op of ledger.activeOperations()) {
    if (op.postings.some((p) => p.account_id === accountId)) {
      first = false;
      break;
    }
  }
  return ledger.addOperation(
    operation({
      kind: OperationKind.OPENING_BALANCE,
      description: head(
        first
          ? `Saldo de abertura — ${account.name}`
          : `Ajuste ao saldo informado em ${formatDateBr(on)} — ${account.name}`,
        500,
      ),
      postings: [
        { account_id: accountId, amount: difference, member_id: null },
        { account_id: equity, amount: difference.negate(), member_id: null },
      ],
      occurred_on: on,
      settled_on: on,
    }),
  );
}
