"""Properties of the ledger under random sequences of everyday actions (docs/04 §2, docs/03 §5).

Each seed builds a different sequence of incomes, expenses, transfers, card purchases and
payments, corrections, cancellations and reversals, some of them invalid on purpose. Whatever
the sequence, these hold:

- every operation balances, and so do all accounts together (double entry);
- a rejected action changes nothing;
- undoing every step gives back exactly the starting ledger, and redoing gives the end;
- writing the ledger as records and reading it back gives the same records;
- an incremental save carries every change: the last saved records plus the dirty ones
  are exactly the full records.
"""

import random
from collections.abc import Callable
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

from opesvault.domain import queries, tags
from opesvault.domain.cards import record_installment_purchase
from opesvault.domain.edits import reclassify
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountType
from opesvault.domain.money import ZERO
from opesvault.session import Session

from .domain_fixtures import Family, category, family

SEEDS = range(20)
ACTIONS = 40
START = date(2026, 1, 1)

Records = dict[tuple[str, UUID], dict[str, Any]]


def _records(ledger: Ledger) -> Records:
    return {(kind, key): payload for key, kind, payload in ledger.to_records()}


def _rng(seed: int) -> random.Random:
    """Reproducible on purpose: a failing seed fails again the same way."""
    return random.Random(seed)  # noqa: S311 - test data, not secrets


def _amount(rng: random.Random) -> str:
    cents = rng.choice([1, 5, 99, 100, 1234, 50_000, 999_999, rng.randint(1, 2_000_000)])
    return f"{Decimal(cents) / 100:.2f}"


class Walker:
    """Chooses one action at a time from what the ledger already holds."""

    def __init__(self, f: Family, rng: random.Random) -> None:
        self.f, self.rng = f, rng
        ledger = f.ledger
        self.expenses = [a.id for a in ledger.categories(AccountType.EXPENSE)]
        self.incomes = [a.id for a in ledger.categories(AccountType.INCOME)]
        self.cash = [f.bank, f.savings, f.joint]

    def day(self) -> date:
        return START + timedelta(days=self.rng.randint(0, 200))

    def action(self) -> tuple[str, Callable[[], object]]:
        f, rng, ledger = self.f, self.rng, self.f.ledger
        ops = [op for op in ledger.active_operations() if op.kind.value != "opening_balance"]
        choices: list[tuple[str, Callable[[], object]]] = [
            (
                "receita",
                lambda: ledger.record_income(
                    rng.choice(self.cash), rng.choice(self.incomes), _amount(rng), self.day(), "Receita"
                ),
            ),
            (
                "despesa",
                lambda: ledger.record_expense(
                    rng.choice(self.cash), rng.choice(self.expenses), _amount(rng), self.day(), "Despesa"
                ),
            ),
            (
                "transferência",
                lambda: ledger.record_transfer(
                    rng.choice(self.cash), rng.choice(self.cash), _amount(rng), self.day(), "Transferência"
                ),
            ),
            (
                "compra no cartão",
                lambda: ledger.record_card_purchase(
                    f.card, rng.choice(self.expenses), _amount(rng), self.day(), "Compra"
                ),
            ),
            ("valor inválido", lambda: ledger.record_expense(f.bank, f.groceries, "-1.00", self.day(), "Inválida")),
            ("pagamento de fatura", lambda: ledger.record_card_payment(f.card, f.bank, _amount(rng), self.day())),
            (
                "compra parcelada",
                lambda: record_installment_purchase(
                    ledger, f.card, rng.choice(self.expenses), _amount(rng), self.day(), "Parcelada", rng.randint(2, 6)
                ),
            ),
        ]
        if ops:
            op = rng.choice(ops)
            choices += [
                ("cancelamento", lambda: ledger.cancel_operation(op.id, "teste")),
                ("estorno", lambda: ledger.reverse_operation(op.id, self.day(), "teste")),
                (
                    "correção",
                    lambda: ledger.update_operation(op.model_copy(update={"description": "Corrigida"}), "teste"),
                ),
                ("reclassificação", lambda: reclassify(ledger, [op.id], rng.choice(self.expenses), "teste")),
                ("marcador", lambda: tags.add_tag(ledger, [op.id], rng.choice(["Viagem", "Casa", "Obra"]))),
                ("tirar marcador", lambda: tags.remove_tag(ledger, [op.id], "Viagem")),
            ]
        return rng.choice(choices)


def _run(session: Session, rng: random.Random, actions: int) -> int:
    """Applies `actions` random actions, one undo step each; returns how many were accepted."""
    walker = Walker(_family_of(session), rng)
    stack = session.undo_stack()
    accepted = 0
    for _ in range(actions):
        _name, act = walker.action()
        before = _records(session.ledger)
        try:
            act()
        except DomainError:
            assert _records(session.ledger) == before, "a rejected action left a change behind"
            stack.journal.clear()
            continue
        stack.seal()
        accepted += 1
    return accepted


_FAMILIES: dict[int, Family] = {}


def _family_of(session: Session) -> Family:
    return _FAMILIES[id(session.ledger)]


def _session(tmp_path: Path) -> Session:
    f = family()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = f.ledger
    _FAMILIES[id(f.ledger)] = f
    f.ledger.record_opening_balance(f.bank, "5000.00", START)
    f.ledger.record_opening_balance(f.savings, "300.00", START)
    session.undo_stack().seal()
    session.undo_stack().undo_steps.clear()  # the starting point, not something to undo
    return session


def _assert_balanced(ledger: Ledger) -> None:
    for op in ledger.operations.values():
        assert sum((p.amount for p in op.postings), ZERO) == ZERO, op.description
    index = queries.index(ledger)  # raw balances: debits positive, whatever the account type
    assert sum((index.raw_balance(account, None) for account in index.accounts()), ZERO) == ZERO


@pytest.mark.parametrize("seed", SEEDS)
def test_random_days_keep_the_books_balanced_and_undoable(seed: int, tmp_path: Path) -> None:
    session = _session(tmp_path)
    ledger = session.ledger
    start = _records(ledger)
    accepted = _run(session, _rng(seed), ACTIONS)
    assert accepted > ACTIONS // 3, "the walk must mostly do things, not only fail"
    _assert_balanced(ledger)
    end = _records(ledger)

    stack = session.undo_stack()
    while stack.undo() is not None:
        pass
    assert _records(ledger) == start
    while stack.redo() is not None:
        pass
    assert _records(ledger) == end
    _assert_balanced(ledger)


@pytest.mark.parametrize("seed", SEEDS)
def test_records_read_back_as_the_same_ledger(seed: int, tmp_path: Path) -> None:
    session = _session(tmp_path)
    _run(session, _rng(seed), ACTIONS)
    rows = session.ledger.to_records()
    again = Ledger.from_records(rows)
    assert _records(again) == _records(session.ledger)
    assert queries.balances(again) == queries.balances(session.ledger)


@pytest.mark.parametrize("seed", SEEDS)
def test_an_incremental_save_carries_every_change(seed: int, tmp_path: Path) -> None:
    session = _session(tmp_path)
    ledger = session.ledger
    rng = _rng(seed)
    _run(session, rng, ACTIONS // 2)
    saved = _records(ledger)  # what the vault holds after a save
    ledger.mark_clean(ledger.change_count)
    _run(session, rng, ACTIONS // 2)
    if rng.random() < 0.5:  # undoing part of the unsaved work is a change too
        session.undo_stack().undo()
    rebuilt = dict(saved)
    for kind, key in ledger.dirty:
        payload = ledger.record_for(kind, key)
        if payload is None:
            rebuilt.pop((kind, key), None)
        else:
            rebuilt[(kind, key)] = payload
    assert rebuilt == _records(ledger)


def test_an_expense_moves_exactly_its_amount(tmp_path: Path) -> None:
    session = _session(tmp_path)
    f = _family_of(session)
    rng = _rng(7)
    for _ in range(50):
        amount = _amount(rng)
        before = queries.balance(f.ledger, f.bank)
        spent = queries.balance(f.ledger, category(f.ledger, "Lazer"))
        f.ledger.record_expense(f.bank, category(f.ledger, "Lazer"), amount, START, "Cinema")
        assert queries.balance(f.ledger, f.bank) == before - Decimal(amount)
        assert queries.balance(f.ledger, category(f.ledger, "Lazer")) == spent + Decimal(amount)
