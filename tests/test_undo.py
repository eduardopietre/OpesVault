from datetime import date
from decimal import Decimal
from pathlib import Path

from opesvault.domain import budget, queries
from opesvault.domain.model import YearMonth
from opesvault.importing import pipeline
from opesvault.importing.pipeline import ImportRequest
from opesvault.session import Session
from opesvault.undo import UndoStack

from . import synthetic_docs as docs
from .domain_fixtures import category, family


def setup(tmp_path: Path) -> tuple[Session, UndoStack]:
    f = family()
    session = Session.new(tmp_path / "x.opesvault")
    session.ledger = f.ledger
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    stack = UndoStack(session)
    return session, stack


def bank(session: Session):  # type: ignore[no-untyped-def]
    return next(a.id for a in session.ledger.accounts.values() if a.name == "Banco A")


def test_undo_redo_of_an_expense_restores_balances_and_history(tmp_path: Path) -> None:
    session, stack = setup(tmp_path)
    ledger = session.ledger
    history_before = len(ledger.history)
    op = ledger.record_expense(bank(session), category(ledger, "Lazer"), "200.00", date(2026, 1, 5), "Show")
    step = stack.seal()
    assert step is not None and step.label == "lançamento"
    assert queries.balance(ledger, bank(session)) == Decimal("800.00")
    stack.undo()
    assert op.id not in ledger.operations and len(ledger.history) == history_before
    assert queries.balance(ledger, bank(session)) == Decimal("1000.00")  # query cache invalidated
    stack.redo()
    assert ledger.operations[op.id] == op and queries.balance(ledger, bank(session)) == Decimal("800.00")


def test_undo_a_correction_brings_back_the_previous_version(tmp_path: Path) -> None:
    session, stack = setup(tmp_path)
    ledger = session.ledger
    op = ledger.record_expense(bank(session), category(ledger, "Lazer"), "50.00", date(2026, 1, 5), "Cinema")
    stack.seal()
    ledger.update_operation(op.model_copy(update={"description": "Teatro"}), "nome errado")
    stack.seal()
    stack.undo()
    assert ledger.operations[op.id].description == "Cinema" and ledger.operations[op.id].version == 1
    assert [h.reason for h in ledger.history_of(op.id)] == [None]


def test_undo_an_import_removes_document_batch_and_items(tmp_path: Path) -> None:
    session, stack = setup(tmp_path)
    stack.seal()
    batch = pipeline.import_document(session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    assert stack.seal() is not None
    assert len(session.documents) == 1
    stack.undo()
    assert session.documents == [] and batch.id not in pipeline.batches(session.ledger)
    assert not pipeline.items(session.ledger)
    frozen = session.freeze()
    assert frozen.snapshot is not None or (frozen.delta is not None and not frozen.delta.documents_added)
    stack.redo()
    assert len(session.documents) == 1 and batch.id in pipeline.batches(session.ledger)


def test_new_action_clears_redo_and_save_clears_everything(tmp_path: Path) -> None:
    session, stack = setup(tmp_path)
    ledger = session.ledger
    budget.set_budget(ledger, category(ledger, "Lazer"), YearMonth(year=2026, month=1), "100.00")
    stack.seal()
    stack.undo()
    assert stack.can_redo() and stack.redo_label() == "orçamento"
    ledger.add_member("Carla")
    stack.seal()
    assert not stack.can_redo()
    stack.clear()
    assert not stack.can_undo() and not stack.can_redo()


def test_undone_changes_are_saved_as_deletions(tmp_path: Path) -> None:
    from datetime import UTC, datetime
    from uuid import uuid4

    from opesvault.vault.model import RevisionInfo

    session, stack = setup(tmp_path)
    frozen = session.freeze()
    session.mark_saved(
        frozen,
        RevisionInfo(
            vault_id=session.vault_id, format_version=1, revision=1, revision_id=uuid4(), saved_at=datetime.now(UTC)
        ),
    )
    stack.clear()
    op = session.ledger.record_expense(bank(session), category(session.ledger, "Lazer"), "9.00", date(2026, 1, 9), "X")
    stack.seal()
    stack.undo()
    delta = session.freeze().delta
    assert delta is not None
    assert op.id in delta.deletes and all(r.id != op.id for r in delta.upserts)
