/**
 * The year as the return's sheets read it (fichas): income, payments, assets and debts.
 * Port of `tax/declaration.py`.
 *
 * Support material: values come from what was recorded, by cash date (the return follows the
 * cash regime). Natures, groups and codes are the user's choices; where none was made the row
 * says so instead of guessing. A declarant sees their own items and their dependents'.
 */
import { assetLabel, CHECKING, SAVINGS } from "../catalogs/irpf.ts";
import { bank } from "../catalogs/catalogs.ts";
import * as banking from "../domain/banking.ts";
import * as deductibles from "../domain/deductibles.ts";
import { DeductibleKind } from "../domain/deductibles.ts";
import type { Ledger } from "../domain/ledger.ts";
import * as merchants from "../domain/merchants.ts";
import { AccountSubtype, AccountType, cashDate, type Operation, type Posting } from "../domain/model.ts";
import { ZERO } from "../domain/money.ts";
import * as queries from "../domain/queries.ts";
import * as sharing from "../domain/sharing.ts";
import { type IsoDate, makeDate, type YearMonth, yearOf, ymOf, ymStr } from "../lib/dates.ts";
import type { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { casefold, sortedBy } from "../lib/text.ts";
import { AssetClass, EventKind, type InvestmentEvent, realizedGain } from "../investments/model.ts";
import { description, profileOf } from "../investments/profile.ts";
import { assets as assetEntities, events, positions } from "../investments/service.ts";
import { getOrKeyError } from "../lib/py.ts";
import * as records from "./records.ts";
import {
  ASSET_GROUPS,
  type DeclaredAsset,
  FilingSubject,
  IncomeKind,
  IncomeNature,
  NatureSubject,
  PaymentPurpose,
  TaxSubject,
} from "./model.ts";

export const NOTICE =
  "Material de apoio à declaração, a partir do que foi registrado. A natureza de cada rendimento, " +
  "os grupos e os códigos dos bens são escolhas suas; nada é classificado sozinho. Confira com os informes.";

/** Gains of these classes are declared month by month in Renda variável, not as exclusive income. */
export const VARIABLE_CLASSES: ReadonlySet<AssetClass> = new Set([AssetClass.STOCK, AssetClass.REIT, AssetClass.ETF]);

function when(op: Operation): IsoDate | null {
  return cashDate(op);
}

/** Whose item this is: the rateio share, the operation's member or the sole holder of its account. */
function ownerOf(ledger: Ledger, op: Operation, posting: Posting | null = null): Id | null {
  const member = (posting !== null ? posting.member_id : null) || op.member_id;
  if (member !== null) return member;
  const found = new Set<Id>();
  for (const p of op.postings) {
    const account = ledger.account(p.account_id);
    if (account.type !== AccountType.ASSET && account.type !== AccountType.LIABILITY) continue;
    for (const h of account.holders) found.add(h);
  }
  // Python's `next(iter(holders))` of a one-element set.
  return found.size === 1 ? [...found][0]! : null;
}

function isIn(member: Id | null, people: ReadonlySet<Id> | null): boolean {
  return people === null || (member !== null && people.has(member));
}

function ownersIn(owners: readonly Id[], people: ReadonlySet<Id> | null): boolean {
  return people === null || owners.some((o) => people.has(o));
}

function investmentOperations(ledger: Ledger): Map<Id, InvestmentEvent> {
  const out = new Map<Id, InvestmentEvent>();
  for (const event of events(ledger).values()) for (const opId of event.operation_ids) out.set(opId, event);
  return out;
}

// ── income ──────────

/** Rendimentos tributáveis recebidos de pessoa jurídica: one payer, one person. */
export interface TaxableRow {
  source_id: Id; // the income category
  payer: string;
  tax_id: string | null;
  member_id: Id | null;
  taxable: Dec;
  social_security: Dec;
  withheld: Dec;
  thirteenth: Dec;
  thirteenth_withheld: Dec;
  net_only: number; // deposits without the payslip's gross: counted at the amount received
  operations: Id[];
}

/** Isentos, exclusivos or Carnê-Leão: one source, one person. */
export interface OtherIncomeRow {
  nature: IncomeNature | null; // null: not classified yet
  source: string;
  subject: NatureSubject;
  ref: Id;
  tax_id: string | null;
  member_id: Id | null;
  amount: Dec;
  withheld: Dec;
  operations: Id[];
  code: string | null; // the IRPF line ("12"), when the investment's characteristics say it
}

export interface CarneLeaoMonth {
  month: YearMonth;
  member_id: Id | null;
  amount: Dec;
  paid: Dec;
}

export interface Income {
  taxable: TaxableRow[];
  other: OtherIncomeRow[];
  carne_leao: CarneLeaoMonth[];
  unassigned: number; // income of nobody in particular: left out of a declarant's view
}

/** Python's `Income.by_nature(nature)`. */
export function byNature(income: Income, nature: IncomeNature | null): OtherIncomeRow[] {
  return income.other.filter((r) => r.nature === nature);
}

/** Python's `Income.unclassified` property. */
export function unclassified(income: Income): OtherIncomeRow[] {
  return byNature(income, null);
}

function categoryPayer(ledger: Ledger, categoryId: Id): [string, string | null] {
  const found = records.identity(ledger, TaxSubject.CATEGORY, categoryId);
  const name = ledger.account(categoryId).name;
  return [found ? found.name || name : name, found ? found.tax_id : null];
}

type OtherKey = string;
const otherKey = (subject: NatureSubject, ref: Id, member: Id | null): OtherKey => `${subject}|${ref}|${member}`;

export function income(ledger: Ledger, year: number, people: ReadonlySet<Id> | null = null): Income {
  const out: Income = { taxable: [], other: [], carne_leao: [], unassigned: 0 };
  const invest = investmentOperations(ledger);
  const taxable = new Map<string, TaxableRow>();
  const other = new Map<OtherKey, OtherIncomeRow>();
  const carne = new Map<string, { month: YearMonth; member: Id | null; value: Dec }>();
  for (const op of ledger.activeOperations()) {
    const date = when(op);
    if (date === null || yearOf(date) !== year || invest.has(op.id)) continue;
    for (const p of op.postings) {
      const account = ledger.account(p.account_id);
      if (account.type !== AccountType.INCOME || p.amount.isZero()) continue;
      const member = ownerOf(ledger, op, p);
      if (!isIn(member, people)) {
        if (people !== null && member === null) out.unassigned += 1;
        continue;
      }
      const value = p.amount.negate();
      const nature = records.natureOf(ledger, NatureSubject.CATEGORY, account.id);
      if (nature === IncomeNature.TAXABLE_PJ) {
        const key = `${account.id}|${member}`;
        let row = taxable.get(key);
        if (row === undefined) {
          const [payer, taxId] = categoryPayer(ledger, account.id);
          row = {
            source_id: account.id,
            payer,
            tax_id: taxId,
            member_id: member,
            taxable: ZERO,
            social_security: ZERO,
            withheld: ZERO,
            thirteenth: ZERO,
            thirteenth_withheld: ZERO,
            net_only: 0,
            operations: [],
          };
          taxable.set(key, row);
        }
        addPayslip(ledger, row, op, value);
      } else if (nature === IncomeNature.CARNE_LEAO) {
        const month = ymOf(date);
        const key = `${ymStr(month)}|${member}`;
        const entry = carne.get(key);
        if (entry === undefined) carne.set(key, { month, member, value: ZERO.add(value) });
        else entry.value = entry.value.add(value);
        addOther(otherRow(ledger, other, nature, NatureSubject.CATEGORY, account.id, member), op, value);
      } else if (nature !== IncomeNature.IGNORED) {
        addOther(otherRow(ledger, other, nature, NatureSubject.CATEGORY, account.id, member), op, value);
      }
    }
  }
  investmentIncome(ledger, year, people, other);
  out.taxable = sortedBy([...taxable.values()], (r) => [casefold(r.payer), pyStr(r.member_id)]);
  out.other = sortedBy([...other.values()], (r) => [r.nature ?? "", casefold(r.source), pyStr(r.member_id)]);
  out.carne_leao = sortedBy([...carne.values()], (e) => [e.month.year, e.month.month])
    .filter((e) => !e.value.isZero())
    .map((e) => ({
      month: e.month,
      member_id: e.member,
      amount: e.value,
      paid: records.paid(ledger, PaymentPurpose.CARNE_LEAO, e.month, e.member),
    }));
  return out;
}

function addPayslip(ledger: Ledger, row: TaxableRow, op: Operation, received: Dec): void {
  const detail = records.detailOf(ledger, op.id);
  row.operations.push(op.id);
  const gross = detail !== null && detail.gross !== null ? detail.gross : null;
  if (gross === null) row.net_only += 1;
  const amount = gross !== null ? gross : received;
  const withheld = detail !== null && detail.withheld !== null ? detail.withheld : ZERO;
  if (detail !== null && detail.kind === IncomeKind.THIRTEENTH) {
    row.thirteenth = row.thirteenth.add(amount);
    row.thirteenth_withheld = row.thirteenth_withheld.add(withheld);
    return;
  }
  row.taxable = row.taxable.add(amount);
  row.withheld = row.withheld.add(withheld);
  if (detail !== null && detail.social_security !== null) {
    row.social_security = row.social_security.add(detail.social_security);
  }
}

function addOther(row: OtherIncomeRow, op: Operation | null, value: Dec, withheld: Dec = ZERO): void {
  row.amount = row.amount.add(value);
  row.withheld = row.withheld.add(withheld);
  if (op !== null) row.operations.push(op.id);
}

function otherRow(
  ledger: Ledger,
  rows: Map<OtherKey, OtherIncomeRow>,
  nature: IncomeNature | null,
  subject: NatureSubject,
  ref: Id,
  member: Id | null,
  source: string | null = null,
  taxId: string | null = null,
): OtherIncomeRow {
  const key = otherKey(subject, ref, member);
  let row = rows.get(key);
  if (row === undefined) {
    let src = source;
    let tid = taxId;
    if (subject === NatureSubject.CATEGORY) [src, tid] = categoryPayer(ledger, ref);
    row = {
      nature,
      source: src || "?",
      subject,
      ref,
      tax_id: tid,
      member_id: member,
      amount: ZERO,
      withheld: ZERO,
      operations: [],
      code: null,
    };
    rows.set(key, row);
  }
  return row;
}

function investmentIncome(
  ledger: Ledger,
  year: number,
  people: ReadonlySet<Id> | null,
  rows: Map<OtherKey, OtherIncomeRow>,
): void {
  for (const event of events(ledger).values()) {
    if (yearOf(event.on) !== year) continue;
    const pos = positions(ledger).get(event.position_id);
    if (pos === undefined) continue;
    const asset = getOrKeyError(assetEntities(ledger), pos.asset_id);
    let value: Dec | null;
    if (event.kind === EventKind.DISTRIBUTION) {
      value = event.gross !== null ? event.gross : event.net;
    } else if (
      event.kind === EventKind.WITHDRAWAL ||
      (event.kind === EventKind.SELL && !VARIABLE_CLASSES.has(asset.asset_class))
    ) {
      value = realizedGain(event);
      if (value === null || !value.isPositive()) continue;
    } else {
      continue;
    }
    if (value === null || !isIn(pos.holder_id, people)) continue;
    const nature = records.natureOf(ledger, NatureSubject.POSITION, pos.id);
    if (nature === IncomeNature.IGNORED) continue;
    const institution = event.cash_account_id
      ? records.identity(ledger, TaxSubject.ACCOUNT, event.cash_account_id)
      : null;
    addOther(
      otherRow(
        ledger,
        rows,
        nature,
        NatureSubject.POSITION,
        pos.id,
        pos.holder_id,
        asset.name,
        institution ? institution.tax_id : null,
      ),
      null,
      value,
      event.tax_withheld,
    );
    rows.get(otherKey(NatureSubject.POSITION, pos.id, pos.holder_id))!.code = records.incomeCodeOf(ledger, pos.id);
  }
}

// ── payments (Pagamentos efetuados) ──────────

/**
 * Whether an operation has a receipt attached (`domain/attachments.of_operation`).
 * TODO(W6-integration): `domain/attachments.ts` is ported with the import pipeline and registers the
 * "attachment" kind; until it lands this reads the same collection by its kind name, so a project
 * that has attachments gives the same answer as the desktop.
 */
function hasAttachment(ledger: Ledger, operationId: Id): boolean {
  for (const a of ledger.entities<{ readonly operation_id: Id }>("attachment").values()) {
    if (a.operation_id === operationId) return true;
  }
  return false;
}

export interface PaymentRow {
  kind: DeductibleKind;
  payee_key: string;
  payee: string;
  tax_id: string | null;
  beneficiary_id: Id | null;
  paid: Dec;
  not_deductible: Dec; // reimbursed by a health plan or employer
  operations: Id[];
  without_receipt: number;
}

/** Python's `PaymentRow.net` property. */
export function paymentNet(row: PaymentRow): Dec {
  return row.paid.sub(row.not_deductible);
}

export function payments(ledger: Ledger, year: number, people: ReadonlySet<Id> | null = null): PaymentRow[] {
  const receipts = new Map<Id, Id>();
  for (const item of sharing.reimbursements(ledger).values()) {
    for (const opId of item.receipt_ids) receipts.set(opId, item.operation_id);
  }
  const rows = new Map<string, PaymentRow>();
  for (const group of deductibles.annual(ledger, year)) {
    for (const line of group.lines) {
      const op = line.operation;
      const original = ledger.operations.get(receipts.get(op.id) ?? op.id) ?? op;
      const beneficiary = line.memberId || ownerOf(ledger, original);
      if (!isIn(beneficiary, people)) continue;
      const key = merchants.keyOf(original.description);
      const rowKey = `${group.kind}|${key}|${beneficiary}`;
      let row = rows.get(rowKey);
      if (row === undefined) {
        const found = records.identity(ledger, TaxSubject.MERCHANT, key);
        const payee = (found && found.name ? found.name : null) || merchants.merchantOf(ledger, original.description);
        row = {
          kind: group.kind,
          payee_key: key,
          payee,
          tax_id: found ? found.tax_id : null,
          beneficiary_id: beneficiary,
          paid: ZERO,
          not_deductible: ZERO,
          operations: [],
          without_receipt: 0,
        };
        rows.set(rowKey, row);
      }
      if (receipts.has(op.id)) {
        row.not_deductible = row.not_deductible.add(line.amount.negate());
        continue;
      }
      row.paid = row.paid.add(line.amount);
      if (!row.operations.includes(op.id)) {
        row.operations.push(op.id);
        if (line.amount.isPositive() && !hasAttachment(ledger, op.id)) row.without_receipt += 1;
      }
    }
  }
  const order = Object.values(DeductibleKind);
  return sortedBy([...rows.values()], (r) => [order.indexOf(r.kind), casefold(r.payee), pyStr(r.beneficiary_id)]);
}

// ── assets and debts ──────────

export interface AssetRow {
  subject: string; // "account", "position" or "declared"
  ref: Id;
  name: string;
  group: string | null;
  code: string | null;
  suggested: boolean; // group suggested by the app, still to be confirmed
  description: string;
  tax_id: string | null;
  owners: readonly Id[];
  previous: Dec | null; // 31/12 of the year before; null: cost unknown
  current: Dec | null;
}

/** Python's `AssetRow.group_label` property. */
export function groupLabel(row: AssetRow): string {
  return row.code ? assetLabel(row.group, row.code) : (ASSET_GROUPS.get(row.group ?? "") ?? "a definir");
}

function positionAccounts(ledger: Ledger): Map<Id, Id> {
  return new Map([...positions(ledger).values()].map((p) => [p.account_id, p.id]));
}

/** Python's `str(None)` for ids in sort keys and names. */
function pyStr(value: Id | null): string {
  return value === null ? "None" : value;
}

/** Bens e Direitos at acquisition cost (what is still held), never at market value. */
export function assets(ledger: Ledger, year: number, people: ReadonlySet<Id> | null = null): AssetRow[] {
  const end = makeDate(year, 12, 31);
  const before = makeDate(year - 1, 12, 31);
  const now = queries.balances(ledger, end);
  const then = queries.balances(ledger, before);
  const held = positionAccounts(ledger);
  const out: AssetRow[] = [];
  for (const account of sortedBy([...ledger.accounts.values()], (a) => casefold(a.name))) {
    if (account.type !== AccountType.ASSET || held.has(account.id) || account.subtype === AccountSubtype.INVESTMENT) {
      continue;
    }
    const current = now.get(account.id) ?? ZERO;
    const previous = then.get(account.id) ?? ZERO;
    if (current.isZero() && previous.isZero()) continue;
    if (!ownersIn(account.holders, people) || (people !== null && !account.holders.length)) continue;
    const filing = records.filingOf(ledger, FilingSubject.ACCOUNT, account.id);
    const bankId = records.identity(ledger, TaxSubject.ACCOUNT, account.id);
    let fallback = [account.name, account.institution, account.masked_number].filter((x) => x).join(" ");
    const [group, code, suggested] = accountCode(ledger, account.id, account.subtype);
    const partOf = banking.ofAccount(ledger, account.id);
    if (partOf !== null) {
      const kind = account.id === partOf.checking_id ? "Conta corrente" : "Conta poupança";
      fallback = `${kind} — ${banking.where(partOf)}`;
    }
    out.push({
      subject: "account",
      ref: account.id,
      name: account.name,
      group: filing ? filing.group : group,
      code: filing ? filing.code : code,
      suggested: filing === null && suggested,
      description: filing && filing.description ? filing.description : fallback,
      tax_id: bankId ? bankId.tax_id : null,
      owners: account.holders,
      previous,
      current,
    });
  }
  for (const pos of positions(ledger).values()) {
    const owners = pos.holder_id ? [pos.holder_id] : [];
    if (people !== null && !ownersIn(owners, people)) continue;
    const costNow = pos.cost_known ? queries.balance(ledger, pos.account_id, end) : null;
    const costThen = pos.cost_known ? queries.balance(ledger, pos.account_id, before) : null;
    if (pos.cost_known && costNow!.isZero() && costThen!.isZero()) continue;
    const asset = getOrKeyError(assetEntities(ledger), pos.asset_id);
    const filing = records.filingOf(ledger, FilingSubject.POSITION, pos.id);
    const broker = records.identity(ledger, TaxSubject.ACCOUNT, pos.account_id);
    const profile = profileOf(ledger, pos.id);
    const typed = profile !== null && profile.irpf_group !== null;
    const heldAt =
      profile && profile.bank_account_id ? (banking.bankAccounts(ledger).get(profile.bank_account_id) ?? null) : null;
    const bankTaxId = bankCnpj(ledger, heldAt);
    out.push({
      subject: "position",
      ref: pos.id,
      name: asset.name,
      group: filing
        ? filing.group
        : typed && profile
          ? profile.irpf_group
          : records.suggestedGroup(null, asset.asset_class),
      code: filing ? filing.code : typed && profile ? profile.irpf_code : null,
      suggested: filing === null && !typed,
      description: filing && filing.description ? filing.description : description(ledger, pos.id) || asset.name,
      tax_id: broker ? broker.tax_id : bankTaxId,
      owners,
      previous: costThen,
      current: costNow,
    });
  }
  for (const item of records.declaredAssets(ledger).values()) {
    const owners = item.owner_id ? [item.owner_id] : [];
    if (people !== null && !ownersIn(owners, people)) continue;
    const current = heldCost(item, end);
    const previous = heldCost(item, before);
    const soldThisYear = item.sold_on !== null && yearOf(item.sold_on) === year;
    if (current.isZero() && previous.isZero() && !soldThisYear) continue;
    out.push({
      subject: "declared",
      ref: item.id,
      name: item.name,
      group: item.group,
      code: item.code,
      suggested: false,
      description: item.description || item.name,
      tax_id: null,
      owners,
      previous,
      current,
    });
  }
  return sortedBy(out, (r) => [r.group || "zz", r.code || "zz", casefold(r.name)]);
}

/** A bank account's checking and savings have a known code; other accounts get a suggested group. */
function accountCode(ledger: Ledger, accountId: Id, subtype: AccountSubtype): [string | null, string | null, boolean] {
  const partOf = banking.ofAccount(ledger, accountId);
  if (partOf !== null) {
    const [group, code] = accountId === partOf.checking_id ? CHECKING : SAVINGS;
    return [group, code, false];
  }
  return [records.suggestedGroup(subtype), null, true];
}

function bankCnpj(ledger: Ledger, item: banking.BankAccount | null): string | null {
  if (item === null) return null;
  for (const [, accountId] of banking.components(item)) {
    const found = records.identity(ledger, TaxSubject.ACCOUNT, accountId);
    if (found !== null) return found.tax_id;
  }
  const listed = bank(item.bank_code);
  return listed && listed.cnpj ? listed.cnpj : null;
}

function heldCost(item: DeclaredAsset, day: IsoDate): Dec {
  const owned = item.acquired_on <= day && (item.sold_on === null || item.sold_on > day);
  return owned ? item.cost : ZERO;
}

export interface DebtRow {
  account_id: Id;
  name: string;
  tax_id: string | null;
  owners: readonly Id[];
  previous: Dec;
  current: Dec;
}

export const DEBT_SUBTYPES: ReadonlySet<AccountSubtype> = new Set([
  AccountSubtype.LOAN,
  AccountSubtype.OTHER_LIABILITY,
]);

/** Dívidas e Ônus Reais: loans and other debts on 31/12. Card bills and taxes due are left out. */
export function debts(ledger: Ledger, year: number, people: ReadonlySet<Id> | null = null): DebtRow[] {
  const end = makeDate(year, 12, 31);
  const before = makeDate(year - 1, 12, 31);
  const now = queries.balances(ledger, end);
  const then = queries.balances(ledger, before);
  const out: DebtRow[] = [];
  for (const account of sortedBy([...ledger.accounts.values()], (a) => casefold(a.name))) {
    if (account.type !== AccountType.LIABILITY || !DEBT_SUBTYPES.has(account.subtype)) continue;
    const current = now.get(account.id) ?? ZERO;
    const previous = then.get(account.id) ?? ZERO;
    if (current.isZero() && previous.isZero()) continue;
    if (people !== null && !ownersIn(account.holders, people)) continue;
    const lender = records.identity(ledger, TaxSubject.ACCOUNT, account.id);
    out.push({
      account_id: account.id,
      name: account.name,
      tax_id: lender ? lender.tax_id : null,
      owners: account.holders,
      previous,
      current,
    });
  }
  return out;
}

// ── people ──────────

export interface Dependent {
  readonly member_id: Id;
  readonly name: string;
  readonly cpf: string | null;
  readonly birth_date: IsoDate | null;
  readonly relation: string | null;
}

export function dependents(ledger: Ledger, declarantId: Id | null): Dependent[] {
  if (declarantId === null) return [];
  const out: Dependent[] = [];
  for (const memberId of records.dependentsOf(ledger, declarantId)) {
    const info = records.memberInfo(ledger, memberId);
    const member = ledger.members.get(memberId);
    if (member === undefined || info === null) continue;
    out.push({
      member_id: memberId,
      name: member.name,
      cpf: info.cpf,
      birth_date: info.birth_date,
      relation: info.relation,
    });
  }
  return sortedBy(out, (d) => casefold(d.name));
}
