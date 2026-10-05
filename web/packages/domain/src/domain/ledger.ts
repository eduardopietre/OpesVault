/**
 * The Ledger aggregate: the only place where domain state changes (docs/04 §2).
 * Port of `domain/ledger.py`.
 *
 * Every change is validated against the invariants and leaves a history entry.
 * The UI never edits entities directly.
 */
import { z } from "zod";

import { type IsoDate, nowInstant, ymOf } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import { type Id, uuid5 } from "../lib/ids.ts";
import { zId } from "../lib/schema.ts";
import { casefold, sortedBy } from "../lib/text.ts";
import {
  AccountSubtype,
  AccountType,
  type Card,
  CardSchema,
  dump,
  HistoryAction,
  type HistoryEntry,
  HistoryEntrySchema,
  isActive,
  isLiquid,
  type LedgerAccount,
  LedgerAccountSchema,
  type Member,
  MemberRole,
  MemberSchema,
  type Operation,
  type OperationInput,
  OperationKind,
  OperationSchema,
  OperationStatus,
  operation,
  type Posting,
} from "./model.ts";
import { BRL, isCents, toDecimal, ZERO } from "./money.ts";
import { migrate } from "./migrations.ts";
import { HistoryList, type JournalEntry, MISSING, TrackedMap } from "./tracking.ts";

export const SCHEMA_VERSION = 2; // 2: members have a role (domain/migrations)
const META_NAMESPACE = "6f1c3d2a-1b7e-4b8e-9f00-0c0ffee0a001";
export const META_ID: Id = uuid5(META_NAMESPACE, "ledger-meta");
export const META_KIND = "ledger.meta";

/** A rejected change. The message is user-facing Portuguese without financial values. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export const LedgerMetaSchema = z.strictObject({
  schema_version: z.number().int().default(SCHEMA_VERSION),
  family_name: z.string().default(""),
  currency: z.string().default(BRL),
  opening_equity_id: zId.nullable().default(null),
});
export type LedgerMeta = Readonly<z.output<typeof LedgerMetaSchema>>;

export const DEFAULT_EXPENSE_CATEGORIES = [
  "Moradia",
  "Alimentação",
  "Transporte",
  "Saúde",
  "Educação",
  "Lazer",
  "Serviços e assinaturas",
  "Impostos e taxas",
  "Juros e encargos",
  "Outras despesas",
] as const;
export const DEFAULT_INCOME_CATEGORIES = ["Salário", "Rendimentos de investimentos", "Outras receitas"] as const;

/** A persisted row: id, kind and JSON payload (the desktop's `(id, kind, payload)`). */
export interface LedgerRecord {
  readonly id: Id;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

/** Any persisted entity: it has an id and, optionally, a version. */
export interface Entity {
  readonly id: Id;
  readonly version?: number;
}

type Schema = z.ZodType<Entity, unknown>;
export type OperationGuard = (ledger: Ledger, op: Operation) => void;
export type UpdateGuard = (ledger: Ledger, before: Operation, after: Operation) => void;

/** Kinds and guards registered by every module; `registry.ts` loads them all explicitly. */
const KINDS = new Map<string, Schema>([
  ["member", MemberSchema as unknown as Schema],
  ["account", LedgerAccountSchema as unknown as Schema],
  ["card", CardSchema as unknown as Schema],
  ["operation", OperationSchema as unknown as Schema],
  ["history", HistoryEntrySchema as unknown as Schema],
]);
const operationGuards: OperationGuard[] = [];
const updateGuards: UpdateGuard[] = [];

export interface RecordOptions {
  readonly reason?: string | null;
  readonly action?: HistoryAction | null;
}

/** In-memory family ledger. Collections are keyed by entity kind. */
export class Ledger {
  /** (kind \u0000 id) → changeCount of its last change since the last sync; drives incremental syncs. */
  dirty = new Map<string, number>();
  changeCount = 0;
  /** kind → changes to that kind: caches that read only some kinds key on these. */
  kindChanges = new Map<string, number>();
  operator: string | null = null;
  /** Schema version before an in-memory migration. */
  migratedFrom: number | null = null;
  /** Raw changes since the session started journaling; null while not recording. */
  journal: JournalEntry[] | null = null;
  /** Per-ledger caches (query index…), invalidated by `changeCount`. */
  readonly caches = new Map<string, { readonly at: number; readonly value: unknown }>();

  private metaValue: LedgerMeta;
  private readonly store = new Map<string, TrackedMap<unknown>>();
  readonly history: HistoryList;

  private readonly sink = {
    touch: (kind: string, key: Id) => this.touch(kind, key),
    journalAdd: (entry: JournalEntry) => this.journalAdd(entry),
  };

  constructor(meta: LedgerMeta | null = null) {
    this.metaValue = meta ?? LedgerMetaSchema.parse({});
    for (const kind of KINDS.keys()) if (kind !== "history") this.store.set(kind, new TrackedMap(this.sink, kind));
    this.history = new HistoryList(this.sink);
  }

  // ── registry ────────────────────────────────────────

  /** Lets later modules (imports, investments…) add persisted collections. */
  static registerKind(kind: string, schema: z.ZodType<unknown, unknown>): void {
    KINDS.set(kind, schema as Schema);
  }

  static kinds(): ReadonlyMap<string, Schema> {
    return KINDS;
  }

  static addOperationGuard(guard: OperationGuard): void {
    if (!operationGuards.includes(guard)) operationGuards.push(guard);
  }

  static addUpdateGuard(guard: UpdateGuard): void {
    if (!updateGuards.includes(guard)) updateGuards.push(guard);
  }

  // ── meta and change tracking ────────────────────────

  get meta(): LedgerMeta {
    return this.metaValue;
  }

  set meta(value: LedgerMeta) {
    const before = this.metaValue;
    this.metaValue = value;
    this.touch(META_KIND, META_ID);
    this.journalAdd(["meta", before, value]);
  }

  private touch(kind: string, key: Id): void {
    this.changeCount += 1;
    this.dirty.set(`${kind}\u0000${key}`, this.changeCount);
    this.kindChanges.set(kind, (this.kindChanges.get(kind) ?? 0) + 1);
  }

  /** How many times each kind changed: a cache that reads only `kinds` keys on this. */
  changesOf(...kinds: string[]): number[] {
    return kinds.map((kind) => this.kindChanges.get(kind) ?? 0);
  }

  /** A cached value computed from the ledger; recomputed after any change. */
  cached<T>(key: string, compute: () => T): T {
    const hit = this.caches.get(key);
    if (hit && hit.at === this.changeCount) return hit.value as T;
    const value = compute();
    this.caches.set(key, { at: this.changeCount, value });
    return value;
  }

  /** Pending changes as (kind, id) pairs. */
  dirtyKeys(): { kind: string; id: Id; seq: number }[] {
    return [...this.dirty].map(([k, seq]) => {
      const [kind = "", id = ""] = k.split("\u0000");
      return { kind, id, seq };
    });
  }

  journalAdd(entry: JournalEntry): void {
    if (this.journal !== null) this.journal.push(entry);
  }

  /** Puts back the state before `entries` (newest first). Not journaled itself. */
  revert(entries: readonly JournalEntry[]): void {
    const saved = this.journal;
    this.journal = null;
    try {
      for (const entry of [...entries].reverse()) this.applyEntry(entry, false);
    } finally {
      this.journal = saved;
    }
  }

  /** Applies `entries` again after a revert (redo). Not journaled itself. */
  replay(entries: readonly JournalEntry[]): void {
    const saved = this.journal;
    this.journal = null;
    try {
      for (const entry of entries) this.applyEntry(entry, true);
    } finally {
      this.journal = saved;
    }
  }

  private applyEntry(entry: JournalEntry, forward: boolean): void {
    switch (entry[0]) {
      case "entity": {
        const [, kind, key, before, after] = entry;
        const value = forward ? after : before;
        const collection = this.collection(kind);
        if (value === MISSING) collection.delete(key);
        else collection.set(key, value);
        break;
      }
      case "history":
        if (forward) this.history.append(entry[1]);
        else this.history.discard(entry[1]);
        break;
      case "meta":
        this.meta = (forward ? entry[2] : entry[1]) as LedgerMeta;
        break;
      case "external":
        entry[1](forward);
        break;
    }
  }

  /** Forget changes already synced; later edits stay pending (docs/03 §5). */
  markClean(upTo: number): void {
    for (const [key, seq] of [...this.dirty]) if (seq <= upTo) this.dirty.delete(key);
  }

  // ── construction ────────────────────────────────────

  static new(familyName: string): Ledger {
    const ledger = new Ledger(LedgerMetaSchema.parse({ family_name: familyName }));
    const equity = ledger.addAccount(
      LedgerAccountSchema.parse({
        name: "Patrimônio de abertura",
        type: AccountType.EQUITY,
        subtype: AccountSubtype.OPENING_EQUITY,
      }),
    );
    ledger.meta = { ...ledger.meta, opening_equity_id: equity.id };
    for (const name of DEFAULT_EXPENSE_CATEGORIES) {
      ledger.addAccount(
        LedgerAccountSchema.parse({ name, type: AccountType.EXPENSE, subtype: AccountSubtype.CATEGORY }),
      );
    }
    for (const name of DEFAULT_INCOME_CATEGORIES) {
      ledger.addAccount(
        LedgerAccountSchema.parse({ name, type: AccountType.INCOME, subtype: AccountSubtype.CATEGORY }),
      );
    }
    return ledger;
  }

  private collection<T>(kind: string): TrackedMap<T> {
    let collection = this.store.get(kind);
    if (collection === undefined) {
      collection = new TrackedMap(this.sink, kind);
      this.store.set(kind, collection);
    }
    return collection as TrackedMap<T>;
  }

  // ── typed accessors ─────────────────────────────────

  get members(): TrackedMap<Member> {
    return this.collection("member");
  }
  get accounts(): TrackedMap<LedgerAccount> {
    return this.collection("account");
  }
  get cards(): TrackedMap<Card> {
    return this.collection("card");
  }
  get operations(): TrackedMap<Operation> {
    return this.collection("operation");
  }

  entities<T>(kind: string): TrackedMap<T> {
    return this.collection<T>(kind);
  }

  *activeOperations(): Generator<Operation> {
    for (const op of this.operations.values()) if (isActive(op)) yield op;
  }

  account(accountId: Id): LedgerAccount {
    const account = this.accounts.get(accountId);
    if (account === undefined) throw new DomainError("Conta inexistente.");
    return account;
  }

  categories(accountType: AccountType): LedgerAccount[] {
    return sortedBy(
      [...this.accounts.values()].filter((a) => a.type === accountType && !a.archived),
      (a) => a.name,
    );
  }

  // ── history and change tracking ─────────────────────

  private record(
    kind: string,
    entity: Entity,
    action: HistoryAction,
    before: Entity | null | undefined,
    reason: string | null,
    version = 1,
  ): void {
    this.history.append(
      HistoryEntrySchema.parse({
        entity_kind: kind,
        entity_id: entity.id,
        action,
        version,
        before: before != null ? dump(before) : null,
        // A creation's state is the entity itself; only changes need a stored copy.
        after: before != null ? dump(entity) : null,
        operator: this.operator,
        reason,
        at: nowInstant(),
      }),
    );
    this.changeCount += 1;
  }

  /** Generic insert/replace with history, for modules that own their own validation. */
  put<E extends Entity>(kind: string, entity: E, options: RecordOptions = {}): E {
    const reason = options.reason ?? null;
    const collection = this.collection<E>(kind);
    const before = collection.get(entity.id);
    if (before !== undefined && !reason) throw new DomainError("Alterações exigem um motivo.");
    collection.set(entity.id, entity);
    const defaultAction = before !== undefined ? HistoryAction.UPDATE : HistoryAction.CREATE;
    this.record(kind, entity, options.action ?? defaultAction, before, reason, entity.version ?? 1);
    return entity;
  }

  historyOf(entityId: Id): HistoryEntry[] {
    return [...this.history].filter((h) => h.entity_id === entityId);
  }

  // ── members ─────────────────────────────────────────

  addMember(name: string, role: MemberRole = MemberRole.HOLDER): Member {
    const trimmed = name.trim();
    if ([...this.members.values()].some((m) => casefold(m.name) === casefold(trimmed))) {
      throw new DomainError("Já existe um integrante com esse nome.");
    }
    return this.put("member", MemberSchema.parse({ name: trimmed, role }));
  }

  updateMember(member: Member, reason: string): Member {
    if (!this.members.has(member.id)) throw new DomainError("Integrante inexistente.");
    return this.put("member", member, { reason });
  }

  // ── accounts and cards ──────────────────────────────

  addAccount(account: LedgerAccount): LedgerAccount {
    this.validateAccount(account);
    return this.put("account", account);
  }

  updateAccount(account: LedgerAccount, reason: string): LedgerAccount {
    const current = this.account(account.id);
    if ((current.type !== account.type || current.currency !== account.currency) && this.isUsed(account.id)) {
      throw new DomainError("Não é possível mudar tipo ou moeda de uma conta com lançamentos.");
    }
    this.validateAccount(account);
    return this.put("account", account, { reason });
  }

  private validateAccount(account: LedgerAccount): void {
    for (const holder of account.holders) {
      if (!this.members.has(holder)) throw new DomainError("Titular inexistente.");
    }
    if (account.parent_id !== null) {
      const parent = this.accounts.get(account.parent_id);
      if (parent === undefined || parent.type !== account.type) throw new DomainError("Categoria-mãe inválida.");
      const seen = new Set<Id>([account.id]);
      let cursor: LedgerAccount | undefined = parent;
      while (cursor !== undefined) {
        if (seen.has(cursor.id)) throw new DomainError("Hierarquia de categorias circular.");
        seen.add(cursor.id);
        cursor = cursor.parent_id ? this.accounts.get(cursor.parent_id) : undefined;
      }
    }
    const subtypeTypes: Partial<Record<AccountSubtype, AccountType>> = {
      [AccountSubtype.CREDIT_CARD]: AccountType.LIABILITY,
      [AccountSubtype.LOAN]: AccountType.LIABILITY,
      [AccountSubtype.TAX_PAYABLE]: AccountType.LIABILITY,
      [AccountSubtype.OPENING_EQUITY]: AccountType.EQUITY,
    };
    const expected = subtypeTypes[account.subtype];
    if (expected !== undefined && account.type !== expected)
      throw new DomainError("Tipo de conta incompatível com o subtipo.");
    if (
      account.subtype === AccountSubtype.CATEGORY &&
      account.type !== AccountType.INCOME &&
      account.type !== AccountType.EXPENSE
    ) {
      throw new DomainError("Categorias são de receita ou despesa.");
    }
  }

  private isUsed(accountId: Id): boolean {
    for (const op of this.operations.values()) if (op.postings.some((p) => p.account_id === accountId)) return true;
    return false;
  }

  addCard(card: Card): Card {
    this.validateCard(card);
    return this.put("card", card);
  }

  updateCard(card: Card, reason: string): Card {
    if (!this.cards.has(card.id)) throw new DomainError("Cartão inexistente.");
    this.validateCard(card);
    return this.put("card", card, { reason });
  }

  private validateCard(card: Card): void {
    const liability = this.accounts.get(card.liability_account_id);
    if (liability === undefined || liability.subtype !== AccountSubtype.CREDIT_CARD) {
      throw new DomainError("O cartão precisa de uma conta de cartão de crédito.");
    }
    if (!this.members.has(card.holder_id) || card.additional.some((a) => !this.members.has(a.member_id))) {
      throw new DomainError("Portador inexistente.");
    }
    if (card.settlement_account_id !== null) {
      const settlement = this.accounts.get(card.settlement_account_id);
      if (settlement === undefined || !isLiquid(settlement))
        throw new DomainError("Conta de pagamento da fatura inválida.");
    }
  }

  // ── operations ──────────────────────────────────────

  validateOperation(op: Operation): void {
    if (op.postings.length < 2) throw new DomainError("Uma operação precisa de pelo menos duas partidas.");
    const totals = new Map<string, Dec>();
    for (const p of op.postings) {
      const account = this.accounts.get(p.account_id);
      if (account === undefined) throw new DomainError("Partida aponta para conta inexistente.");
      if (p.amount.isZero()) throw new DomainError("Partidas de valor zero não são permitidas.");
      if (account.currency !== op.currency) throw new DomainError("Moeda da conta difere da moeda da operação.");
      if (account.currency === BRL && !isCents(p.amount))
        throw new DomainError("Valores em reais precisam estar em centavos.");
      if (p.member_id !== null && !this.members.has(p.member_id))
        throw new DomainError("Integrante do rateio inexistente.");
      totals.set(account.currency, (totals.get(account.currency) ?? ZERO).add(p.amount));
    }
    if ([...totals.values()].some((total) => !total.isZero()))
      throw new DomainError("Débitos e créditos não se equilibram.");
    if (op.member_id !== null && !this.members.has(op.member_id)) throw new DomainError("Integrante inexistente.");
    if (op.card_id !== null && !this.cards.has(op.card_id)) throw new DomainError("Cartão inexistente.");
    if (op.cardholder_id !== null && !this.members.has(op.cardholder_id))
      throw new DomainError("Portador inexistente.");
    if (op.reversal_of !== null && !this.operations.has(op.reversal_of))
      throw new DomainError("Estorno de operação inexistente.");
  }

  /** Runs every registered guard for a new operation (modules that build operations call it). */
  guardNew(op: Operation): void {
    for (const guard of operationGuards) guard(this, op);
  }

  addOperation(op: Operation): Operation {
    if (this.operations.has(op.id)) throw new DomainError("Operação já existe.");
    this.validateOperation(op);
    this.guardNew(op);
    return this.put("operation", { ...op, version: 1 });
  }

  updateOperation(op: Operation, reason: string): Operation {
    const current = this.operations.get(op.id);
    if (current === undefined) throw new DomainError("Operação inexistente.");
    if (!isActive(current)) throw new DomainError("Operação cancelada não pode ser editada.");
    if (!reason.trim()) throw new DomainError("Correções exigem um motivo.");
    const updated: Operation = { ...op, version: current.version + 1 };
    this.validateOperation(updated);
    for (const guard of updateGuards) guard(this, current, updated);
    return this.put("operation", updated, { reason });
  }

  cancelOperation(opId: Id, reason: string): Operation {
    const current = this.operations.get(opId);
    if (current === undefined || !isActive(current)) throw new DomainError("Operação inexistente ou já cancelada.");
    if (!reason.trim()) throw new DomainError("Cancelamentos exigem um motivo.");
    const cancelled: Operation = { ...current, status: OperationStatus.CANCELLED, version: current.version + 1 };
    for (const guard of updateGuards) guard(this, current, cancelled);
    return this.put("operation", cancelled, { reason, action: HistoryAction.CANCEL });
  }

  /** Estorno: a new opposite operation that keeps the original intact (docs/04 §2). */
  reverseOperation(opId: Id, on: IsoDate, reason: string): Operation {
    const original = this.operations.get(opId);
    if (original === undefined || !isActive(original)) throw new DomainError("Operação inexistente ou cancelada.");
    if (!reason.trim()) throw new DomainError("Estornos exigem um motivo.");
    const reversal = operation({
      kind: OperationKind.REVERSAL,
      description: `Estorno: ${original.description}`,
      currency: original.currency,
      postings: original.postings.map((p) => ({
        account_id: p.account_id,
        amount: p.amount.negate(),
        member_id: p.member_id,
      })),
      occurred_on: on,
      settled_on: on,
      accrual_month: ymOf(on),
      reversal_of: original.id,
      member_id: original.member_id,
      card_id: original.card_id,
      notes: reason,
    });
    this.validateOperation(reversal);
    this.guardNew(reversal);
    return this.put("operation", reversal);
  }

  // ── convenience builders (docs/04 §4 table) ─────────

  private require(accountId: Id, ...types: AccountType[]): LedgerAccount {
    const account = this.account(accountId);
    if (types.length && !types.includes(account.type))
      throw new DomainError("Conta de tipo inadequado para esta operação.");
    return account;
  }

  /** Opening balance credits opening equity, never income (docs/01 §3). */
  recordOpeningBalance(accountId: Id, amount: unknown, on: IsoDate): Operation {
    const account = this.require(accountId, AccountType.ASSET, AccountType.LIABILITY);
    const value = toDecimal(amount);
    const equity = this.meta.opening_equity_id;
    if (equity === null) throw new DomainError("Cofre sem conta de patrimônio de abertura.");
    // For liabilities, a positive informed balance is an amount owed (credit).
    const signed = account.type === AccountType.ASSET ? value : value.negate();
    return this.addOperation(
      operation({
        kind: OperationKind.OPENING_BALANCE,
        description: `Saldo de abertura — ${account.name}`,
        postings: [
          { account_id: accountId, amount: signed },
          { account_id: equity, amount: signed.negate() },
        ],
        occurred_on: on,
        settled_on: on,
      }),
    );
  }

  recordIncome(
    accountId: Id,
    categoryId: Id,
    amount: unknown,
    on: IsoDate,
    description: string,
    extra: Partial<OperationInput> = {},
  ): Operation {
    this.require(accountId, AccountType.ASSET);
    this.require(categoryId, AccountType.INCOME);
    const value = toDecimal(amount);
    if (!value.isPositive()) throw new DomainError("Informe um valor positivo.");
    return this.addOperation(
      operation({
        kind: OperationKind.INCOME,
        description,
        postings: [
          { account_id: accountId, amount: value },
          { account_id: categoryId, amount: value.negate() },
        ],
        occurred_on: on,
        settled_on: on,
        ...extra,
      }),
    );
  }

  /** Expense paid from an asset account. `splits` is one category id or [category, value] pairs (rateio). */
  recordExpense(
    accountId: Id,
    splits: Id | readonly (readonly [Id, unknown])[],
    amount: unknown,
    on: IsoDate,
    description: string,
    extra: Partial<OperationInput> = {},
  ): Operation {
    this.require(accountId, AccountType.ASSET);
    const parts = this.splitParts(splits, amount);
    const total = Dec.sum(
      parts.map(([, v]) => v),
      ZERO,
    );
    const postings: Posting[] = parts.map(([c, v]) => ({ account_id: c, amount: v, member_id: null }));
    postings.push({ account_id: accountId, amount: total.negate(), member_id: null });
    return this.addOperation(
      operation({ kind: OperationKind.EXPENSE, description, postings, occurred_on: on, settled_on: on, ...extra }),
    );
  }

  private splitParts(splits: Id | readonly (readonly [Id, unknown])[], amount: unknown): [Id, Dec][] {
    let parts: [Id, Dec][];
    if (typeof splits === "string") {
      if (amount === null || amount === undefined) throw new DomainError("Informe o valor.");
      parts = [[splits, toDecimal(amount)]];
    } else {
      parts = splits.map(([c, v]) => [c, toDecimal(v)]);
      if (
        amount !== null &&
        amount !== undefined &&
        !Dec.sum(
          parts.map(([, v]) => v),
          ZERO,
        ).eq(toDecimal(amount))
      ) {
        throw new DomainError("O rateio não soma o valor total.");
      }
    }
    if (parts.length === 0 || parts.some(([, v]) => !v.isPositive()))
      throw new DomainError("Informe valores positivos.");
    for (const [categoryId] of parts) this.require(categoryId, AccountType.EXPENSE, AccountType.ASSET);
    return parts;
  }

  recordTransfer(
    fromId: Id,
    toId: Id,
    amount: unknown,
    on: IsoDate,
    description = "Transferência",
    extra: Partial<OperationInput> = {},
  ): Operation {
    if (fromId === toId) throw new DomainError("Origem e destino iguais.");
    this.require(fromId, AccountType.ASSET, AccountType.LIABILITY);
    this.require(toId, AccountType.ASSET, AccountType.LIABILITY);
    const value = toDecimal(amount);
    if (!value.isPositive()) throw new DomainError("Informe um valor positivo.");
    return this.addOperation(
      operation({
        kind: OperationKind.TRANSFER,
        description,
        postings: [
          { account_id: toId, amount: value },
          { account_id: fromId, amount: value.negate() },
        ],
        occurred_on: on,
        settled_on: on,
        ...extra,
      }),
    );
  }

  recordCardPurchase(
    cardId: Id,
    splits: Id | readonly (readonly [Id, unknown])[],
    amount: unknown,
    on: IsoDate,
    description: string,
    cardholderId: Id | null = null,
    extra: Partial<OperationInput> = {},
  ): Operation {
    const card = this.cards.get(cardId);
    if (card === undefined) throw new DomainError("Cartão inexistente.");
    const parts = this.splitParts(splits, amount);
    const total = Dec.sum(
      parts.map(([, v]) => v),
      ZERO,
    );
    const postings: Posting[] = parts.map(([c, v]) => ({ account_id: c, amount: v, member_id: null }));
    postings.push({ account_id: card.liability_account_id, amount: total.negate(), member_id: null });
    return this.addOperation(
      operation({
        kind: OperationKind.CARD_PURCHASE,
        description,
        postings,
        occurred_on: on,
        card_id: cardId,
        cardholder_id: cardholderId ?? card.holder_id,
        ...extra,
      }),
    );
  }

  /** Paying the bill settles the obligation; it is not a new expense (docs/00 §4.4). */
  recordCardPayment(
    cardId: Id,
    fromAccountId: Id,
    amount: unknown,
    on: IsoDate,
    extra: Partial<OperationInput> = {},
  ): Operation {
    const card = this.cards.get(cardId);
    if (card === undefined) throw new DomainError("Cartão inexistente.");
    this.require(fromAccountId, AccountType.ASSET);
    const value = toDecimal(amount);
    if (!value.isPositive()) throw new DomainError("Informe um valor positivo.");
    return this.addOperation(
      operation({
        kind: OperationKind.CARD_PAYMENT,
        description: `Pagamento de fatura — ${card.name}`,
        postings: [
          { account_id: card.liability_account_id, amount: value },
          { account_id: fromAccountId, amount: value.negate() },
        ],
        occurred_on: on,
        settled_on: on,
        card_id: cardId,
        ...extra,
      }),
    );
  }

  // ── persistence ─────────────────────────────────────

  toRecords(): LedgerRecord[] {
    const rows: LedgerRecord[] = [{ id: META_ID, kind: META_KIND, payload: dump(this.meta) }];
    for (const [kind, collection] of this.store) {
      for (const [id, entity] of collection) rows.push({ id, kind, payload: dump(entity) });
    }
    for (const h of this.history) rows.push({ id: h.id, kind: "history", payload: dump(h) });
    return rows;
  }

  /**
   * Builds a ledger from persisted rows. Unknown kinds mean a newer app version wrote the
   * project. History entries stay raw until first read.
   */
  static fromRecords(rows: Iterable<LedgerRecord>): Ledger {
    let list = [...rows];
    const metaRows = list.filter((r) => r.kind === META_KIND);
    if (metaRows.length !== 1) throw new DomainError("Cofre sem dados financeiros reconhecíveis.");
    let metaPayload = metaRows[0]!.payload;
    const originalVersion = Number(metaPayload["schema_version"] ?? 0);
    [metaPayload, list] = migrate(metaPayload, list);
    const ledger = new Ledger(LedgerMetaSchema.parse(metaPayload));
    if (originalVersion !== SCHEMA_VERSION) ledger.migratedFrom = originalVersion;
    const rawHistory: unknown[] = [];
    for (const { kind, payload } of list) {
      if (kind === META_KIND) continue;
      if (kind === "history") {
        rawHistory.push(payload);
        continue;
      }
      const schema = KINDS.get(kind);
      if (schema === undefined) throw new DomainError("Cofre contém dados de uma versão mais nova do OpesVault.");
      const entity = schema.parse(payload);
      ledger.collection(kind).load(entity.id, entity);
    }
    ledger.history.loadRaw(rawHistory);
    ledger.changeCount = 0;
    ledger.dirty = new Map();
    return ledger;
  }

  /** Current JSON payload of one persisted row, or null if it no longer exists. */
  recordFor(kind: string, key: Id): Record<string, unknown> | null {
    if (kind === META_KIND) return dump(this.meta);
    if (kind === "history") {
      const entry = this.history.recent().find((h) => h.id === key) ?? [...this.history].find((h) => h.id === key);
      return entry ? dump(entry) : null;
    }
    const entity = this.store.get(kind)?.get(key);
    return entity !== undefined ? dump(entity) : null;
  }

  rowCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [kind, c] of this.store) if (c.size) counts[kind] = c.size;
    counts["history"] = this.history.length;
    counts[META_KIND] = 1;
    return Object.fromEntries(Object.entries(counts).filter(([, v]) => v));
  }
}
