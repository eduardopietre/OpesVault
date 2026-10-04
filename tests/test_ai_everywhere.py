"""The local AI across the app: core tasks, the Livro, the new-entry form and Configurações.

Every test talks to the fake Ollama (tests/fake_ollama.py), never a real model. What is checked
is the contract of docs/05 §5: only descriptions and category names leave the app, answers
are validated in meaning (not just as JSON), nothing changes before the user reviews it, and
each change records the model and prompt version that suggested it.
"""

import json
import threading
from datetime import date
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import pytest
from PySide6.QtCore import Qt, QThreadPool
from PySide6.QtWidgets import QApplication

from opesvault.ai.ollama import AiUnavailable, OllamaClient, local_url, plausible_name
from opesvault.domain import merchants, queries
from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount
from opesvault.domain.settings import update_settings
from opesvault.importing import ai_merchants, ai_suggestions
from opesvault.session import Session
from opesvault.ui import preferences
from opesvault.ui.common import combo_value, select_combo
from opesvault.ui.main_window import MainWindow
from opesvault.ui.pages.ledger import LedgerPage

from .domain_fixtures import Family, category, family
from .fake_ollama import FakeOllama


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    return instance if isinstance(instance, QApplication) else QApplication([])


def _answer(**fields: Any) -> None:
    FakeOllama.answer = json.dumps(fields)


def _user_messages() -> list[str]:
    return [m["content"] for body in FakeOllama.received if "messages" in body for m in body["messages"][1:]]


# ── the client ──────────────────────────────────────


@pytest.mark.parametrize(
    ("description", "name", "kept"),
    [
        ("IFD*IFOOD.COM AGENCIA", "iFood", "iFood"),
        ("PAG*JOSEDASILVA", "José da Silva", "José da Silva"),  # spaces and accents restored
        ("DROGASIL 1234 SAO PAULO", "  Drogasil  ", "Drogasil"),
        ("PADARIA REAL", "Carrefour", None),  # a brand the description does not have
        ("PIX ENVIADO", "NENHUM", None),
        ("LOJA", "x" * 61, None),
        ("LOJA", "", None),
    ],
)
def test_a_name_must_come_from_the_description(description: str, name: str, kept: str | None) -> None:
    assert plausible_name(description, name) == kept


def test_merchant_names_are_validated_and_traced(ollama: str) -> None:
    _answer(
        names=[
            {"index": 0, "name": "iFood"},
            {"index": 1, "name": "Mercado Livre"},  # invented: nothing of it in "PADARIA REAL"
            {"index": 9, "name": "Uber"},  # no such line
        ]
    )
    client = OllamaClient("gemma4:12b", ollama)
    client.check_model()
    run = client.suggest_names(["IFD*IFOOD.COM AGENCIA", "PADARIA REAL"])
    assert [(s.index, s.name) for s in run.suggestions] == [(0, "iFood")]
    assert run.suggestions[0].source == "ollama:gemma4:12b:m1@0123456789ab"
    sent = FakeOllama.received[-1]
    assert sent["format"]["required"] == ["names"] and "tools" not in sent and sent["think"] is False


def test_the_port_may_change_but_the_host_never(ollama: str) -> None:
    port = urlparse(ollama).port or 0
    assert local_url(port) == f"http://127.0.0.1:{port}"
    assert OllamaClient("gemma4:12b", local_url(port)).server_info().models
    for wrong in (0, 70000):
        with pytest.raises(AiUnavailable):
            local_url(wrong)


@pytest.mark.parametrize(("share", "percent"), [(100, 100), (40, 40), (0, 0)])
def test_where_the_model_runs_is_read_from_ollama(ollama: str, share: int, percent: int) -> None:
    from opesvault.ui.pages.settings_page import placement_text

    FakeOllama.gpu_share = share
    placed = OllamaClient("gemma4:12b", ollama).placement()
    assert placed is not None and placed.gpu_percent == percent
    words = placement_text(placed)
    assert ("inteiro na GPU" in words) == (percent == 100) and ("CPU" in words) == (percent < 100)
    assert OllamaClient("outro", ollama).placement() is None  # not loaded: nothing is said


def test_models_are_unloaded_where_they_were_used(ollama: str) -> None:
    client = OllamaClient("gemma4:12b", ollama)
    ai_suggestions.remember_used(client)
    ai_suggestions.release_models(wait=True)
    assert {"model": "gemma4:12b", "keep_alive": 0} in FakeOllama.received


# ── what is planned from the ledger ─────────────────


def _bank_family() -> Family:
    f = family()
    f.ledger.record_opening_balance(f.bank, "5000.00", date(2026, 1, 1))
    return f


def test_categories_go_with_their_parent_so_alike_names_stay_apart() -> None:
    f = _bank_family()
    ledger = f.ledger
    for parent in ("Alimentação", "Lazer"):
        ledger.add_account(
            LedgerAccount(
                name="Outros",
                type=AccountType.EXPENSE,
                subtype=AccountSubtype.CATEGORY,
                parent_id=category(ledger, parent),
            )
        )
    names = ai_suggestions.category_names(ledger, AccountType.EXPENSE)
    assert {"Alimentação › Outros", "Lazer › Outros"} <= set(names)
    assert len(set(names.values())) == len(names)


def test_examples_follow_what_the_ledger_says_now() -> None:
    """A manual entry teaches, and a reclassification changes what it teaches."""
    from opesvault.domain.edits import reclassify

    f = _bank_family()
    ledger = f.ledger
    leisure = category(ledger, "Lazer")
    op = ledger.record_expense(f.bank, f.groceries, "30.00", date(2026, 2, 1), "CINEMARK SHOPPING")
    plan = ai_suggestions.plan_description(ledger, "CINEMA DO CENTRO", AccountType.EXPENSE)
    assert plan is not None and plan.examples == (("CINEMARK SHOPPING", "Alimentação"),)
    reclassify(ledger, [op.id], leisure, "era cinema")
    plan = ai_suggestions.plan_description(ledger, "CINEMA DO CENTRO", AccountType.EXPENSE)
    assert plan is not None and plan.examples == (("CINEMARK SHOPPING", "Lazer"),)
    assert ai_suggestions.plan_description(ledger, "  ", AccountType.EXPENSE) is None


def test_ledger_operations_are_asked_once_per_description_and_never_answer_themselves() -> None:
    f = _bank_family()
    ledger = f.ledger
    first = ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 2, 1), "UBER *TRIP 1111")
    second = ledger.record_expense(f.bank, f.groceries, "12.00", date(2026, 2, 2), "UBER *TRIP 2222")
    pay = ledger.record_income(f.bank, f.salary, "4000.00", date(2026, 2, 5), "SALARIO EMPRESA")
    move = ledger.record_transfer(f.bank, f.savings, "100.00", date(2026, 2, 6), "APLICACAO")
    spending, income = ai_suggestions.plan_operations(ledger, [first.id, second.id, pay.id, move.id])
    assert spending.descriptions == ("UBER *TRIP 1111",) and spending.item_ids == ((first.id, second.id),)
    assert spending.examples == ()  # the operations being asked are not their own example
    assert income.descriptions == ("SALARIO EMPRESA",) and "Salário" in income.categories


def test_merchant_names_are_planned_per_store_and_approved_with_their_origin(ollama: str) -> None:
    f = _bank_family()
    ledger = f.ledger
    ops = [
        ledger.record_expense(f.bank, f.groceries, "50.00", date(2026, 2, d), "IFD*IFOOD.COM AGENCIA")
        for d in (1, 2, 3)
    ]
    named = ledger.record_expense(f.bank, f.groceries, "9.00", date(2026, 2, 4), "PADARIA REAL 12")
    merchants.name_merchant(ledger, named.description, "Padaria Real")
    move = ledger.record_transfer(f.bank, f.savings, "100.00", date(2026, 2, 6), "APLICACAO")
    request = ai_merchants.plan_names(ledger, [*(op.id for op in ops), named.id, move.id])
    assert request.descriptions == ("IFD*IFOOD.COM AGENCIA",) and request.counts == (3,)
    assert ai_merchants.plan_names(ledger, [named.id], renamed=True).current == ("Padaria Real",)

    _answer(names=[{"index": 0, "name": "iFood"}])
    client = OllamaClient("gemma4:12b", ollama)
    client.check_model()
    outcome = ai_merchants.ask_names(client, request)
    [proposal] = outcome.proposals
    assert (proposal.current, proposal.name, proposal.count) == ("Ifood", "iFood", 3)
    assert ai_merchants.apply_names(ledger, [(proposal, "iFood")]) == (1, [])
    assert merchants.merchant_of(ledger, "IFD*IFOOD.COM AGENCIA 99") == "iFood"
    [alias] = [a for a in merchants.aliases(ledger).values() if a.name == "iFood"]
    assert (ledger.history_of(alias.id)[-1].reason or "").startswith("sugestão ollama:gemma4:12b:m1")
    # The same name today is no proposal.
    _answer(names=[{"index": 0, "name": "Padaria Real"}])
    again = ai_merchants.ask_names(client, ai_merchants.plan_names(ledger, [named.id], renamed=True))
    assert again.proposals == []


# ── on screen ───────────────────────────────────────


@pytest.fixture
def ledger_page(app: QApplication, tmp_path: Path, ollama: str) -> tuple[MainWindow, Family, LedgerPage]:
    window = MainWindow()
    f = _bank_family()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = f.ledger
    update_settings(f.ledger, ai_enabled=True, ai_model="gemma4:12b")
    preferences.set_ollama_port(urlparse(ollama).port or 0)
    window.session = session
    window._refresh()
    session.undo_stack().seal()
    session.undo_stack().undo_steps.clear()
    page = next(p for p in window.pages if isinstance(p, LedgerPage))
    window.show_page(window.pages.index(page))
    return window, f, page


def _wait(page: Any) -> None:
    for _ in range(50):
        QThreadPool.globalInstance().waitForDone(10_000)
        QApplication.processEvents()
        if not page.ai_row.running:
            return
    raise AssertionError("the local AI did not answer")


def _review(monkeypatch: pytest.MonkeyPatch, act: Any) -> list[Any]:
    """Patches the review: `act(dialog)` unchecks or edits lines, then Aplicar runs its validation."""
    from opesvault.ui.local_ai import AiReviewDialog

    opened: list[Any] = []

    def run(dialog: Any) -> int:
        opened.append(dialog)
        act(dialog)
        dialog._try_accept()
        return dialog.result()

    monkeypatch.setattr(AiReviewDialog, "exec", run)
    return opened


def _row(dialog: Any, description: str) -> int:
    return next(r for r in range(dialog.table.rowCount()) if dialog.table.item(r, 0).text().startswith(description))


def test_the_livro_reclassifies_only_what_the_user_kept(
    ledger_page: tuple[MainWindow, Family, LedgerPage], monkeypatch: pytest.MonkeyPatch
) -> None:
    window, f, page = ledger_page
    ledger = f.ledger
    uber = [ledger.record_expense(f.bank, f.groceries, "20.00", date(2026, 2, d), f"UBER *TRIP {d}") for d in (1, 2)]
    cinema = ledger.record_expense(f.bank, f.groceries, "40.00", date(2026, 2, 3), "CINEMARK")
    page.refresh()
    _answer(suggestions=[{"index": 0, "category": "Transporte"}, {"index": 1, "category": "Transporte"}])
    opened = _review(monkeypatch, lambda d: d.set_checked(_row(d, "CINEMARK"), False))
    assert not page.ai_button.isHidden()  # with the AI on, the Livro offers it, selection or not
    page.suggest_categories_ai()
    assert page.ai_row.running and page.isEnabled()  # the Livro stays usable while the model answers
    _wait(page)
    [dialog] = opened
    assert dialog.table.rowCount() == 2 and dialog.table.item(_row(dialog, "UBER *TRIP"), 1).text() == "2"
    transport = category(ledger, "Transporte")
    assert queries.balance(ledger, transport) == 40 and queries.balance(ledger, f.groceries) == 40
    assert ledger.operations[cinema.id].postings == cinema.postings  # unchecked: untouched
    reason = ledger.history_of(uber[0].id)[-1].reason or ""
    assert "IA local" in reason and "ollama:gemma4:12b:p4" in reason
    assert window.session is not None and len(window.session.undo_stack().undo_steps) == 1
    sent = json.dumps(FakeOllama.received)
    assert "20.00" not in sent and "Banco A" not in sent  # descriptions and categories only


def test_names_are_edited_before_they_are_approved(
    ledger_page: tuple[MainWindow, Family, LedgerPage], monkeypatch: pytest.MonkeyPatch
) -> None:
    window, f, page = ledger_page
    for d in (1, 2):
        f.ledger.record_expense(f.bank, f.groceries, "50.00", date(2026, 2, d), "IFD*IFOOD.COM AGENCIA")
    page.refresh()
    page.table.selectAll()
    _answer(names=[{"index": 0, "name": "Ifood Agencia"}])

    def edit(dialog: Any) -> None:
        dialog.set_value(0, "  iFood  ")

    opened = _review(monkeypatch, edit)
    page.suggest_names_ai()
    _wait(page)
    assert opened and merchants.merchant_of(f.ledger, "IFD*IFOOD.COM AGENCIA") == "iFood"
    assert "1 nome aprovado" in window.statusBar().currentMessage()


def test_a_review_needs_a_line_and_a_name(app: QApplication) -> None:
    from opesvault.ui.local_ai import AiReviewDialog

    dialog = AiReviewDialog(None, "Teste", "", ["Descrição", "Nome"], [["A", "a"], ["B", "b"]], editable=1)
    assert dialog.count.text() == "2 de 2 marcada(s)"
    dialog.set_value(1, "   ")
    dialog._try_accept()
    assert dialog.result() != 1 and "vazio" in dialog.error.text()
    dialog._mark(False)
    dialog._try_accept()
    assert "Marque ao menos" in dialog.error.text() and dialog.count.text() == "0 de 2 marcada(s)"
    item = dialog.table.item(0, 0)
    assert item is not None and item.flags() & Qt.ItemFlag.ItemIsUserCheckable


def test_when_the_ai_is_off_the_commands_say_where_to_turn_it_on(
    ledger_page: tuple[MainWindow, Family, LedgerPage],
) -> None:
    from opesvault.ui.local_ai import OFF

    window, f, page = ledger_page
    update_settings(f.ledger, ai_enabled=False)
    page.refresh()
    assert page.ai_button.isHidden()
    for command in (page.suggest_categories_ai, page.suggest_names_ai):
        command()
        assert window.statusBar().currentMessage() == OFF and not page.ai_row.running


def test_ollama_off_is_said_without_touching_the_ledger(
    ledger_page: tuple[MainWindow, Family, LedgerPage], monkeypatch: pytest.MonkeyPatch
) -> None:
    _window, f, page = ledger_page
    f.ledger.record_expense(f.bank, f.groceries, "20.00", date(2026, 2, 1), "UBER *TRIP")
    page.refresh()
    preferences.set_ollama_port(9)  # nothing listens there
    said: list[str] = []
    monkeypatch.setattr("opesvault.ui.pages.ledger.ai.QMessageBox.information", lambda *a: said.append(a[2]))
    before = f.ledger.change_count
    page.suggest_categories_ai()
    _wait(page)
    assert said == ["Ollama indisponível."] and f.ledger.change_count == before


def test_a_new_entry_asks_the_model_only_when_the_history_does_not_know(app: QApplication, ollama: str) -> None:
    from opesvault.ui.dialogs import OperationDialog

    f = _bank_family()
    update_settings(f.ledger, ai_enabled=True, ai_model="gemma4:12b")
    preferences.set_ollama_port(urlparse(ollama).port or 0)
    f.ledger.record_expense(f.bank, category(f.ledger, "Lazer"), "30.00", date(2026, 2, 1), "CINEMARK")
    dialog = OperationDialog(None, f.ledger, "expense")
    dialog.description.setText("CINEMARK")
    assert dialog.ai_button.isHidden()  # the history already answers
    dialog.description.setText("ACADEMIA SMART FIT")
    assert not dialog.ai_button.isHidden()
    _answer(suggestions=[{"index": 0, "category": "Saúde"}])
    dialog.ask_ai()
    assert dialog.category_hint.text() == "Perguntando à IA local…"
    for _ in range(50):
        QThreadPool.globalInstance().waitForDone(10_000)
        QApplication.processEvents()
        if dialog._ai_job is None:
            break
    assert combo_value(dialog.target) == category(f.ledger, "Saúde")
    assert "IA local (gemma4:12b)" in dialog.category_hint.text()
    assert "ACADEMIA SMART FIT" in _user_messages()[-1] and "CINEMARK → Lazer" in _user_messages()[-1]


def test_a_choice_made_while_the_model_thinks_wins(app: QApplication, ollama: str) -> None:
    from opesvault.ui.dialogs import OperationDialog

    f = _bank_family()
    update_settings(f.ledger, ai_enabled=True, ai_model="gemma4:12b")
    preferences.set_ollama_port(urlparse(ollama).port or 0)
    dialog = OperationDialog(None, f.ledger, "expense")
    dialog.description.setText("ACADEMIA SMART FIT")
    _answer(suggestions=[{"index": 0, "category": "Saúde"}])
    gate = threading.Event()
    original = OllamaClient.suggest_categories

    def slow(self: OllamaClient, *args: Any, **kwargs: Any) -> Any:
        gate.wait(5)
        return original(self, *args, **kwargs)

    OllamaClient.suggest_categories = slow  # type: ignore[method-assign]
    try:
        dialog.ask_ai()
        select_combo(dialog.target, category(f.ledger, "Lazer"))
        dialog.target.activated.emit(dialog.target.currentIndex())  # the person's pick
        gate.set()
        for _ in range(50):
            QThreadPool.globalInstance().waitForDone(10_000)
            QApplication.processEvents()
            if dialog._ai_job is None:
                break
    finally:
        OllamaClient.suggest_categories = original  # type: ignore[method-assign]
    assert combo_value(dialog.target) == category(f.ledger, "Lazer")


def test_settings_say_where_the_model_runs(app: QApplication, tmp_path: Path, ollama: str) -> None:
    from opesvault.ui.pages.settings_page import SettingsPage

    window = MainWindow()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    update_settings(session.ledger, ai_enabled=True, ai_model="gemma4:12b")
    window.session = session
    window._refresh()
    page = next(p for p in window.pages if isinstance(p, SettingsPage))
    page.ai_port.setValue(urlparse(ollama).port or 0)
    assert preferences.ollama_port() == page.ai_port.value()  # this computer's: saved at once
    FakeOllama.gpu_share = 40
    page.test_ai()
    for _ in range(50):
        QThreadPool.globalInstance().waitForDone(10_000)
        QApplication.processEvents()
        if page.ai_check.isEnabled():
            break
    assert "Só 40% do modelo coube na GPU" in page.ai_status.text()
    assert {"model": "gemma4:12b", "keep_alive": "10m"} in FakeOllama.received  # loaded to measure
