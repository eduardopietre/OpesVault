"""The Ledger aggregate: the only place where domain state changes (docs/04 §2).

Every change is validated against the invariants and leaves a history entry.
The UI never edits entities directly.
"""

from collections import defaultdict
from collections.abc import Iterable, Iterator
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, ClassVar, TypeVar
from uuid import UUID, uuid5

from pydantic import BaseModel, ConfigDict

from opesvault.domain.model import (
    AccountSubtype,
    AccountType,
    Card,
    HistoryAction,
    HistoryEntry,
    LedgerAccount,
    Member,
    Operation,
    OperationKind,
    OperationStatus,
    Origin,
    Posting,
    YearMonth,
)
from opesvault.domain.money import BRL, ZERO, is_cents, to_decimal

SCHEMA_VERSION = 1
_META_NAMESPACE = UUID("6f1c3d2a-1b7e-4b8e-9f00-0c0ffee0a001")
META_ID = uuid5(_META_NAMESPACE, "ledger-meta")

E = TypeVar("E", bound=BaseModel)


class DomainError(ValueError):
    """A rejected change. The message is user-facing Portuguese without financial values."""


class LedgerMeta(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    schema_version: int = SCHEMA_VERSION
    family_name: str = ""
    currency: str = BRL
    opening_equity_id: UUID | None = None


DEFAULT_EXPENSE_CATEGORIES = (
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
)
DEFAULT_INCOME_CATEGORIES = ("Salário", "Rendimentos de investimentos", "Outras receitas")


def _now() -> datetime:
    return datetime.now(UTC)


class _TrackedDict(dict):  # type: ignore[type-arg]
    """Entity collection that reports every change, so saves can be incremental and
    caches can be invalidated even when a module writes to the collection directly."""

    def __init__(self, ledger: "Ledger", kind: str) -> None:
        super().__init__()
        self._ledger = ledger
        self._kind = kind

    def __setitem__(self, key: UUID, value: Any) -> None:
        super().__setitem__(key, value)
        self._ledger._touch(self._kind, key)

    def __delitem__(self, key: UUID) -> None:
        super().__delitem__(key)
        self._ledger._touch(self._kind, key)

    def pop(self, key: UUID, *default: Any) -> Any:  # type: ignore[override]
        value = super().pop(key, *default)
        self._ledger._touch(self._kind, key)
        return value

    def load(self, key: UUID, value: Any) -> None:
        """Insert while opening a vault: not a change."""
        super().__setitem__(key, value)


class _TrackedList(list):  # type: ignore[type-arg]
    def __init__(self, ledger: "Ledger") -> None:
        super().__init__()
        self._ledger = ledger

    def append(self, entry: Any) -> None:
        super().append(entry)
        self._ledger._touch("history", entry.id)


class Ledger:
    """In-memory family ledger. Collections are keyed by entity kind."""

    KINDS: ClassVar[dict[str, type[BaseModel]]] = {
        "member": Member,
        "account": LedgerAccount,
        "card": Card,
        "operation": Operation,
        "history": HistoryEntry,
    }

    def __init__(self, meta: LedgerMeta | None = None) -> None:
        import opesvault.registry  # noqa: F401 - kinds and guards must exist before any change

        # (kind, id) → change_count of its last change since the last save; drives incremental saves.
        self.dirty: dict[tuple[str, UUID], int] = {}
        self.change_count = 0
        self._meta = meta or LedgerMeta()
        self._store: dict[str, dict[UUID, Any]] = {kind: _TrackedDict(self, kind) for kind in self.KINDS}
        self.history: list[HistoryEntry] = _TrackedList(self)
        self.operator: str | None = None
        self.migrated_from: int | None = None  # schema version before an in-memory migration

    @property
    def meta(self) -> LedgerMeta:
        return self._meta

    @meta.setter
    def meta(self, value: LedgerMeta) -> None:
        self._meta = value
        self._touch("ledger.meta", META_ID)

    def _touch(self, kind: str, key: UUID) -> None:
        self.change_count += 1
        self.dirty[(kind, key)] = self.change_count

    def mark_clean(self, up_to: int) -> None:
        """Forget changes already persisted; later edits stay pending (docs/03 §5)."""
        self.dirty = {k: seq for k, seq in self.dirty.items() if seq > up_to}

    # ── construction ────────────────────────────────────

    @classmethod
    def new(cls, family_name: str) -> "Ledger":
        ledger = cls(LedgerMeta(family_name=family_name))
        equity = ledger.add_account(
            LedgerAccount(name="Patrimônio de abertura", type=AccountType.EQUITY, subtype=AccountSubtype.OPENING_EQUITY)
        )
        ledger.meta = ledger.meta.model_copy(update={"opening_equity_id": equity.id})
        for name in DEFAULT_EXPENSE_CATEGORIES:
            ledger.add_account(LedgerAccount(name=name, type=AccountType.EXPENSE, subtype=AccountSubtype.CATEGORY))
        for name in DEFAULT_INCOME_CATEGORIES:
            ledger.add_account(LedgerAccount(name=name, type=AccountType.INCOME, subtype=AccountSubtype.CATEGORY))
        return ledger

    @classmethod
    def register_kind(cls, kind: str, model: type[BaseModel]) -> None:
        """Lets later modules (imports, investments…) add persisted collections."""
        cls.KINDS[kind] = model

    def _collection(self, kind: str) -> dict[UUID, Any]:
        if kind not in self._store:
            self._store[kind] = _TrackedDict(self, kind)
        return self._store[kind]

    # ── typed accessors ─────────────────────────────────

    @property
    def members(self) -> dict[UUID, Member]:
        return self._collection("member")

    @property
    def accounts(self) -> dict[UUID, LedgerAccount]:
        return self._collection("account")

    @property
    def cards(self) -> dict[UUID, Card]:
        return self._collection("card")

    @property
    def operations(self) -> dict[UUID, Operation]:
        return self._collection("operation")

    def entities(self, kind: str) -> dict[UUID, Any]:
        return self._collection(kind)

    def active_operations(self) -> Iterator[Operation]:
        return (op for op in self.operations.values() if op.active)

    def account(self, account_id: UUID) -> LedgerAccount:
        try:
            return self.accounts[account_id]
        except KeyError:
            raise DomainError("Conta inexistente.") from None

    def categories(self, account_type: AccountType) -> list[LedgerAccount]:
        return sorted(
            (a for a in self.accounts.values() if a.type is account_type and not a.archived),
            key=lambda a: a.name,
        )

    # ── history and change tracking ─────────────────────

    def _record(
        self,
        kind: str,
        entity: BaseModel,
        action: HistoryAction,
        before: BaseModel | None,
        reason: str | None,
        version: int = 1,
    ) -> None:
        entity_id = getattr(entity, "id")  # noqa: B009 - every entity has an id
        self.history.append(
            HistoryEntry(
                entity_kind=kind,
                entity_id=entity_id,
                action=action,
                version=version,
                before=before.model_dump(mode="json") if before is not None else None,
                # A creation's state is the entity itself; only changes need a stored copy.
                after=entity.model_dump(mode="json") if before is not None else None,
                operator=self.operator,
                reason=reason,
                at=_now(),
            )
        )
        self.change_count += 1

    def put(self, kind: str, entity: E, *, reason: str | None = None, action: HistoryAction | None = None) -> E:
        """Generic insert/replace with history, for modules that own their own validation."""
        collection = self._collection(kind)
        entity_id = getattr(entity, "id")  # noqa: B009
        before = collection.get(entity_id)
        if before is not None and not reason:
            raise DomainError("Alterações exigem um motivo.")
        collection[entity_id] = entity
        default_action = HistoryAction.UPDATE if before is not None else HistoryAction.CREATE
        self._record(kind, entity, action or default_action, before, reason, getattr(entity, "version", 1))
        return entity

    def history_of(self, entity_id: UUID) -> list[HistoryEntry]:
        return [h for h in self.history if h.entity_id == entity_id]

    # ── members ─────────────────────────────────────────

    def add_member(self, name: str) -> Member:
        name = name.strip()
        if any(m.name.casefold() == name.casefold() for m in self.members.values()):
            raise DomainError("Já existe um integrante com esse nome.")
        return self.put("member", Member(name=name))

    def update_member(self, member: Member, reason: str) -> Member:
        if member.id not in self.members:
            raise DomainError("Integrante inexistente.")
        return self.put("member", member, reason=reason)

    # ── accounts and cards ──────────────────────────────

    def add_account(self, account: LedgerAccount) -> LedgerAccount:
        self._validate_account(account)
        return self.put("account", account)

    def update_account(self, account: LedgerAccount, reason: str) -> LedgerAccount:
        current = self.account(account.id)
        if (current.type, current.currency) != (account.type, account.currency) and self._is_used(account.id):
            raise DomainError("Não é possível mudar tipo ou moeda de uma conta com lançamentos.")
        self._validate_account(account)
        return self.put("account", account, reason=reason)

    def _validate_account(self, account: LedgerAccount) -> None:
        for holder in account.holders:
            if holder not in self.members:
                raise DomainError("Titular inexistente.")
        if account.parent_id is not None:
            parent = self.accounts.get(account.parent_id)
            if parent is None or parent.type is not account.type:
                raise DomainError("Categoria-mãe inválida.")
            seen = {account.id}
            cursor: LedgerAccount | None = parent
            while cursor is not None:
                if cursor.id in seen:
                    raise DomainError("Hierarquia de categorias circular.")
                seen.add(cursor.id)
                cursor = self.accounts.get(cursor.parent_id) if cursor.parent_id else None
        subtype_types = {
            AccountSubtype.CREDIT_CARD: AccountType.LIABILITY,
            AccountSubtype.LOAN: AccountType.LIABILITY,
            AccountSubtype.TAX_PAYABLE: AccountType.LIABILITY,
            AccountSubtype.OPENING_EQUITY: AccountType.EQUITY,
        }
        expected = subtype_types.get(account.subtype)
        if expected is not None and account.type is not expected:
            raise DomainError("Tipo de conta incompatível com o subtipo.")
        if account.subtype is AccountSubtype.CATEGORY and account.type not in (AccountType.INCOME, AccountType.EXPENSE):
            raise DomainError("Categorias são de receita ou despesa.")

    def _is_used(self, account_id: UUID) -> bool:
        return any(p.account_id == account_id for op in self.operations.values() for p in op.postings)

    def add_card(self, card: Card) -> Card:
        self._validate_card(card)
        return self.put("card", card)

    def update_card(self, card: Card, reason: str) -> Card:
        if card.id not in self.cards:
            raise DomainError("Cartão inexistente.")
        self._validate_card(card)
        return self.put("card", card, reason=reason)

    def _validate_card(self, card: Card) -> None:
        liability = self.accounts.get(card.liability_account_id)
        if liability is None or liability.subtype is not AccountSubtype.CREDIT_CARD:
            raise DomainError("O cartão precisa de uma conta de cartão de crédito.")
        if card.holder_id not in self.members or any(a.member_id not in self.members for a in card.additional):
            raise DomainError("Portador inexistente.")
        if card.settlement_account_id is not None:
            settlement = self.accounts.get(card.settlement_account_id)
            if settlement is None or not settlement.is_liquid:
                raise DomainError("Conta de pagamento da fatura inválida.")

    # ── operations ──────────────────────────────────────

    def validate_operation(self, op: Operation) -> None:
        if len(op.postings) < 2:
            raise DomainError("Uma operação precisa de pelo menos duas partidas.")
        totals: dict[str, Decimal] = defaultdict(lambda: ZERO)
        for posting in op.postings:
            account = self.accounts.get(posting.account_id)
            if account is None:
                raise DomainError("Partida aponta para conta inexistente.")
            if posting.amount == 0:
                raise DomainError("Partidas de valor zero não são permitidas.")
            if account.currency != op.currency:
                raise DomainError("Moeda da conta difere da moeda da operação.")
            if account.currency == BRL and not is_cents(posting.amount):
                raise DomainError("Valores em reais precisam estar em centavos.")
            if posting.member_id is not None and posting.member_id not in self.members:
                raise DomainError("Integrante do rateio inexistente.")
            totals[account.currency] += posting.amount
        if any(total != 0 for total in totals.values()):
            raise DomainError("Débitos e créditos não se equilibram.")
        if op.member_id is not None and op.member_id not in self.members:
            raise DomainError("Integrante inexistente.")
        if op.card_id is not None and op.card_id not in self.cards:
            raise DomainError("Cartão inexistente.")
        if op.cardholder_id is not None and op.cardholder_id not in self.members:
            raise DomainError("Portador inexistente.")
        if op.reversal_of is not None and op.reversal_of not in self.operations:
            raise DomainError("Estorno de operação inexistente.")

    def _guard_new(self, op: Operation) -> None:
        for hook in self._operation_guards:
            hook(self, op)

    # Later modules (period closing…) add guards without editing this class.
    _operation_guards: ClassVar[list[Any]] = []

    @classmethod
    def add_operation_guard(cls, guard: Any) -> None:
        cls._operation_guards.append(guard)

    def add_operation(self, op: Operation) -> Operation:
        if op.id in self.operations:
            raise DomainError("Operação já existe.")
        self.validate_operation(op)
        self._guard_new(op)
        return self.put("operation", op.model_copy(update={"version": 1}))

    def update_operation(self, op: Operation, reason: str) -> Operation:
        current = self.operations.get(op.id)
        if current is None:
            raise DomainError("Operação inexistente.")
        if not current.active:
            raise DomainError("Operação cancelada não pode ser editada.")
        if not reason.strip():
            raise DomainError("Correções exigem um motivo.")
        updated = op.model_copy(update={"version": current.version + 1})
        self.validate_operation(updated)
        for hook in self._update_guards:
            hook(self, current, updated)
        return self.put("operation", updated, reason=reason)

    _update_guards: ClassVar[list[Any]] = []

    @classmethod
    def add_update_guard(cls, guard: Any) -> None:
        cls._update_guards.append(guard)

    def cancel_operation(self, op_id: UUID, reason: str) -> Operation:
        current = self.operations.get(op_id)
        if current is None or not current.active:
            raise DomainError("Operação inexistente ou já cancelada.")
        if not reason.strip():
            raise DomainError("Cancelamentos exigem um motivo.")
        cancelled = current.model_copy(update={"status": OperationStatus.CANCELLED, "version": current.version + 1})
        for hook in self._update_guards:
            hook(self, current, cancelled)
        return self.put("operation", cancelled, reason=reason, action=HistoryAction.CANCEL)

    def reverse_operation(self, op_id: UUID, on: date, reason: str) -> Operation:
        """Estorno: a new opposite operation that keeps the original intact (docs/04 §2)."""
        original = self.operations.get(op_id)
        if original is None or not original.active:
            raise DomainError("Operação inexistente ou cancelada.")
        if not reason.strip():
            raise DomainError("Estornos exigem um motivo.")
        reversal = Operation(
            kind=OperationKind.REVERSAL,
            description=f"Estorno: {original.description}",
            currency=original.currency,
            postings=tuple(
                Posting(account_id=p.account_id, amount=-p.amount, member_id=p.member_id) for p in original.postings
            ),
            occurred_on=on,
            settled_on=on,
            accrual_month=YearMonth.of(on),
            reversal_of=original.id,
            member_id=original.member_id,
            card_id=original.card_id,
            notes=reason,
        )
        self.validate_operation(reversal)
        self._guard_new(reversal)
        return self.put("operation", reversal)

    # ── convenience builders (docs/04 §4 table) ─────────

    def _require(self, account_id: UUID, *types: AccountType) -> LedgerAccount:
        account = self.account(account_id)
        if types and account.type not in types:
            raise DomainError("Conta de tipo inadequado para esta operação.")
        return account

    def record_opening_balance(self, account_id: UUID, amount: object, on: date) -> Operation:
        """Opening balance credits opening equity, never income (docs/01 §3)."""
        account = self._require(account_id, AccountType.ASSET, AccountType.LIABILITY)
        value = to_decimal(amount)
        if self.meta.opening_equity_id is None:
            raise DomainError("Cofre sem conta de patrimônio de abertura.")
        # For liabilities, a positive informed balance is an amount owed (credit).
        signed = value if account.type is AccountType.ASSET else -value
        return self.add_operation(
            Operation(
                kind=OperationKind.OPENING_BALANCE,
                description=f"Saldo de abertura — {account.name}",
                postings=(
                    Posting(account_id=account_id, amount=signed),
                    Posting(account_id=self.meta.opening_equity_id, amount=-signed),
                ),
                occurred_on=on,
                settled_on=on,
                origin=Origin(),
            )
        )

    def record_income(
        self, account_id: UUID, category_id: UUID, amount: object, on: date, description: str, **extra: Any
    ) -> Operation:
        self._require(account_id, AccountType.ASSET)
        self._require(category_id, AccountType.INCOME)
        value = to_decimal(amount)
        if value <= 0:
            raise DomainError("Informe um valor positivo.")
        return self.add_operation(
            Operation(
                kind=OperationKind.INCOME,
                description=description,
                postings=(Posting(account_id=account_id, amount=value), Posting(account_id=category_id, amount=-value)),
                occurred_on=on,
                settled_on=on,
                **extra,
            )
        )

    def record_expense(
        self,
        account_id: UUID,
        splits: Iterable[tuple[UUID, object]] | UUID,
        amount: object | None,
        on: date,
        description: str,
        **extra: Any,
    ) -> Operation:
        """Expense paid from an asset account. `splits` may be one category or (category, value) pairs (rateio)."""
        self._require(account_id, AccountType.ASSET)
        parts = self._split_parts(splits, amount)
        total = sum((v for _, v in parts), ZERO)
        postings = [Posting(account_id=c, amount=v) for c, v in parts]
        postings.append(Posting(account_id=account_id, amount=-total))
        return self.add_operation(
            Operation(
                kind=OperationKind.EXPENSE,
                description=description,
                postings=tuple(postings),
                occurred_on=on,
                settled_on=on,
                **extra,
            )
        )

    def _split_parts(
        self, splits: Iterable[tuple[UUID, object]] | UUID, amount: object | None
    ) -> list[tuple[UUID, Decimal]]:
        if isinstance(splits, UUID):
            if amount is None:
                raise DomainError("Informe o valor.")
            parts = [(splits, to_decimal(amount))]
        else:
            parts = [(c, to_decimal(v)) for c, v in splits]
            if amount is not None and sum((v for _, v in parts), ZERO) != to_decimal(amount):
                raise DomainError("O rateio não soma o valor total.")
        if not parts or any(v <= 0 for _, v in parts):
            raise DomainError("Informe valores positivos.")
        for category_id, _ in parts:
            self._require(category_id, AccountType.EXPENSE, AccountType.ASSET)
        return parts

    def record_transfer(
        self, from_id: UUID, to_id: UUID, amount: object, on: date, description: str = "Transferência", **extra: Any
    ) -> Operation:
        if from_id == to_id:
            raise DomainError("Origem e destino iguais.")
        self._require(from_id, AccountType.ASSET, AccountType.LIABILITY)
        self._require(to_id, AccountType.ASSET, AccountType.LIABILITY)
        value = to_decimal(amount)
        if value <= 0:
            raise DomainError("Informe um valor positivo.")
        return self.add_operation(
            Operation(
                kind=OperationKind.TRANSFER,
                description=description,
                postings=(Posting(account_id=to_id, amount=value), Posting(account_id=from_id, amount=-value)),
                occurred_on=on,
                settled_on=on,
                **extra,
            )
        )

    def record_card_purchase(
        self,
        card_id: UUID,
        splits: Iterable[tuple[UUID, object]] | UUID,
        amount: object | None,
        on: date,
        description: str,
        cardholder_id: UUID | None = None,
        **extra: Any,
    ) -> Operation:
        card = self.cards.get(card_id)
        if card is None:
            raise DomainError("Cartão inexistente.")
        parts = self._split_parts(splits, amount)
        total = sum((v for _, v in parts), ZERO)
        postings = [Posting(account_id=c, amount=v) for c, v in parts]
        postings.append(Posting(account_id=card.liability_account_id, amount=-total))
        return self.add_operation(
            Operation(
                kind=OperationKind.CARD_PURCHASE,
                description=description,
                postings=tuple(postings),
                occurred_on=on,
                card_id=card_id,
                cardholder_id=cardholder_id or card.holder_id,
                **extra,
            )
        )

    def record_card_payment(
        self, card_id: UUID, from_account_id: UUID, amount: object, on: date, **extra: Any
    ) -> Operation:
        """Paying the bill settles the obligation; it is not a new expense (docs/00 §4.4)."""
        card = self.cards.get(card_id)
        if card is None:
            raise DomainError("Cartão inexistente.")
        self._require(from_account_id, AccountType.ASSET)
        value = to_decimal(amount)
        if value <= 0:
            raise DomainError("Informe um valor positivo.")
        return self.add_operation(
            Operation(
                kind=OperationKind.CARD_PAYMENT,
                description=f"Pagamento de fatura — {card.name}",
                postings=(
                    Posting(account_id=card.liability_account_id, amount=value),
                    Posting(account_id=from_account_id, amount=-value),
                ),
                occurred_on=on,
                settled_on=on,
                card_id=card_id,
                **extra,
            )
        )

    # ── persistence ─────────────────────────────────────

    def to_records(self) -> list[tuple[UUID, str, dict[str, Any]]]:
        rows: list[tuple[UUID, str, dict[str, Any]]] = [(META_ID, "ledger.meta", self.meta.model_dump(mode="json"))]
        for kind, collection in self._store.items():
            if kind == "history":
                continue
            rows.extend((eid, kind, entity.model_dump(mode="json")) for eid, entity in collection.items())
        rows.extend((h.id, "history", h.model_dump(mode="json")) for h in self.history)
        return rows

    @classmethod
    def from_records(cls, rows: Iterable[tuple[UUID, str, dict[str, Any]]]) -> "Ledger":
        rows = list(rows)
        meta_rows = [payload for _, kind, payload in rows if kind == "ledger.meta"]
        if len(meta_rows) != 1:
            raise DomainError("Cofre sem dados financeiros reconhecíveis.")
        import opesvault.registry  # noqa: F401 - registers every persisted kind
        from opesvault.domain.migrations import migrate

        original_version = int(meta_rows[0].get("schema_version", 0))
        meta_payload, rows = migrate(meta_rows[0], rows)
        ledger = cls(LedgerMeta.model_validate(meta_payload))
        if original_version != SCHEMA_VERSION:
            ledger.migrated_from = original_version
        for _, kind, payload in rows:
            if kind == "ledger.meta":
                continue
            model = cls.KINDS.get(kind)
            if model is None:
                raise DomainError("Cofre contém dados de uma versão mais nova do OpesVault.")
            entity = model.model_validate(payload)
            if kind == "history":
                list.append(ledger.history, entity)
            else:
                collection = ledger._collection(kind)
                assert isinstance(collection, _TrackedDict)
                collection.load(getattr(entity, "id"), entity)  # noqa: B009
        ledger.history.sort(key=lambda h: h.at)
        ledger.change_count = 0
        ledger.dirty = {}
        return ledger

    def record_for(self, kind: str, key: UUID) -> dict[str, Any] | None:
        """Current JSON payload of one persisted row, or None if it no longer exists."""
        if kind == "ledger.meta":
            return self.meta.model_dump(mode="json")
        if kind == "history":
            entry = next((h for h in reversed(self.history) if h.id == key), None)
            return entry.model_dump(mode="json") if entry else None
        entity = self._store.get(kind, {}).get(key)
        return entity.model_dump(mode="json") if entity is not None else None

    def row_counts(self) -> dict[str, int]:
        counts = {kind: len(c) for kind, c in self._store.items() if kind != "history" and c}
        counts["history"] = len(self.history)
        counts["ledger.meta"] = 1
        return {k: v for k, v in counts.items() if v}
