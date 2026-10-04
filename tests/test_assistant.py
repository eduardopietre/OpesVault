"""The assistant: the local model with the app's tools (opesvault/assistant, ui/pages/assistant_page.py).

The contract under test, decided by the user on 04/10/2026:
- reads run as the model asks and never change the ledger;
- every change is prepared and described first, and only runs after the user approves it;
- an invalid answer goes back to the model as an error; three in a row interrupt the question;
- money arrives as Decimal (never float) and CPF/CNPJ never reach the model.
Every model answer comes from the fake Ollama (tests/fake_ollama.py).
"""

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import pytest
from PySide6.QtCore import QThreadPool
from PySide6.QtWidgets import QApplication

from opesvault.ai.ollama import AiUnavailable, ModelTurn, OllamaClient, ToolCall
from opesvault.assistant import edits, reads
from opesvault.assistant.conversation import MAX_ATTEMPTS, MAX_STEPS, Conversation
from opesvault.assistant.tools import ToolError, ToolKind
from opesvault.domain import budget, queries
from opesvault.domain.model import YearMonth
from opesvault.domain.settings import update_settings
from opesvault.session import Session
from opesvault.ui import preferences
from opesvault.ui.main_window import MainWindow

from .domain_fixtures import Family, category, family
from .fake_ollama import FakeOllama

ORIGIN = "ollama:m:a1"


def _family() -> Family:
    f = family()
    f.ledger.record_opening_balance(f.bank, "5000.00", date(2026, 1, 1))
    return f


def _turn(*calls: tuple[str, object], content: str = "") -> ModelTurn:
    raw = {
        "role": "assistant",
        "content": content,
        "tool_calls": [{"function": {"name": n, "arguments": a}} for n, a in calls],
    }
    return ModelTurn(content, tuple(ToolCall(n, a) for n, a in calls), raw)


def _id(op: Any) -> str:
    return op.id.hex[:8]


# ── the tools ───────────────────────────────────────


def test_tools_are_described_as_mcp_describes_them() -> None:
    conversation = Conversation()
    listed = conversation.registry.mcp_list()
    assert len(listed) == len(reads.READS) + len(edits.EDITS)
    for tool in listed:
        assert set(tool) == {"name", "description", "inputSchema"}
        schema = tool["inputSchema"]
        assert schema["type"] == "object" and schema.get("additionalProperties") is False
    for name, description, *_ in edits.EDITS:
        assert "aprovação" in description, name  # the model is told an edit waits for the user
    assert all(t["type"] == "function" for t in conversation.tools())


def test_every_read_leaves_the_ledger_as_it_was() -> None:
    from .demo_vault import demo_session

    ledger = demo_session(Path("/nonexistent/demo.opesvault")).ledger
    registry = Conversation().registry
    before = ledger.change_count
    arguments: dict[str, dict[str, Any]] = {
        "spending_by_category": {"start": "2026-01", "end": "2026-03"},
        "merchant_totals": {"start": "2026-03"},
        "get_operation": {"id": next(iter(ledger.operations)).hex[:8]},
        "show_in_ledger": {"account": "Alimentação", "start": "2026-03-01", "end": "2026-03-31"},
    }
    for tool in registry.tools.values():
        if tool.kind is ToolKind.READ:
            parsed = registry.parse(tool.name, arguments.get(tool.name, {}))[1]
            assert tool.run is not None
            json.dumps(tool.run(ledger, parsed), default=str)  # plain data
    assert ledger.change_count == before


def test_cpf_and_cnpj_never_reach_the_model() -> None:
    from opesvault.tax import records
    from opesvault.tax.model import TaxSubject

    f = _family()
    records.set_member_info(f.ledger, f.ana, cpf="529.982.247-25", birth_date=None, declared_by=None)
    records.set_identity(f.ledger, TaxSubject.CATEGORY, f.salary, "11.222.333/0001-81", "Empresa")
    f.ledger.record_income(f.bank, f.salary, "4000.00", date(2026, 2, 5), "SALARIO")
    conversation = Conversation()
    conversation.ask("tudo")
    for tool in conversation.registry.tools.values():
        if tool.kind is ToolKind.READ and tool.name not in ("spending_by_category", "merchant_totals"):
            args = {"id": next(iter(f.ledger.operations)).hex[:8]} if tool.name == "get_operation" else {}
            if tool.name == "show_in_ledger":
                args = {"account": "Banco A"}
            conversation.receive(_turn((tool.name, args)), f.ledger, ORIGIN)
    sent = json.dumps(conversation.request(), ensure_ascii=False)
    assert "Consultou" not in sent  # the transcript lines are for the user only
    for secret in ("52998224725", "529.982.247-25", "11222333000181", "11.222.333/0001-81"):
        assert secret not in sent


def test_an_edit_is_described_first_and_runs_only_when_approved() -> None:
    f = _family()
    ledger = f.ledger
    op = ledger.record_expense(f.bank, f.groceries, "87.40", date(2026, 2, 3), "UBER *TRIP 123")
    conversation = Conversation()
    conversation.ask("os uber são transporte")
    before = ledger.change_count
    step = conversation.receive(
        _turn(("reclassify_operations", {"ids": [_id(op)], "category": "transporte", "reason": "é corrida"})),
        ledger,
        ORIGIN,
    )
    [pending] = step.pending
    assert pending.edit.summary == "Reclassificar 1 lançamento(s) para Transporte"
    assert "Alimentação → Transporte" in pending.edit.details[0] and ledger.change_count == before
    assert step.again  # the model hears the result before answering
    assert conversation.resolve(pending, approved=True).startswith("Aplicado")
    assert queries.balance(ledger, category(ledger, "Transporte")) == Decimal("87.40")
    assert ledger.history_of(op.id)[-1].reason == f"é corrida (assistente, {ORIGIN})"
    assert json.loads(conversation.messages[-1]["content"])["resultado"] == "aplicado"


def test_a_refused_edit_changes_nothing_and_the_model_is_told() -> None:
    f = _family()
    conversation = Conversation()
    conversation.ask("orçamento")
    step = conversation.receive(
        _turn(("set_budget", {"month": "2026-03", "category": "Lazer", "amount": "300,00"})), f.ledger, ORIGIN
    )
    before = f.ledger.change_count
    assert conversation.resolve(step.pending[0], approved=False).startswith("Você recusou")
    assert f.ledger.change_count == before and budget.lines(f.ledger) == {}
    assert "recusado" in conversation.messages[-1]["content"]


@pytest.mark.parametrize(
    ("tool", "arguments", "words"),
    [
        ("apagar_tudo", {}, "Ferramenta desconhecida"),
        ("search_operations", {"texto": "uber"}, "campo que não existe"),
        ("set_budget", {"month": "2026-03", "category": "Lazer"}, "amount: obrigatório"),
        ("set_budget", {"month": "2026-03", "category": "Lazer", "amount": 0.5}, "valor ilegível"),  # a float
        ("set_budget", {"month": "março", "category": "Lazer", "amount": "10"}, "AAAA-MM"),
        ("set_budget", {"month": "2026-03", "category": "Salário", "amount": "10"}, "não é uma categoria de despesa"),
        ("set_budget", {"month": "2026-03", "category": "Lazer", "amount": "10.001"}, "duas casas"),
        ("reclassify_operations", {"ids": ["zz"], "category": "Lazer", "reason": "xxx"}, "id de lançamento"),
        ("record_expense", {"account": "Banco A", "category": "Inventada", "amount": "1", "date": "2026-01-02",
                            "description": "x"}, "Não existe categoria"),
        ("search_operations", "{não é json", "não são JSON"),
    ],
)  # fmt: skip
def test_wrong_arguments_go_back_to_the_model(tool: str, arguments: object, words: str) -> None:
    f = _family()
    conversation = Conversation()
    conversation.ask("x")
    before = f.ledger.change_count
    step = conversation.receive(_turn((tool, arguments)), f.ledger, ORIGIN)
    error = json.loads(conversation.messages[-1]["content"])["erro"]
    assert words in error and step.again and not step.pending
    assert conversation.invalid == 1 and f.ledger.change_count == before


def test_three_invalid_answers_in_a_row_interrupt_and_a_valid_one_resets() -> None:
    f = _family()
    conversation = Conversation()
    conversation.ask("x")
    conversation.receive(_turn(("nope", {})), f.ledger, ORIGIN)
    conversation.receive(_turn(content=""), f.ledger, ORIGIN)  # empty
    assert conversation.invalid == 2
    conversation.receive(_turn(("list_members", {})), f.ledger, ORIGIN)  # a valid one
    assert conversation.invalid == 0
    steps = [
        conversation.receive(_turn(content='{"name": "list_members", "arguments": {}}'), f.ledger, ORIGIN)
        for _ in range(MAX_ATTEMPTS)
    ]
    assert [s.stop is not None for s in steps] == [False] * (MAX_ATTEMPTS - 1) + [True]
    step = steps[-1]
    assert step.stop is not None and "3 vezes" in step.stop and "texto" in step.stop
    assert "Erro do aplicativo" in conversation.messages[-1]["content"]


def test_a_question_cannot_loop_forever() -> None:
    f = _family()
    conversation = Conversation()
    conversation.ask("x")
    for _ in range(MAX_STEPS - 1):
        assert conversation.receive(_turn(("list_members", {})), f.ledger, ORIGIN).stop is None
    step = conversation.receive(_turn(("list_members", {})), f.ledger, ORIGIN)
    assert step.stop is not None and str(MAX_STEPS) in step.stop


def test_each_edit_tool_prepares_without_changing_and_applies_after_approval() -> None:
    from opesvault.domain import merchants, tags
    from opesvault.importing import rules

    f = _family()
    ledger = f.ledger
    op = ledger.record_expense(f.bank, f.groceries, "50.00", date(2026, 2, 1), "IFD*IFOOD.COM AGENCIA")
    cases: list[tuple[str, dict[str, Any], Any]] = [
        ("tag_operations", {"ids": [_id(op)], "tag": "Viagem"}, lambda: tags.tags_of(ledger, op.id) == ("Viagem",)),
        (
            "name_merchant",
            {"description": "IFD*IFOOD.COM AGENCIA", "name": "iFood"},
            lambda: merchants.merchant_of(ledger, op.description) == "iFood",
        ),
        (
            "create_category_rule",
            {"pattern": "ifood", "category": "Lazer"},
            lambda: any(r.pattern == "IFOOD" for r in rules.rules(ledger).values()),
        ),
        (
            "record_income",
            {"account": "banco a", "category": "Salário", "amount": Decimal("4000"), "date": "2026-02-05",
             "description": "Salário"},
            lambda: queries.balance(ledger, f.salary) == Decimal("4000"),
        ),
        (
            "record_expense",
            {"account": "Banco A", "category": "Saúde", "amount": "R$ 1.234,56", "date": "2026-02-06",
             "description": "Exame"},
            lambda: queries.balance(ledger, category(ledger, "Saúde")) == Decimal("1234.56"),
        ),
        (
            "set_budget",
            {"month": "2026-02", "category": "Lazer", "amount": "300"},
            lambda: budget.line_for(ledger, category(ledger, "Lazer"), YearMonth(year=2026, month=2)) is not None,
        ),
    ]  # fmt: skip
    for name, arguments, applied in cases:
        conversation = Conversation()
        conversation.ask(name)
        before = ledger.change_count
        [pending] = conversation.receive(_turn((name, arguments)), ledger, ORIGIN).pending
        assert ledger.change_count == before and pending.edit.summary, name
        assert conversation.resolve(pending, approved=True).startswith("Aplicado"), name
        assert applied(), name


def test_an_edit_that_fails_on_apply_is_reported_to_the_model() -> None:
    f = _family()
    op = f.ledger.record_expense(f.bank, f.groceries, "20.00", date(2026, 2, 1), "PADARIA")
    conversation = Conversation()
    conversation.ask("x")
    [pending] = conversation.receive(
        _turn(("reclassify_operations", {"ids": [_id(op)], "category": "Lazer", "reason": "lanche"})), f.ledger, ORIGIN
    ).pending
    f.ledger.cancel_operation(op.id, "duplicado")  # changed after the proposal, before the approval
    line = conversation.resolve(pending, approved=True)
    assert line.startswith("Não foi possível") and "erro" in conversation.messages[-1]["content"]


# ── the client ──────────────────────────────────────


def test_tool_calls_travel_with_exact_money(ollama: str) -> None:
    FakeOllama.messages = [
        {
            "content": "",
            "tool_calls": [
                {
                    "function": {
                        "name": "set_budget",
                        "arguments": {"month": "2026-03", "category": "Lazer", "amount": 300.1},
                    }
                }
            ],
        }
    ]
    client = OllamaClient("gemma4:12b", ollama)
    assert client.supports_tools() is True
    turn = client.chat_tools("sistema", [{"role": "user", "content": "x"}], Conversation().tools())
    [call] = turn.tool_calls
    assert call.name == "set_budget" and call.arguments["amount"] == Decimal("300.1")  # type: ignore[index]
    sent = FakeOllama.received[-1]
    assert sent["tools"] and sent["think"] is False and sent["stream"] is False
    assert sent["messages"][0] == {"role": "system", "content": "sistema"}
    FakeOllama.capabilities = ["completion"]
    assert client.supports_tools() is False
    FakeOllama.capabilities = None
    assert client.supports_tools() is None  # an older server: not known


def test_a_model_that_refuses_tools_says_what_to_do(ollama: str) -> None:
    FakeOllama.missing_model = False

    class Refusing(OllamaClient):
        def _request(self, path: str, payload: Any = None, timeout: float = 1, *, exact: bool = False) -> Any:
            from opesvault.ai.ollama import _HttpError

            raise _HttpError(400, '{"error":"gemma does not support tools"}')

    with pytest.raises(AiUnavailable, match="não aceita ferramentas"):
        Refusing("gemma", ollama).chat_tools("s", [], [])


# ── on screen ───────────────────────────────────────


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    return instance if isinstance(instance, QApplication) else QApplication([])


@pytest.fixture
def assistant(app: QApplication, tmp_path: Path, ollama: str) -> tuple[MainWindow, Family, Any]:
    from opesvault.ui.pages.assistant_page import AssistantPage

    window = MainWindow()
    f = _family()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = f.ledger
    update_settings(f.ledger, ai_enabled=True, ai_model="gemma4:12b")
    preferences.set_ollama_port(urlparse(ollama).port or 0)
    window.session = session
    window._refresh()
    session.undo_stack().seal()
    session.undo_stack().undo_steps.clear()
    page = next(p for p in window.pages if isinstance(p, AssistantPage))
    window.show_page(window.pages.index(page))
    return window, f, page


def _wait(page: Any) -> None:
    for _ in range(100):
        QThreadPool.globalInstance().waitForDone(10_000)
        QApplication.processEvents()
        if not page.ai_row.running:
            return
    raise AssertionError("the assistant did not answer")


def _approve(monkeypatch: pytest.MonkeyPatch, *answers: bool) -> list[Any]:
    from opesvault.ui.local_ai import ApprovalDialog

    seen: list[Any] = []
    queue = list(answers)

    def run(dialog: Any) -> int:
        seen.append(dialog)
        return 1 if queue.pop(0) else 0

    monkeypatch.setattr(ApprovalDialog, "exec", run)
    return seen


def _call(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {"content": "", "tool_calls": [{"function": {"name": name, "arguments": arguments}}]}


def test_a_question_is_answered_with_tools_and_the_change_waits_for_approval(
    assistant: tuple[MainWindow, Family, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    window, f, page = assistant
    op = f.ledger.record_expense(f.bank, f.groceries, "87.40", date(2026, 2, 3), "UBER *TRIP 123")
    FakeOllama.messages = [
        _call("search_operations", {"text": "uber"}),
        _call("reclassify_operations", {"ids": [_id(op)], "category": "Transporte", "reason": "é corrida"}),
        _call("show_in_ledger", {"account": "Transporte"}),
        {"content": "Pronto: 1 lançamento de Uber foi para Transporte."},
    ]
    approvals = _approve(monkeypatch, True)
    page.question.setText("Os Uber estão em Transporte?")
    page.send()
    assert page.ai_row.running and not page.send_button.isEnabled()
    _wait(page)
    [dialog] = approvals
    assert "Transporte" in dialog.windowTitle() or "Transporte" in pending_text(dialog)
    shown = page.transcript.toPlainText()
    assert "Você: Os Uber estão em Transporte?" in shown and "Consultou search_operations (1 encontrado(s))" in shown
    assert "Aplicado: Reclassificar 1 lançamento(s) para Transporte" in shown
    assert "Assistente: Pronto" in shown
    assert queries.balance(f.ledger, category(f.ledger, "Transporte")) == Decimal("87.40")
    assert window.session is not None and len(window.session.undo_stack().undo_steps) == 1
    assert not page.links.isHidden() and page.send_button.isEnabled()
    tools_sent = {t["function"]["name"] for t in FakeOllama.received[-1]["tools"]}
    assert "reclassify_operations" in tools_sent


def pending_text(dialog: Any) -> str:
    from PySide6.QtWidgets import QLabel

    return " ".join(label.text() for label in dialog.findChildren(QLabel))


def test_a_refusal_keeps_the_ledger_and_the_conversation_goes_on(
    assistant: tuple[MainWindow, Family, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    _window, f, page = assistant
    FakeOllama.messages = [
        _call("set_budget", {"month": "2026-03", "category": "Lazer", "amount": "300"}),
        {"content": "Tudo bem, não mudei o orçamento."},
    ]
    approvals = _approve(monkeypatch, False)
    page.question.setText("Ponha 300 de lazer em março")
    page.send()
    _wait(page)
    assert approvals and "R$ 300,00" in pending_text(approvals[0])
    assert budget.lines(f.ledger) == {}
    shown = page.transcript.toPlainText()
    assert "Você recusou" in shown and "não mudei" in shown


def test_three_wrong_answers_interrupt_the_question(
    assistant: tuple[MainWindow, Family, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    _window, f, page = assistant
    FakeOllama.messages = [
        _call("apagar_tudo", {}),
        _call("set_budget", {"month": "2026-03"}),
        {"content": ""},
        {"content": "nunca chega aqui"},
    ]
    _approve(monkeypatch)
    before = f.ledger.change_count
    page.question.setText("x")
    page.send()
    _wait(page)
    shown = page.transcript.toPlainText()
    assert "(3 de 3)" in shown and "interrompida" in shown and "nunca chega" not in shown
    assert f.ledger.change_count == before
    assert sum(1 for body in FakeOllama.received if "tools" in body) == 3


def test_a_model_without_tools_is_explained(assistant: tuple[MainWindow, Family, Any]) -> None:
    _window, _f, page = assistant
    FakeOllama.capabilities = ["completion"]
    page.question.setText("oi")
    page.send()
    _wait(page)
    assert "não aceita ferramentas" in page.transcript.toPlainText()


def test_off_and_closed(assistant: tuple[MainWindow, Family, Any]) -> None:
    window, _f, page = assistant
    FakeOllama.messages = [{"content": "Olá."}]
    page.question.setText("oi")
    page.send()
    _wait(page)
    assert "Olá." in page.transcript.toPlainText() and page.examples.isHidden()
    page.question.setText("")
    page.send()
    assert window.statusBar().currentMessage() == "Escreva uma pergunta."
    window._drop_session()  # the vault closes: nothing of the conversation stays on screen
    window._refresh()
    assert page.transcript.toPlainText() == "" and page.conversation.messages == []
    assert page.views.currentWidget() is page.off
    window.session = Session.new(Path("/nonexistent/y.opesvault"), "Teste")
    window._refresh()
    assert page.views.currentWidget() is page.off  # a vault with the AI off


def test_tool_errors_are_tool_errors() -> None:
    """ToolError is what the model reads; it must stay a plain message."""
    assert str(ToolError("x")) == "x"
