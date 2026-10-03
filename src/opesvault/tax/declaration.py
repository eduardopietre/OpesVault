"""The year as the return's sheets read it (fichas): income, payments, assets and debts.

Support material: values come from what was recorded, by cash date (the return follows the
cash regime). Natures, groups and codes are the user's choices; where none was made the row
says so instead of guessing. A declarant sees their own items and their dependents'.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from uuid import UUID

from opesvault.domain import merchants, queries
from opesvault.domain.deductibles import DeductibleKind
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountSubtype, AccountType, Operation, Posting, YearMonth
from opesvault.domain.money import ZERO
from opesvault.investments.model import AssetClass, EventKind, InvestmentEvent
from opesvault.tax import records
from opesvault.tax.model import (
    ASSET_GROUPS,
    FilingSubject,
    IncomeKind,
    IncomeNature,
    NatureSubject,
    PaymentPurpose,
    TaxSubject,
)

NOTICE = (
    "Material de apoio à declaração, a partir do que foi registrado. A natureza de cada rendimento, "
    "os grupos e os códigos dos bens são escolhas suas; nada é classificado sozinho. Confira com os informes."
)
# Gains of these classes are declared month by month in Renda variável, not as exclusive income.
VARIABLE_CLASSES = frozenset({AssetClass.STOCK, AssetClass.REIT, AssetClass.ETF})


def _when(op: Operation) -> date | None:
    return op.cash_date


def owner_of(ledger: Ledger, op: Operation, posting: Posting | None = None) -> UUID | None:
    """Whose item this is: the rateio share, the operation's member or the sole holder of its account."""
    member = (posting.member_id if posting is not None else None) or op.member_id
    if member is not None:
        return member
    holders = {
        h
        for p in op.postings
        for h in ledger.account(p.account_id).holders
        if ledger.account(p.account_id).type in (AccountType.ASSET, AccountType.LIABILITY)
    }
    return next(iter(holders)) if len(holders) == 1 else None


def _in(member: UUID | None, people: set[UUID] | None) -> bool:
    return people is None or member in people


def _owners_in(owners: tuple[UUID, ...] | set[UUID], people: set[UUID] | None) -> bool:
    return people is None or bool(set(owners) & people)


def investment_operations(ledger: Ledger) -> dict[UUID, InvestmentEvent]:
    from opesvault.investments.service import events

    return {op_id: event for event in events(ledger).values() for op_id in event.operation_ids}


# ── income ──────────


@dataclass
class TaxableRow:
    """Rendimentos tributáveis recebidos de pessoa jurídica: one payer, one person."""

    source_id: UUID  # the income category
    payer: str
    tax_id: str | None
    member_id: UUID | None
    taxable: Decimal = ZERO
    social_security: Decimal = ZERO
    withheld: Decimal = ZERO
    thirteenth: Decimal = ZERO
    thirteenth_withheld: Decimal = ZERO
    net_only: int = 0  # deposits without the payslip's gross: counted at the amount received
    operations: list[UUID] = field(default_factory=list)


@dataclass
class OtherIncomeRow:
    """Isentos, exclusivos or Carnê-Leão: one source, one person."""

    nature: IncomeNature | None  # None: not classified yet
    source: str
    subject: NatureSubject
    ref: UUID
    tax_id: str | None
    member_id: UUID | None
    amount: Decimal = ZERO
    withheld: Decimal = ZERO
    operations: list[UUID] = field(default_factory=list)


@dataclass
class CarneLeaoMonth:
    month: YearMonth
    member_id: UUID | None
    amount: Decimal
    paid: Decimal


@dataclass
class Income:
    taxable: list[TaxableRow] = field(default_factory=list)
    other: list[OtherIncomeRow] = field(default_factory=list)
    carne_leao: list[CarneLeaoMonth] = field(default_factory=list)
    unassigned: int = 0  # income of nobody in particular: left out of a declarant's view

    def by_nature(self, nature: IncomeNature | None) -> list[OtherIncomeRow]:
        return [r for r in self.other if r.nature is nature]

    @property
    def unclassified(self) -> list[OtherIncomeRow]:
        return self.by_nature(None)


def _category_payer(ledger: Ledger, category_id: UUID) -> tuple[str, str | None]:
    found = records.identity(ledger, TaxSubject.CATEGORY, category_id)
    name = ledger.account(category_id).name
    return ((found.name or name) if found else name), (found.tax_id if found else None)


def income(ledger: Ledger, year: int, people: set[UUID] | None = None) -> Income:
    out = Income()
    invest = investment_operations(ledger)
    taxable: dict[tuple[UUID, UUID | None], TaxableRow] = {}
    other: dict[tuple[NatureSubject, UUID, UUID | None], OtherIncomeRow] = {}
    carne: dict[tuple[YearMonth, UUID | None], Decimal] = defaultdict(lambda: ZERO)
    for op in ledger.active_operations():
        when = _when(op)
        if when is None or when.year != year or op.id in invest:
            continue
        for p in op.postings:
            account = ledger.account(p.account_id)
            if account.type is not AccountType.INCOME or p.amount == 0:
                continue
            member = owner_of(ledger, op, p)
            if not _in(member, people):
                if people is not None and member is None:
                    out.unassigned += 1
                continue
            value = -p.amount
            nature = records.nature_of(ledger, NatureSubject.CATEGORY, account.id)
            if nature is IncomeNature.TAXABLE_PJ:
                payer, tax_id = _category_payer(ledger, account.id)
                row = taxable.setdefault((account.id, member), TaxableRow(account.id, payer, tax_id, member))
                _add_payslip(ledger, row, op, value)
            elif nature is IncomeNature.CARNE_LEAO:
                carne[(YearMonth.of(when), member)] += value
                _other_row(ledger, other, nature, NatureSubject.CATEGORY, account.id, member).add(op, value)
            elif nature is not IncomeNature.IGNORED:
                _other_row(ledger, other, nature, NatureSubject.CATEGORY, account.id, member).add(op, value)
    _investment_income(ledger, year, people, other)
    out.taxable = sorted(taxable.values(), key=lambda r: (r.payer.casefold(), str(r.member_id)))
    out.other = sorted(other.values(), key=lambda r: (r.nature or "", r.source.casefold(), str(r.member_id)))
    out.carne_leao = [
        CarneLeaoMonth(month, member, value, records.paid(ledger, PaymentPurpose.CARNE_LEAO, month, member))
        for (month, member), value in sorted(carne.items(), key=lambda kv: (kv[0][0].year, kv[0][0].month))
        if value
    ]
    return out


def _add_payslip(ledger: Ledger, row: TaxableRow, op: Operation, received: Decimal) -> None:
    detail = records.detail_of(ledger, op.id)
    row.operations.append(op.id)
    gross = detail.gross if detail is not None and detail.gross is not None else None
    if gross is None:
        row.net_only += 1
    amount = gross if gross is not None else received
    withheld = detail.withheld if detail is not None and detail.withheld is not None else ZERO
    if detail is not None and detail.kind is IncomeKind.THIRTEENTH:
        row.thirteenth += amount
        row.thirteenth_withheld += withheld
        return
    row.taxable += amount
    row.withheld += withheld
    if detail is not None and detail.social_security is not None:
        row.social_security += detail.social_security


class _OtherAccumulator:
    def __init__(self, row: OtherIncomeRow) -> None:
        self.row = row

    def add(self, op: Operation | None, value: Decimal, withheld: Decimal = ZERO) -> None:
        self.row.amount += value
        self.row.withheld += withheld
        if op is not None:
            self.row.operations.append(op.id)


def _other_row(
    ledger: Ledger,
    rows: dict[tuple[NatureSubject, UUID, UUID | None], OtherIncomeRow],
    nature: IncomeNature | None,
    subject: NatureSubject,
    ref: UUID,
    member: UUID | None,
    source: str | None = None,
    tax_id: str | None = None,
) -> _OtherAccumulator:
    key = (subject, ref, member)
    if key not in rows:
        if subject is NatureSubject.CATEGORY:
            source, tax_id = _category_payer(ledger, ref)
        rows[key] = OtherIncomeRow(nature, source or "?", subject, ref, tax_id, member)
    return _OtherAccumulator(rows[key])


def _investment_income(
    ledger: Ledger,
    year: int,
    people: set[UUID] | None,
    rows: dict[tuple[NatureSubject, UUID, UUID | None], OtherIncomeRow],
) -> None:
    from opesvault.investments.service import assets, events, positions

    for event in events(ledger).values():
        if event.on.year != year:
            continue
        pos = positions(ledger).get(event.position_id)
        if pos is None:
            continue
        asset = assets(ledger)[pos.asset_id]
        if event.kind is EventKind.DISTRIBUTION:
            value = event.gross if event.gross is not None else event.net
        elif event.kind is EventKind.WITHDRAWAL or (
            event.kind is EventKind.SELL and asset.asset_class not in VARIABLE_CLASSES
        ):
            value = event.realized_gain
            if value is None or value <= 0:
                continue
        else:
            continue
        if value is None or not _in(pos.holder_id, people):
            continue
        nature = records.nature_of(ledger, NatureSubject.POSITION, pos.id)
        if nature is IncomeNature.IGNORED:
            continue
        institution = (
            records.identity(ledger, TaxSubject.ACCOUNT, event.cash_account_id) if event.cash_account_id else None
        )
        _other_row(
            ledger,
            rows,
            nature,
            NatureSubject.POSITION,
            pos.id,
            pos.holder_id,
            source=asset.name,
            tax_id=institution.tax_id if institution else None,
        ).add(None, value, event.tax_withheld)


# ── payments (Pagamentos efetuados) ──────────


@dataclass
class PaymentRow:
    kind: DeductibleKind
    payee_key: str
    payee: str
    tax_id: str | None
    beneficiary_id: UUID | None
    paid: Decimal = ZERO
    not_deductible: Decimal = ZERO  # reimbursed by a health plan or employer
    operations: list[UUID] = field(default_factory=list)
    without_receipt: int = 0

    @property
    def net(self) -> Decimal:
        return self.paid - self.not_deductible


def payments(ledger: Ledger, year: int, people: set[UUID] | None = None) -> list[PaymentRow]:
    from opesvault.domain import attachments, deductibles, sharing

    receipts = {
        op_id: item.operation_id for item in sharing.reimbursements(ledger).values() for op_id in item.receipt_ids
    }
    rows: dict[tuple[DeductibleKind, str, UUID | None], PaymentRow] = {}
    for group in deductibles.annual(ledger, year):
        for line in group.lines:
            op = line.operation
            original = ledger.operations.get(receipts.get(op.id, op.id), op)
            beneficiary = line.member_id or owner_of(ledger, original)
            if not _in(beneficiary, people):
                continue
            key = merchants.key_of(original.description)
            row = rows.get((group.kind, key, beneficiary))
            if row is None:
                found = records.identity(ledger, TaxSubject.MERCHANT, key)
                payee = (found.name if found and found.name else None) or merchants.merchant_of(
                    ledger, original.description
                )
                row = rows[(group.kind, key, beneficiary)] = PaymentRow(
                    group.kind, key, payee, found.tax_id if found else None, beneficiary
                )
            if op.id in receipts:
                row.not_deductible += -line.amount
                continue
            row.paid += line.amount
            if op.id not in row.operations:
                row.operations.append(op.id)
                if line.amount > 0 and not attachments.of_operation(ledger, op.id):
                    row.without_receipt += 1
    order = list(deductibles.DeductibleKind)
    return sorted(rows.values(), key=lambda r: (order.index(r.kind), r.payee.casefold(), str(r.beneficiary_id)))


# ── assets and debts ──────────


@dataclass
class AssetRow:
    subject: str  # "account", "position" or "declared"
    ref: UUID
    name: str
    group: str | None
    code: str | None
    suggested: bool  # group suggested by the app, still to be confirmed
    description: str
    tax_id: str | None
    owners: tuple[UUID, ...]
    previous: Decimal | None  # 31/12 of the year before; None: cost unknown
    current: Decimal | None

    @property
    def group_label(self) -> str:
        return ASSET_GROUPS.get(self.group or "", "a definir")


def _position_accounts(ledger: Ledger) -> dict[UUID, UUID]:
    from opesvault.investments.service import positions

    return {p.account_id: p.id for p in positions(ledger).values()}


def assets(ledger: Ledger, year: int, people: set[UUID] | None = None) -> list[AssetRow]:
    """Bens e Direitos at acquisition cost (what is still held), never at market value."""
    from opesvault.investments.service import assets as asset_entities
    from opesvault.investments.service import positions

    end, before = date(year, 12, 31), date(year - 1, 12, 31)
    now, then = queries.balances(ledger, end), queries.balances(ledger, before)
    held = _position_accounts(ledger)
    out: list[AssetRow] = []
    for account in sorted(ledger.accounts.values(), key=lambda a: a.name.casefold()):
        if account.type is not AccountType.ASSET or account.id in held or account.subtype is AccountSubtype.INVESTMENT:
            continue
        current, previous = now.get(account.id, ZERO), then.get(account.id, ZERO)
        if not current and not previous:
            continue
        if not _owners_in(account.holders, people) or (people is not None and not account.holders):
            continue
        filing = records.filing_of(ledger, FilingSubject.ACCOUNT, account.id)
        bank = records.identity(ledger, TaxSubject.ACCOUNT, account.id)
        default = " ".join(x for x in (account.name, account.institution, account.masked_number) if x)
        out.append(
            AssetRow(
                "account",
                account.id,
                account.name,
                filing.group if filing else records.suggested_group(subtype=account.subtype),
                filing.code if filing else None,
                filing is None,
                (filing.description if filing and filing.description else default),
                bank.tax_id if bank else None,
                account.holders,
                previous,
                current,
            )
        )
    for pos in positions(ledger).values():
        owners = (pos.holder_id,) if pos.holder_id else ()
        if people is not None and not _owners_in(owners, people):
            continue
        cost_now = queries.balance(ledger, pos.account_id, end) if pos.cost_known else None
        cost_then = queries.balance(ledger, pos.account_id, before) if pos.cost_known else None
        if pos.cost_known and not cost_now and not cost_then:
            continue
        asset = asset_entities(ledger)[pos.asset_id]
        filing = records.filing_of(ledger, FilingSubject.POSITION, pos.id)
        broker = records.identity(ledger, TaxSubject.ACCOUNT, pos.account_id)
        out.append(
            AssetRow(
                "position",
                pos.id,
                asset.name,
                filing.group if filing else records.suggested_group(asset_class=asset.asset_class),
                filing.code if filing else None,
                filing is None,
                (filing.description if filing and filing.description else asset.name),
                broker.tax_id if broker else None,
                owners,
                cost_then,
                cost_now,
            )
        )
    for item in records.declared_assets(ledger).values():
        owners = (item.owner_id,) if item.owner_id else ()
        if people is not None and not _owners_in(owners, people):
            continue

        current, previous = _held_cost(item, end), _held_cost(item, before)
        sold_this_year = item.sold_on is not None and item.sold_on.year == year
        if not current and not previous and not sold_this_year:
            continue
        out.append(
            AssetRow(
                "declared",
                item.id,
                item.name,
                item.group,
                item.code,
                False,
                item.description or item.name,
                None,
                owners,
                previous,
                current,
            )
        )
    return sorted(out, key=lambda r: (r.group or "zz", r.code or "zz", r.name.casefold()))


def _held_cost(item: object, day: date) -> Decimal:
    from opesvault.tax.model import DeclaredAsset

    assert isinstance(item, DeclaredAsset)
    owned = item.acquired_on <= day and (item.sold_on is None or item.sold_on > day)
    return item.cost if owned else ZERO


@dataclass
class DebtRow:
    account_id: UUID
    name: str
    tax_id: str | None
    owners: tuple[UUID, ...]
    previous: Decimal
    current: Decimal


DEBT_SUBTYPES = frozenset({AccountSubtype.LOAN, AccountSubtype.OTHER_LIABILITY})


def debts(ledger: Ledger, year: int, people: set[UUID] | None = None) -> list[DebtRow]:
    """Dívidas e Ônus Reais: loans and other debts on 31/12. Card bills and taxes due are left out."""
    end, before = date(year, 12, 31), date(year - 1, 12, 31)
    now, then = queries.balances(ledger, end), queries.balances(ledger, before)
    out = []
    for account in sorted(ledger.accounts.values(), key=lambda a: a.name.casefold()):
        if account.type is not AccountType.LIABILITY or account.subtype not in DEBT_SUBTYPES:
            continue
        current, previous = now.get(account.id, ZERO), then.get(account.id, ZERO)
        if not current and not previous:
            continue
        if people is not None and not _owners_in(account.holders, people):
            continue
        lender = records.identity(ledger, TaxSubject.ACCOUNT, account.id)
        out.append(
            DebtRow(account.id, account.name, lender.tax_id if lender else None, account.holders, previous, current)
        )
    return out


# ── people ──────────


@dataclass(frozen=True)
class Dependent:
    member_id: UUID
    name: str
    cpf: str | None
    birth_date: date | None
    relation: str | None


def dependents(ledger: Ledger, declarant_id: UUID | None) -> list[Dependent]:
    if declarant_id is None:
        return []
    out = []
    for member_id in records.dependents_of(ledger, declarant_id):
        info = records.member_info(ledger, member_id)
        member = ledger.members.get(member_id)
        if member is None or info is None:
            continue
        out.append(Dependent(member_id, member.name, info.cpf, info.birth_date, info.relation))
    return sorted(out, key=lambda d: d.name.casefold())
