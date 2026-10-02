"""Complete offline journey (docs/00 §7, docs/09 phase 6, TA-01, TA-07, TA-30)."""

import socket
from collections.abc import Iterator
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from opesvault.domain import queries
from opesvault.domain.cards import bills, record_installment_purchase
from opesvault.domain.model import AccountSubtype, AccountType, Card, LedgerAccount, YearMonth
from opesvault.domain.periods import close_month, is_closed
from opesvault.domain.recurrence import RecurrenceRule, add_rule, auto_suggestions, realize
from opesvault.importing import pipeline
from opesvault.importing.pipeline import ImportRequest
from opesvault.investments import service as inv
from opesvault.investments.model import AssetClass, ValueNature
from opesvault.investments.performance import period_result
from opesvault.session import Session
from opesvault.vault.backup import copy_for_restore, create_backup
from opesvault.vault.client import VaultClient

from . import synthetic_docs as docs
from .conftest import PASSWORD, dev_worker_command

D = Decimal


@pytest.fixture
def offline(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    """Any connection outside loopback fails the test (TA-30)."""
    attempts: list[str] = []
    original = socket.socket.connect

    def guarded(self: socket.socket, address: object) -> None:
        host = address[0] if isinstance(address, tuple) else str(address)
        if host not in ("127.0.0.1", "::1", "localhost") and not str(host).startswith("/"):
            attempts.append(str(host))
            raise OSError("rede externa bloqueada no teste")
        return original(self, address)  # type: ignore[arg-type]

    monkeypatch.setattr(socket.socket, "connect", guarded)
    yield attempts
    assert attempts == []


def test_family_journey(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, offline: list[str]) -> None:
    monkeypatch.setenv("OPV_DEV_PASSWORD", PASSWORD)
    client = VaultClient(dev_worker_command())
    path = tmp_path / "silva.opesvault"

    # 1. First use: family, accounts, opening balances.
    session = Session.new(path, "Família Silva")
    ledger = session.ledger
    ana = ledger.add_member("Ana").id
    bank = ledger.add_account(
        LedgerAccount(
            name="Itaú CC",
            type=AccountType.ASSET,
            subtype=AccountSubtype.CHECKING,
            masked_number="56789-0",
            holders=(ana,),
        )
    ).id
    ledger.record_opening_balance(bank, "1000.00", date(2026, 1, 1))
    card_liability = ledger.add_account(
        LedgerAccount(name="Nubank", type=AccountType.LIABILITY, subtype=AccountSubtype.CREDIT_CARD)
    ).id
    card = ledger.add_card(
        Card(
            name="Nubank",
            liability_account_id=card_liability,
            holder_id=ana,
            last4="0001",
            closing_day=3,
            due_day=10,
            settlement_account_id=bank,
        )
    ).id
    salary = next(a.id for a in ledger.categories(AccountType.INCOME) if a.name == "Salário")
    rule = add_rule(
        ledger,
        RecurrenceRule(
            description="Salário",
            account_id=bank,
            counterpart_id=salary,
            amount=D("5000"),
            tolerance=D("1"),
            day=5,
            start=date(2026, 1, 1),
        ),
    )
    first = session.freeze()
    created = client.save_frozen(first)
    session.mark_saved(first, created)

    # 2. Monthly review: import the bank statement and the card bill, approve.
    statement = pipeline.import_document(session, ImportRequest("extrato.pdf", docs.itau_bank_pdf(), account_id=bank))
    payment = next(i for i in pipeline.items_of(ledger, statement.id) if "FATURA" in i.description)
    pipeline.correct_item(ledger, payment.id, "target_account_id", card_liability, "é a fatura do cartão")
    salary_item = next(i for i in pipeline.items_of(ledger, statement.id) if "SALARIO" in i.description)
    pipeline.correct_item(ledger, salary_item.id, "target_account_id", salary)
    pipeline.approve(ledger, statement.id)
    bill = pipeline.import_document(session, ImportRequest("fatura.pdf", docs.nubank_card_pdf()))
    pipeline.approve(ledger, bill.id)
    [(forecast, op)] = auto_suggestions(ledger, date(2026, 1, 1), date(2026, 1, 31))
    realize(ledger, rule.id, forecast.due_on, op.id)
    record_installment_purchase(
        ledger, card, next(a.id for a in ledger.categories(AccountType.EXPENSE)), "300.00", date(2026, 1, 20), "TV", 3
    )
    assert len(bills(ledger, card, [YearMonth(year=2026, month=2)])) == 1

    # 3. Investments with successive valuations.
    pos = inv.create_position(
        ledger, "CDB", AssetClass.FIXED_INCOME, date(2026, 1, 2), initial_cost="1000", from_account=bank
    )
    inv.add_valuation(ledger, pos.id, date(2026, 1, 31), "1010", ValueNature.GROSS)
    assert period_result(ledger, pos.id, date(2026, 1, 2), date(2026, 1, 31)).value == D("10")

    close_month(ledger, YearMonth(year=2025, month=12))
    frozen = session.freeze()
    assert frozen.delta is not None  # second save is incremental
    saved = client.save_frozen(frozen)
    session.mark_saved(frozen, saved)
    assert not session.dirty

    # 4. Backup, restore on "another machine" (another folder), reopen with the password.
    backup = create_backup(path, saved.revision, tmp_path / "pendrive")
    other_machine = tmp_path / "outro-computador"
    other_machine.mkdir()
    restored_path = copy_for_restore(backup, other_machine / "silva.opesvault")
    revision, snapshot = client.open(restored_path)
    restored = Session.from_snapshot(restored_path, revision, snapshot)
    assert revision.revision == saved.revision
    assert restored.ledger.operations == ledger.operations
    assert [d.data for d in restored.documents] == [d.data for d in session.documents]
    assert queries.balance(restored.ledger, bank) == queries.balance(ledger, bank)
    assert is_closed(restored.ledger, YearMonth(year=2025, month=12))
    assert len(restored.ledger.history) == len(ledger.history)
    # No financial value relies on re-running a model: AI was never enabled.
    assert all(not (i.suggestion_source or "").startswith("ollama") for i in pipeline.items(restored.ledger).values())
