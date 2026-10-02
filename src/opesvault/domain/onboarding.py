"""First-use setup: members, accounts with opening balances and cards, applied in one go.

The wizard only collects a `SetupPlan`; everything is validated here first, so a bad
entry never leaves a half-configured vault.
"""

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, Card, LedgerAccount

ASSET_SUBTYPES = frozenset(
    {
        AccountSubtype.CHECKING,
        AccountSubtype.SAVINGS,
        AccountSubtype.CASH,
        AccountSubtype.BROKERAGE_CASH,
        AccountSubtype.INVESTMENT,
        AccountSubtype.OTHER_ASSET,
    }
)
LIABILITY_SUBTYPES = frozenset({AccountSubtype.LOAN, AccountSubtype.OTHER_LIABILITY, AccountSubtype.TAX_PAYABLE})


@dataclass(frozen=True)
class AccountPlan:
    name: str
    subtype: AccountSubtype
    holders: tuple[str, ...] = ()  # member names
    institution: str | None = None
    opening_balance: Decimal | None = None  # None = not informed (not zero)
    opening_date: date | None = None


@dataclass(frozen=True)
class CardPlan:
    name: str
    holder: str
    last4: str
    closing_day: int
    due_day: int
    settlement_account: str | None = None  # account name from the plan or the ledger
    institution: str | None = None


@dataclass(frozen=True)
class SetupPlan:
    members: tuple[str, ...] = ()
    accounts: tuple[AccountPlan, ...] = ()
    cards: tuple[CardPlan, ...] = field(default=())


@dataclass(frozen=True)
class SetupResult:
    members: int
    accounts: int
    cards: int
    opening_balances: int


def check_plan(ledger: Ledger, plan: SetupPlan) -> None:
    """Raises DomainError with a user-facing message for the first problem found."""
    existing_members = {m.name.casefold() for m in ledger.members.values()}
    names = [m.strip() for m in plan.members]
    if any(not n for n in names):
        raise DomainError("Há um integrante sem nome.")
    folded = [n.casefold() for n in names]
    if len(set(folded)) != len(folded) or existing_members & set(folded):
        raise DomainError("Há integrantes com o mesmo nome.")
    members = existing_members | set(folded)
    account_names = {a.name.casefold() for a in ledger.accounts.values()}
    for account in plan.accounts:
        if not account.name.strip():
            raise DomainError("Há uma conta sem nome.")
        if account.name.strip().casefold() in account_names:
            raise DomainError(f"Conta repetida: {account.name.strip()}.")
        account_names.add(account.name.strip().casefold())
        if account.subtype not in ASSET_SUBTYPES | LIABILITY_SUBTYPES:
            raise DomainError("Tipo de conta inválido.")
        if any(h.casefold() not in members for h in account.holders):
            raise DomainError(f"Titular desconhecido na conta {account.name.strip()}.")
        if account.opening_balance is not None and account.opening_date is None:
            raise DomainError(f"Informe a data do saldo de abertura de {account.name.strip()}.")
    for card in plan.cards:
        if not card.name.strip():
            raise DomainError("Há um cartão sem nome.")
        if card.name.strip().casefold() in account_names:
            raise DomainError(f"Nome repetido: {card.name.strip()}.")
        account_names.add(card.name.strip().casefold())
        if card.holder.casefold() not in members:
            raise DomainError(f"Escolha o portador do cartão {card.name.strip()}.")
        if len(card.last4) != 4 or not card.last4.isdigit():
            raise DomainError(f"Informe os 4 últimos dígitos do cartão {card.name.strip()}.")
        if not (1 <= card.closing_day <= 31 and 1 <= card.due_day <= 31):
            raise DomainError("Dias de fechamento e vencimento vão de 1 a 31.")
        if card.settlement_account is not None and card.settlement_account.casefold() not in account_names:
            raise DomainError(f"Conta de pagamento desconhecida no cartão {card.name.strip()}.")


def apply_setup(ledger: Ledger, plan: SetupPlan) -> SetupResult:
    check_plan(ledger, plan)
    # Dry run on a copy: any rule the checks above miss fails there, not halfway here.
    _apply(Ledger.from_records(ledger.to_records()), plan)
    return _apply(ledger, plan)


def _apply(ledger: Ledger, plan: SetupPlan) -> SetupResult:
    member_ids = {m.name.casefold(): m.id for m in ledger.members.values()}
    for name in plan.members:
        member = ledger.add_member(name.strip())
        member_ids[member.name.casefold()] = member.id
    account_ids = {a.name.casefold(): a.id for a in ledger.accounts.values()}
    balances = 0
    for plan_account in plan.accounts:
        kind = AccountType.ASSET if plan_account.subtype in ASSET_SUBTYPES else AccountType.LIABILITY
        account = ledger.add_account(
            LedgerAccount(
                name=plan_account.name.strip(),
                type=kind,
                subtype=plan_account.subtype,
                institution=(plan_account.institution or "").strip() or None,
                holders=tuple(member_ids[h.casefold()] for h in plan_account.holders),
            )
        )
        account_ids[account.name.casefold()] = account.id
        if plan_account.opening_balance is not None and plan_account.opening_balance != 0:
            assert plan_account.opening_date is not None
            ledger.record_opening_balance(account.id, plan_account.opening_balance, plan_account.opening_date)
            balances += 1
    for plan_card in plan.cards:
        holder = member_ids[plan_card.holder.casefold()]
        liability = ledger.add_account(
            LedgerAccount(
                name=plan_card.name.strip(),
                type=AccountType.LIABILITY,
                subtype=AccountSubtype.CREDIT_CARD,
                institution=(plan_card.institution or "").strip() or None,
                masked_number=f"final {plan_card.last4}",
                holders=(holder,),
            )
        )
        settlement = account_ids[plan_card.settlement_account.casefold()] if plan_card.settlement_account else None
        ledger.add_card(
            Card(
                name=plan_card.name.strip(),
                liability_account_id=liability.id,
                holder_id=holder,
                last4=plan_card.last4,
                closing_day=plan_card.closing_day,
                due_day=plan_card.due_day,
                settlement_account_id=settlement,
            )
        )
    return SetupResult(len(plan.members), len(plan.accounts), len(plan.cards), balances)
