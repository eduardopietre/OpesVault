"""Shared builders for domain tests."""

from dataclasses import dataclass
from datetime import date
from uuid import UUID

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountSubtype, AccountType, Card, LedgerAccount


@dataclass
class Family:
    ledger: Ledger
    ana: UUID
    bruno: UUID
    bank: UUID
    savings: UUID
    joint: UUID
    card_account: UUID
    card: UUID
    groceries: UUID
    salary: UUID


def category(ledger: Ledger, name: str, kind: AccountType = AccountType.EXPENSE) -> UUID:
    return next(a.id for a in ledger.categories(kind) if a.name == name)


def family() -> Family:
    ledger = Ledger.new("Família Teste")
    ana = ledger.add_member("Ana").id
    bruno = ledger.add_member("Bruno").id
    bank = ledger.add_account(
        LedgerAccount(name="Banco A", type=AccountType.ASSET, subtype=AccountSubtype.CHECKING, holders=(ana,))
    ).id
    savings = ledger.add_account(
        LedgerAccount(name="Poupança", type=AccountType.ASSET, subtype=AccountSubtype.SAVINGS, holders=(ana,))
    ).id
    joint = ledger.add_account(
        LedgerAccount(name="Conjunta", type=AccountType.ASSET, subtype=AccountSubtype.CHECKING, holders=(ana, bruno))
    ).id
    card_account = ledger.add_account(
        LedgerAccount(name="Cartão X", type=AccountType.LIABILITY, subtype=AccountSubtype.CREDIT_CARD)
    ).id
    card = ledger.add_card(
        Card(
            name="Cartão X",
            liability_account_id=card_account,
            holder_id=ana,
            last4="1234",
            closing_day=3,
            due_day=10,
            settlement_account_id=bank,
        )
    ).id
    return Family(
        ledger=ledger,
        ana=ana,
        bruno=bruno,
        bank=bank,
        savings=savings,
        joint=joint,
        card_account=card_account,
        card=card,
        groceries=category(ledger, "Alimentação"),
        salary=category(ledger, "Salário", AccountType.INCOME),
    )


D = date
