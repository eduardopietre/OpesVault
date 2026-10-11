"""Bank accounts as the bank sees them: bank (COMPE), branch, number, holders and what is inside.

A bank account groups the ledger accounts that live at the same branch and number: the
checking account, the savings account and the investments held there (any mix, or none).
The money stays in the ledger accounts and positions, so balances, reports, the overview and
the tax sheets keep working unchanged; this record only says where things are and whose.

One holder, or a joint account with a first and a second holder; the order is kept in the
ledger accounts' `holders` (first = principal).

Values at a date: the balance the bank shows on a day is recorded as a check (conferência) and,
when the user asks, the difference becomes an adjustment against opening equity, so the app's
balance on that day equals the bank's. Investments get a valuation on that date.
"""

import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import Field

from opesvault.catalogs import bank as catalog_bank
from opesvault.domain import queries
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import (
    AccountSubtype,
    AccountType,
    LedgerAccount,
    Operation,
    OperationKind,
    Origin,
    Posting,
    _Entity,
)
from opesvault.domain.money import ZERO, is_cents, to_decimal

TOKEN = re.compile(r"^\S{1,30}$")  # letters, digits and symbols; no spaces


class BankAccount(_Entity):
    name: str = Field(min_length=1, max_length=120)  # how the family calls it
    bank_code: str | None = Field(default=None, pattern=r"^\d{3}$")  # COMPE
    bank_name: str = Field(min_length=1, max_length=150)
    branch: str | None = Field(default=None, pattern=r"^\S{1,30}$")
    number: str | None = Field(default=None, pattern=r"^\S{1,30}$")
    holder_id: UUID
    co_holder_id: UUID | None = None  # joint account: the second holder
    checking_id: UUID | None = None
    savings_id: UUID | None = None
    archived: bool = False

    @property
    def joint(self) -> bool:
        return self.co_holder_id is not None

    @property
    def holders(self) -> tuple[UUID, ...]:
        return (self.holder_id, self.co_holder_id) if self.co_holder_id else (self.holder_id,)

    @property
    def where(self) -> str:
        """'Banco X (341), ag. 0001, conta 12345-6'."""
        bank = f"{self.bank_name} ({self.bank_code})" if self.bank_code else self.bank_name
        parts = [bank]
        if self.branch:
            parts.append(f"ag. {self.branch}")
        if self.number:
            parts.append(f"conta {self.number}")
        return ", ".join(parts)

    def components(self) -> list[tuple["Part", UUID]]:
        out: list[tuple[Part, UUID]] = []
        if self.checking_id:
            out.append((Part.CHECKING, self.checking_id))
        if self.savings_id:
            out.append((Part.SAVINGS, self.savings_id))
        return out


Ledger.register_kind("bank_account", BankAccount)


class Part(StrEnum):
    CHECKING = "checking"
    SAVINGS = "savings"


PART_LABELS = {Part.CHECKING: "Conta corrente", Part.SAVINGS: "Poupança"}
PART_SUBTYPES = {Part.CHECKING: AccountSubtype.CHECKING, Part.SAVINGS: AccountSubtype.SAVINGS}


def bank_accounts(ledger: Ledger) -> dict[UUID, BankAccount]:
    return ledger.entities("bank_account")


def of_account(ledger: Ledger, account_id: UUID) -> BankAccount | None:
    """The bank account a ledger account belongs to."""
    return next((b for b in bank_accounts(ledger).values() if account_id in (b.checking_id, b.savings_id)), None)


def positions_of(ledger: Ledger, bank_id: UUID) -> list[UUID]:
    from opesvault.investments.profile import profiles
    from opesvault.investments.service import positions

    held = {p.position_id for p in profiles(ledger).values() if p.bank_account_id == bank_id}
    return [p.id for p in positions(ledger).values() if p.id in held and not p.closed]


def _clean(value: str | None, label: str) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    if not TOKEN.match(text):
        raise DomainError(f"{label}: use letras, números e símbolos, sem espaços (até 30).")
    return text


def _check(ledger: Ledger, item: BankAccount) -> None:
    if item.holder_id not in ledger.members:
        raise DomainError("Escolha o titular da conta.")
    if item.co_holder_id is not None:
        if item.co_holder_id not in ledger.members:
            raise DomainError("Escolha o segundo titular.")
        if item.co_holder_id == item.holder_id:
            raise DomainError("O segundo titular precisa ser outra pessoa.")
    if item.bank_code is not None and catalog_bank(item.bank_code) is None:
        raise DomainError("Banco fora da lista de códigos COMPE.")
    for part, account_id in item.components():
        account = ledger.accounts.get(account_id)
        if account is None or account.subtype is not PART_SUBTYPES[part]:
            raise DomainError(f"A {PART_LABELS[part].lower()} escolhida não é do tipo certo.")
        other = of_account(ledger, account_id)
        if other is not None and other.id != item.id:
            raise DomainError(f"{account.name} já pertence à conta bancária {other.name}.")


def build(
    *,
    name: str,
    bank_code: str | None,
    bank_name: str | None,
    branch: str | None,
    number: str | None,
    holder_id: UUID,
    co_holder_id: UUID | None = None,
) -> BankAccount:
    found = catalog_bank(bank_code)
    if bank_code and found is None:
        raise DomainError("Banco fora da lista de códigos COMPE.")
    label = found.name if found else " ".join((bank_name or "").split())
    if not label:
        raise DomainError("Escolha o banco ou informe o nome da instituição.")
    title = " ".join(name.split()) or (found.short_name if found else label)
    return BankAccount(
        name=title[:120],
        bank_code=found.code if found else None,
        bank_name=label[:150],
        branch=_clean(branch, "Agência"),
        number=_clean(number, "Conta"),
        holder_id=holder_id,
        co_holder_id=co_holder_id,
    )


def create(
    ledger: Ledger,
    item: BankAccount,
    *,
    checking: bool | UUID = False,
    savings: bool | UUID = False,
    opening: dict[Part, tuple[Decimal, date]] | None = None,
) -> BankAccount:
    """Saves a bank account. Each part is new (True), an existing ledger account (its id) or absent."""
    if item.id in bank_accounts(ledger):
        raise DomainError("Conta bancária já cadastrada.")
    ids: dict[Part, UUID | None] = {}
    for part, wanted in ((Part.CHECKING, checking), (Part.SAVINGS, savings)):
        ids[part] = wanted if isinstance(wanted, UUID) else None
    draft = item.model_copy(update={"checking_id": ids[Part.CHECKING], "savings_id": ids[Part.SAVINGS]})
    _check(ledger, draft)
    for part, wanted in ((Part.CHECKING, checking), (Part.SAVINGS, savings)):
        if wanted is True:
            account = ledger.add_account(
                LedgerAccount(
                    name=f"{item.name} — {PART_LABELS[part].lower()}"[:120],
                    type=AccountType.ASSET,
                    subtype=PART_SUBTYPES[part],
                    institution=item.bank_name[:120],
                    masked_number=_masked(item),
                    holders=item.holders,
                )
            )
            ids[part] = account.id
    saved = ledger.put(
        "bank_account", draft.model_copy(update={"checking_id": ids[Part.CHECKING], "savings_id": ids[Part.SAVINGS]})
    )
    _sync(ledger, saved)
    for part, (value, on) in (opening or {}).items():
        account_id = ids.get(part)
        if account_id is not None and value:
            ledger.record_opening_balance(account_id, value, on)
    return saved


def update(ledger: Ledger, item: BankAccount, *, add: tuple[Part, ...] = ()) -> BankAccount:
    """Saves changes (bank, numbers, holders) and adds missing parts; ledger accounts follow."""
    current = bank_accounts(ledger).get(item.id)
    if current is None:
        raise DomainError("Conta bancária inexistente.")
    _check(ledger, item)
    for part in add:
        if dict(item.components()).get(part) is None:
            account = ledger.add_account(
                LedgerAccount(
                    name=f"{item.name} — {PART_LABELS[part].lower()}"[:120],
                    type=AccountType.ASSET,
                    subtype=PART_SUBTYPES[part],
                    institution=item.bank_name[:120],
                    masked_number=_masked(item),
                    holders=item.holders,
                )
            )
            field = "checking_id" if part is Part.CHECKING else "savings_id"
            item = item.model_copy(update={field: account.id})
    saved = item if item == current else ledger.put("bank_account", item, reason="conta bancária alterada")
    _sync(ledger, saved)
    return saved


def archive(ledger: Ledger, bank_id: UUID) -> None:
    item = bank_accounts(ledger).get(bank_id)
    if item is not None and not item.archived:
        ledger.put("bank_account", item.model_copy(update={"archived": True}), reason="conta bancária encerrada")


def _masked(item: BankAccount) -> str | None:
    parts = [f"ag {item.branch}" if item.branch else "", f"c {item.number}" if item.number else ""]
    text = " ".join(p for p in parts if p)
    return text[:32] or None


def _sync(ledger: Ledger, item: BankAccount) -> None:
    """Holders, institution and number go to the ledger accounts and the investments held there."""
    for _part, account_id in item.components():
        account = ledger.account(account_id)
        updated = account.model_copy(
            update={"holders": item.holders, "institution": item.bank_name[:120], "masked_number": _masked(item)}
        )
        if updated != account:
            ledger.update_account(updated, "dados da conta bancária")
    from opesvault.investments.service import positions

    for position_id in positions_of(ledger, item.id):
        pos = positions(ledger)[position_id]
        if pos.holder_id != item.holder_id:
            ledger.put("position", pos.model_copy(update={"holder_id": item.holder_id}), reason="titular da conta")
            account = ledger.accounts.get(pos.account_id)
            if account is not None and account.holders != (item.holder_id,):
                ledger.update_account(account.model_copy(update={"holders": (item.holder_id,)}), "titular da conta")
    _identify_bank(ledger, item)


def _identify_bank(ledger: Ledger, item: BankAccount) -> None:
    """The bank's CNPJ (from the COMPE list) for the tax sheets, unless the user set another."""
    from opesvault.tax import records
    from opesvault.tax.model import TaxSubject

    found = catalog_bank(item.bank_code)
    if found is None or not found.cnpj:
        return
    for _part, account_id in item.components():
        if records.identity(ledger, TaxSubject.ACCOUNT, account_id) is None:
            records.set_identity(ledger, TaxSubject.ACCOUNT, account_id, found.cnpj, found.name)


# ── values at a date ──────────


@dataclass(frozen=True)
class Value:
    label: str
    kind: str  # "checking", "savings" or "investment"
    ref: UUID  # ledger account or position
    value: Decimal | None  # None: unknown on that date (an investment never valued)


def values_at(ledger: Ledger, bank_id: UUID, on: date) -> list[Value]:
    """What the app has for each part of the bank account at the end of a day."""
    from opesvault.investments.performance import value_at
    from opesvault.investments.service import assets, positions

    item = bank_accounts(ledger)[bank_id]
    out = [
        Value(PART_LABELS[part], part.value, account_id, queries.balance(ledger, account_id, on))
        for part, account_id in item.components()
    ]
    for position_id in positions_of(ledger, bank_id):
        pos = positions(ledger)[position_id]
        observed = value_at(ledger, position_id, on)
        out.append(
            Value(
                assets(ledger)[pos.asset_id].name,
                "investment",
                position_id,
                observed.valuation.value if observed else None,
            )
        )
    return out


def total(values: list[Value]) -> Decimal | None:
    known = [v.value for v in values if v.value is not None]
    return sum(known, ZERO) if known else None


@dataclass(frozen=True)
class Recorded:
    checks: int
    adjustments: int
    valuations: int


def record_values(
    ledger: Ledger,
    bank_id: UUID,
    on: date,
    values: dict[UUID, object],
    *,
    adjust: set[UUID] | None = None,
    note: str | None = None,
) -> Recorded:
    """Values the bank shows on `on`, by ledger account or position id.

    Accounts: a conferência; for those in `adjust`, the difference is posted so the app's balance
    equals the bank's that day. Investments: a valuation of that date ("valor informado").
    """
    from opesvault.domain import balance_checks
    from opesvault.investments.model import ValueNature
    from opesvault.investments.service import add_valuation, correct_valuation, valuations_of

    item = bank_accounts(ledger).get(bank_id)
    if item is None:
        raise DomainError("Conta bancária inexistente.")
    if on > date.today():
        raise DomainError("A data não pode estar no futuro.")
    accounts = {account_id for _part, account_id in item.components()}
    held = set(positions_of(ledger, bank_id))
    checks = adjustments = valuations = 0
    text = (note or "").strip() or "valor informado"
    for ref, raw in values.items():
        value = raw if isinstance(raw, Decimal) else to_decimal(raw)
        if not is_cents(value):
            raise DomainError("Use valores em reais e centavos.")
        if ref in accounts:
            balance_checks.record(ledger, ref, on, value, text)
            checks += 1
            if adjust and ref in adjust and adjust_balance(ledger, ref, on, value) is not None:
                adjustments += 1
        elif ref in held:
            if value < 0:
                raise DomainError("O valor de um investimento não pode ser negativo.")
            same = next((v for v in valuations_of(ledger, ref) if v.on == on and v.source == SOURCE), None)
            if same is None:
                add_valuation(ledger, ref, on, value, ValueNature.GROSS, source=SOURCE, note=text)
            elif same.value != value:
                correct_valuation(ledger, same.id, value, "valor informado de novo")
            valuations += 1
        else:
            raise DomainError("Esse item não pertence a esta conta bancária.")
    return Recorded(checks, adjustments, valuations)


SOURCE = "valor informado"


def adjust_balance(ledger: Ledger, account_id: UUID, on: date, informed: Decimal) -> Operation | None:
    """Posts the difference against opening equity so the balance at the end of `on` is `informed`."""
    account = ledger.account(account_id)
    if account.type is not AccountType.ASSET:
        raise DomainError("Só contas de dinheiro recebem ajuste de saldo.")
    difference = informed - queries.balance(ledger, account_id, on)
    if difference == 0:
        return None
    if ledger.meta.opening_equity_id is None:
        raise DomainError("Cofre sem conta de patrimônio de abertura.")
    first = not any(p.account_id == account_id for op in ledger.active_operations() for p in op.postings)
    return ledger.add_operation(
        Operation(
            kind=OperationKind.OPENING_BALANCE,
            description=(
                f"Saldo de abertura — {account.name}"
                if first
                else f"Ajuste ao saldo informado em {on:%d/%m/%Y} — {account.name}"
            )[:500],
            postings=(
                Posting(account_id=account_id, amount=difference),
                Posting(account_id=ledger.meta.opening_equity_id, amount=-difference),
            ),
            occurred_on=on,
            settled_on=on,
            origin=Origin(),
        )
    )
