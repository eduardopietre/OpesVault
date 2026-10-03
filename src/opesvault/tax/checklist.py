"""Documents of the year: which informes and receipts the return needs and which are still missing.

Built from what was recorded (accounts with movement, payers, deductible payments, loans and
goods bought or sold). A document counts as received when the app can see it (an informe
saved, every payment with its receipt attached) or when the user marks it by hand.
"""

from dataclasses import dataclass
from datetime import date
from uuid import UUID

from opesvault.domain import queries
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountSubtype, AccountType
from opesvault.domain.money import ZERO
from opesvault.tax import declaration, records
from opesvault.tax.model import ReportSource


@dataclass(frozen=True)
class Expected:
    key: str
    title: str
    detail: str
    received: bool
    by_hand: bool  # the user's mark decides, not what the app sees
    action: str  # "report", "receipts", "mark"
    ref: object = None


def _active_accounts(ledger: Ledger, year: int, people: set[UUID] | None) -> list[UUID]:
    start, end, before = date(year, 1, 1), date(year, 12, 31), date(year - 1, 12, 31)
    now, then = queries.balances(ledger, end), queries.balances(ledger, before)
    moved: set[UUID] = set()
    for op in ledger.active_operations():
        when = op.cash_date
        if when is not None and start <= when <= end:
            moved.update(p.account_id for p in op.postings)
    out = []
    for account in sorted(ledger.accounts.values(), key=lambda a: a.name.casefold()):
        if account.subtype in (AccountSubtype.CASH, AccountSubtype.INVESTMENT, AccountSubtype.CATEGORY):
            continue
        if account.subtype in (AccountSubtype.CREDIT_CARD, AccountSubtype.TAX_PAYABLE, AccountSubtype.OPENING_EQUITY):
            continue
        if account.type not in (AccountType.ASSET, AccountType.LIABILITY):
            continue
        if not (now.get(account.id, ZERO) or then.get(account.id, ZERO) or account.id in moved):
            continue
        if people is not None and not set(account.holders) & people:
            continue
        out.append(account.id)
    return out


def expected(ledger: Ledger, year: int, people: set[UUID] | None = None) -> list[Expected]:
    have = {(r.source, r.source_id) for r in records.reports_of(ledger, year)}
    out: list[Expected] = []

    def add(key: str, title: str, detail: str, seen: bool, action: str, ref: object = None) -> None:
        mark = records.mark_of(ledger, year, key)
        received = mark.received if mark is not None else seen
        out.append(Expected(key, title, detail, received, mark is not None, action, ref))

    for account_id in _active_accounts(ledger, year, people):
        account = ledger.account(account_id)
        who = account.institution or account.name
        if account.type is AccountType.LIABILITY:
            add(
                f"divida:{account_id}",
                f"Saldo devedor em 31/12 — {account.name}",
                "Declaração do credor com o saldo do financiamento no fim do ano.",
                (ReportSource.ACCOUNT, account_id) in have,
                "report",
                (ReportSource.ACCOUNT, account_id),
            )
            continue
        add(
            f"informe:conta:{account_id}",
            f"Informe de rendimentos — {who}",
            f"Saldos em 31/12 e rendimentos da conta {account.name}.",
            (ReportSource.ACCOUNT, account_id) in have,
            "report",
            (ReportSource.ACCOUNT, account_id),
        )
    found = declaration.income(ledger, year, people)
    for source_id in dict.fromkeys(r.source_id for r in found.taxable):
        payer = next(r.payer for r in found.taxable if r.source_id == source_id)
        add(
            f"informe:fonte:{source_id}",
            f"Comprovante de rendimentos — {payer}",
            "Rendimentos do trabalho, imposto retido, INSS e 13º salário.",
            (ReportSource.CATEGORY, source_id) in have,
            "report",
            (ReportSource.CATEGORY, source_id),
        )
    for row in declaration.payments(ledger, year, people):
        if row.paid <= 0:
            continue
        count = len(row.operations)
        attached = count - row.without_receipt
        add(
            f"recibos:{row.kind}:{row.payee_key}:{row.beneficiary_id}",
            f"Recibos e notas — {row.payee}",
            f"{attached} de {count} pagamento(s) com comprovante anexado.",
            row.without_receipt == 0,
            "receipts",
            tuple(row.operations),
        )
    for item in records.declared_assets(ledger).values():
        if people is not None and item.owner_id not in people:
            continue
        for when, what in ((item.acquired_on, "compra"), (item.sold_on, "venda")):
            if when is not None and when.year == year:
                add(
                    f"bem:{what}:{item.id}",
                    f"Documento de {what} — {item.name}",
                    "Escritura, contrato ou nota com o valor e a data.",
                    False,
                    "mark",
                )
    return out


def missing(items: list[Expected]) -> list[Expected]:
    return [i for i in items if not i.received]
