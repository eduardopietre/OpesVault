"""Reimbursements to receive and settling up between family members (docs/09 §1.3 E).

Reimbursement: an expense someone else will pay back (health plan, employer). When the
money arrives it is recorded as a refund of the same categories, so the net expense is
right; the refund counts in the month it is received (the expense month may be closed).

Settling up: in a shared expense, whoever paid fronted the other members' shares. The
payer is the only holder of the paying account, or the holder of the card; a joint account
paid for everyone, so it creates no debt between members. A share is a rateio posting's
member or, without rateio, the operation's member. Nothing here moves money: recording a
settlement only says it was paid back.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import Field

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountType, Amount, Operation, OperationKind, Posting, YearMonth, _Entity
from opesvault.domain.money import ZERO, allocate, is_cents, to_decimal

# ── reimbursements ───────────────────────────────────────


class Reimbursement(_Entity):
    operation_id: UUID  # the expense to be paid back
    payer: str = Field(min_length=1, max_length=80)  # "Plano de saúde", "Empresa"
    expected: Amount
    requested_on: date | None = None
    denied: bool = False
    note: str | None = Field(default=None, max_length=500)
    receipt_ids: tuple[UUID, ...] = ()  # refund operations
    version: int = 1


Ledger.register_kind("reimbursement", Reimbursement)


class ReimbursementState(StrEnum):
    PENDING = "pending"
    PARTIAL = "partial"
    RECEIVED = "received"
    DENIED = "denied"


STATE_LABELS = {
    ReimbursementState.PENDING: "A receber",
    ReimbursementState.PARTIAL: "Recebido em parte",
    ReimbursementState.RECEIVED: "Recebido",
    ReimbursementState.DENIED: "Negado",
}


def reimbursements(ledger: Ledger) -> dict[UUID, Reimbursement]:
    return ledger.entities("reimbursement")


def _expense_parts(ledger: Ledger, op: Operation) -> list[Posting]:
    return [p for p in op.postings if ledger.account(p.account_id).type is AccountType.EXPENSE and p.amount > 0]


def request(
    ledger: Ledger, operation_id: UUID, payer: str, expected: object, requested_on: date | None = None
) -> Reimbursement:
    op = ledger.operations.get(operation_id)
    if op is None or not op.active:
        raise DomainError("Escolha um lançamento ativo.")
    parts = _expense_parts(ledger, op)
    if not parts:
        raise DomainError("Só despesas podem ter reembolso.")
    if any(r.operation_id == operation_id and not r.denied for r in reimbursements(ledger).values()):
        raise DomainError("Este lançamento já tem um reembolso registrado.")
    value = to_decimal(expected)
    if value <= 0 or not is_cents(value):
        raise DomainError("Informe o valor esperado em reais e centavos.")
    if value > sum((p.amount for p in parts), ZERO):
        raise DomainError("O reembolso esperado passa do valor da despesa.")
    if not payer.strip():
        raise DomainError("Informe quem reembolsa.")
    return ledger.put(
        "reimbursement",
        Reimbursement(operation_id=operation_id, payer=payer.strip(), expected=value, requested_on=requested_on),
    )


def received(ledger: Ledger, item: Reimbursement) -> Decimal:
    total = ZERO
    for op_id in item.receipt_ids:
        op = ledger.operations.get(op_id)
        if op is not None and op.active:
            total += sum(
                (-p.amount for p in op.postings if ledger.account(p.account_id).type is AccountType.EXPENSE), ZERO
            )
    return total


def state(ledger: Ledger, item: Reimbursement) -> ReimbursementState:
    if item.denied:
        return ReimbursementState.DENIED
    got = received(ledger, item)
    if got >= item.expected:
        return ReimbursementState.RECEIVED
    return ReimbursementState.PARTIAL if got > 0 else ReimbursementState.PENDING


def receive(ledger: Ledger, reimbursement_id: UUID, account_id: UUID, amount: object, on: date) -> Operation:
    """Records the money received as a refund of the original categories, in proportion."""
    item = reimbursements(ledger).get(reimbursement_id)
    if item is None:
        raise DomainError("Reembolso inexistente.")
    if item.denied:
        raise DomainError("Reembolso negado não recebe valores.")
    original = ledger.operations.get(item.operation_id)
    if original is None:
        raise DomainError("O lançamento reembolsado não existe mais.")
    if ledger.account(account_id).type is not AccountType.ASSET:
        raise DomainError("Escolha a conta que recebeu o reembolso.")
    value = to_decimal(amount)
    if value <= 0 or not is_cents(value):
        raise DomainError("Informe um valor positivo em reais e centavos.")
    parts = _expense_parts(ledger, original)
    shares = allocate(value, [p.amount for p in parts])
    postings = [Posting(account_id=account_id, amount=value)]
    postings += [
        Posting(account_id=p.account_id, amount=-share, member_id=p.member_id)
        for p, share in zip(parts, shares, strict=True)
        if share
    ]
    op = ledger.add_operation(
        Operation(
            kind=OperationKind.REFUND,
            description=f"Reembolso ({item.payer}): {original.description}"[:500],
            postings=tuple(postings),
            occurred_on=on,
            settled_on=on,
            accrual_month=YearMonth.of(on),
            member_id=original.member_id,
        )
    )
    ledger.put(
        "reimbursement",
        item.model_copy(update={"receipt_ids": (*item.receipt_ids, op.id), "version": item.version + 1}),
        reason="reembolso recebido",
    )
    return op


def deny(ledger: Ledger, reimbursement_id: UUID, reason: str) -> Reimbursement:
    item = reimbursements(ledger).get(reimbursement_id)
    if item is None:
        raise DomainError("Reembolso inexistente.")
    if not reason.strip():
        raise DomainError("Informe o motivo.")
    return ledger.put(
        "reimbursement", item.model_copy(update={"denied": True, "version": item.version + 1}), reason=reason
    )


def open_items(ledger: Ledger) -> list[Reimbursement]:
    """Still waiting for money: pending or partially received."""
    waiting = (ReimbursementState.PENDING, ReimbursementState.PARTIAL)
    return [r for r in reimbursements(ledger).values() if state(ledger, r) in waiting]


# ── settling up between members ──────────────────────────


class MemberSettlement(_Entity):
    debtor_id: UUID  # who paid back
    creditor_id: UUID  # who had fronted the money
    amount: Amount
    on: date
    note: str | None = Field(default=None, max_length=500)


Ledger.register_kind("member_settlement", MemberSettlement)


def settlements(ledger: Ledger) -> dict[UUID, MemberSettlement]:
    return ledger.entities("member_settlement")


def payer_of(ledger: Ledger, op: Operation) -> UUID | None:
    """Who fronted the money, or None when it is not one person (joint account, unknown holder)."""
    if op.card_id is not None:
        card = ledger.cards.get(op.card_id)
        return card.holder_id if card is not None else None
    # Who paid an expense is the holder of the account it left; a refund goes back to whoever receives it.
    expense = sum((p.amount for p in op.postings if ledger.account(p.account_id).type is AccountType.EXPENSE), ZERO)
    sign = 1 if expense < 0 else -1
    sources = [p for p in op.postings if p.amount * sign > 0 and ledger.account(p.account_id).type is AccountType.ASSET]
    holders = {h for p in sources for h in ledger.account(p.account_id).holders}
    return next(iter(holders)) if len(holders) == 1 else None


@dataclass(frozen=True)
class Share:
    operation_id: UUID
    on: date | None
    description: str
    payer_id: UUID
    beneficiary_id: UUID
    amount: Decimal  # positive: the beneficiary owes the payer


def shares(ledger: Ledger, start: date | None = None, end: date | None = None) -> list[Share]:
    """Shares fronted by one member for another, from expenses (and their refunds)."""
    out: list[Share] = []
    for op in ledger.active_operations():
        if op.kind is OperationKind.OPENING_BALANCE:
            continue
        when = op.occurred_on or op.cash_date
        if (start is not None or end is not None) and when is None:
            continue
        if start is not None and when is not None and when < start:
            continue
        if end is not None and when is not None and when > end:
            continue
        payer = payer_of(ledger, op)
        if payer is None:
            continue
        owed: dict[UUID, Decimal] = defaultdict(lambda: ZERO)
        for p in op.postings:
            if ledger.account(p.account_id).type is not AccountType.EXPENSE:
                continue
            member = p.member_id or op.member_id
            if member is not None and member != payer:
                owed[member] += p.amount
        for member, value in owed.items():
            if value:
                out.append(Share(op.id, when, op.description, payer, member, value))
    return sorted(out, key=lambda s: (s.on or date.min, s.description))


@dataclass
class Balance:
    debtor_id: UUID
    creditor_id: UUID
    amount: Decimal
    shares: list[Share] = field(default_factory=list)
    settled: Decimal = ZERO


def balances(ledger: Ledger, start: date | None = None, end: date | None = None) -> list[Balance]:
    """Net amount each member owes another, after settlements; pairs that cancel out are omitted."""
    gross: dict[tuple[UUID, UUID], Decimal] = defaultdict(lambda: ZERO)
    detail: dict[tuple[UUID, UUID], list[Share]] = defaultdict(list)
    for share in shares(ledger, start, end):
        key = (share.beneficiary_id, share.payer_id)
        gross[key] += share.amount
        detail[key].append(share)
    paid: dict[tuple[UUID, UUID], Decimal] = defaultdict(lambda: ZERO)
    for s in settlements(ledger).values():
        if (start is None or s.on >= start) and (end is None or s.on <= end):
            paid[(s.debtor_id, s.creditor_id)] += s.amount
    out: list[Balance] = []
    members = {m for pair in [*gross, *paid] for m in pair}
    seen: set[frozenset[UUID]] = set()
    for a in members:
        for b in members:
            pair = frozenset((a, b))
            if a == b or pair in seen:
                continue
            seen.add(pair)
            a_owes = gross[(a, b)] - paid[(a, b)] + paid[(b, a)]
            b_owes = gross[(b, a)]
            net = a_owes - b_owes
            if net > 0:
                out.append(Balance(a, b, net, detail[(a, b)], paid[(a, b)]))
            elif net < 0:
                out.append(Balance(b, a, -net, detail[(b, a)], paid[(b, a)]))
    return sorted(out, key=lambda x: x.amount, reverse=True)


def settle(
    ledger: Ledger, debtor_id: UUID, creditor_id: UUID, amount: object, on: date, note: str | None = None
) -> MemberSettlement:
    if debtor_id == creditor_id:
        raise DomainError("Escolha dois integrantes diferentes.")
    if debtor_id not in ledger.members or creditor_id not in ledger.members:
        raise DomainError("Integrante inexistente.")
    value = to_decimal(amount)
    if value <= 0 or not is_cents(value):
        raise DomainError("Informe um valor positivo em reais e centavos.")
    return ledger.put(
        "member_settlement",
        MemberSettlement(debtor_id=debtor_id, creditor_id=creditor_id, amount=value, on=on, note=note or None),
    )
