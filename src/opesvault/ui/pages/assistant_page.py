"""Assistente: questions about the project answered by the local model with the app's tools.

The model consults the ledger through read tools and proposes changes through edit tools;
each change opens "Aprovar alteração" and only runs when the user approves it, as one undo
step. A wrong answer of the model goes back to it as an error, up to three in a row
(`assistant.conversation`). The conversation lives only in memory and is cleared when the
vault closes; nothing of it is written to the vault, to disk or to the log.
"""

from collections.abc import Callable
from html import escape

from PySide6.QtWidgets import QLineEdit, QStackedWidget, QTextBrowser, QVBoxLayout, QWidget

from opesvault.ai.ollama import AiUnavailable, ModelTurn, OllamaClient
from opesvault.ai.prompts import ASSISTANT_SYSTEM, ASSISTANT_VERSION
from opesvault.assistant.conversation import Conversation, Pending
from opesvault.ui.components import EmptyState, button, flow_row, hbox_widget, text
from opesvault.ui.local_ai import OFF, AiRunRow, ApprovalDialog, client_for, failure_text
from opesvault.ui.pages.base import Page

EXAMPLES = (
    "Quanto gastei no último mês, por categoria?",
    "Quais foram as maiores despesas deste ano?",
    "Há lançamentos de Uber fora de Transporte?",
)


class AssistantPage(Page):
    title = "Assistente"
    section = "Acompanhamento"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.conversation = Conversation()
        self._client: OllamaClient | None = None
        self.header.set_subtitle("IA local com ferramentas: consulta o projeto e propõe mudanças que você aprova")
        self.new_button = button("Nova conversa", self.new_conversation, role="plain", tip="Esquece a conversa atual")
        self.header.add(self.new_button)

        self.transcript = QTextBrowser()
        self.transcript.setOpenLinks(False)
        self.transcript.setAccessibleName("Conversa com o assistente")
        self.links = flow_row()
        self.links.setAccessibleName("Atalhos sugeridos pelo assistente")
        self.links.hide()
        self.ai_row = AiRunRow(self)
        self.question = QLineEdit()
        self.question.setPlaceholderText("Pergunte sobre o projeto ou peça uma mudança (você aprova cada uma)")
        self.question.setAccessibleName("Pergunta ao assistente")
        self.question.returnPressed.connect(self.send)
        self.send_button = button("Enviar", self.send)
        self.send_button.setProperty("role", "primary")
        self.examples = flow_row(*(button(e, lambda e=e: self._example(e), role="plain") for e in EXAMPLES))
        self.chat = chat = QWidget()
        column = QVBoxLayout(chat)
        column.setContentsMargins(0, 0, 0, 0)
        column.addWidget(
            text(
                "Só o Ollama deste computador participa. O assistente lê o que está no cofre aberto (sem CPF e "
                "CNPJ) e cada alteração que ele propõe passa pela sua aprovação.",
                "caption",
                wrap=True,
            )
        )
        column.addWidget(self.transcript, 1)
        column.addWidget(self.links)
        column.addWidget(self.ai_row)
        column.addWidget(self.examples)
        column.addWidget(hbox_widget(self.question, self.send_button))

        self.off = EmptyState(
            "Assistente desligado",
            "Ligue a IA local e escolha um modelo que aceite ferramentas em Configurações › IA local.",
            [button("Abrir Configurações", lambda: self.navigate("settings"))],
        )
        self.views = QStackedWidget()
        self.views.addWidget(chat)
        self.views.addWidget(self.off)
        layout = self.page_layout()
        layout.addWidget(self.views, 1)

    # ── state ───────────────────────────────────────

    def refresh(self) -> None:
        if self.session is None:
            self.ai_row.stop()  # the vault closed: nothing of the conversation survives it
            self._clear()
            self.views.setCurrentWidget(self.off)
            return
        on = client_for(self.session.ledger) is not None
        self.views.setCurrentWidget(self.chat if on else self.off)
        self._update_controls()

    def _clear(self) -> None:
        self.conversation.reset()
        self._client = None
        self.transcript.clear()
        self.question.clear()
        self._clear_links()

    def _clear_links(self) -> None:
        layout = self.links.layout()
        while layout is not None and layout.count():
            item = layout.takeAt(0)
            widget = item.widget() if item is not None else None
            if widget is not None:
                widget.deleteLater()
        self.links.hide()

    def _update_controls(self) -> None:
        running = self.ai_row.running
        self.send_button.setEnabled(not running)
        self.question.setEnabled(not running)
        self.examples.setVisible(not self.conversation.messages and not running)

    def new_conversation(self) -> None:
        if self.ai_row.running:
            self.notify("Aguarde a resposta ou cancele antes de começar outra conversa.")
            return
        self._clear()
        self._update_controls()

    # ── transcript ──────────────────────────────────

    def _say(self, who: str, message: str) -> None:
        body = escape(message).replace("\n", "<br>")
        self.transcript.append(f"<p><b>{escape(who)}:</b> {body}</p>")

    def _note(self, message: str) -> None:
        self.transcript.append(f"<p><i>{escape(message)}</i></p>")

    def _example(self, question: str) -> None:
        self.question.setText(question)
        self.send()

    # ── asking ──────────────────────────────────────

    def send(self) -> None:
        if self.session is None:
            return
        question = " ".join(self.question.text().split())
        if self.ai_row.running:
            self.notify("O assistente ainda está respondendo.")
            return
        if not question:
            self.notify("Escreva uma pergunta.")
            return
        client = client_for(self.session.ledger)
        if client is None:
            self.notify(OFF)
            return
        self._client = client
        self.question.clear()
        self._clear_links()
        self._say("Você", question)
        self.conversation.ask(question)
        self._next(first=True)

    def _next(self, *, first: bool) -> None:
        """Asks the model for its next answer, in the background."""
        client = self._client
        session = self.session
        if client is None or session is None:
            return
        messages = self.conversation.request()
        tools = self.conversation.tools()

        def work(_report: Callable[[int, int], None], cancel: object) -> object:
            if first and client.supports_tools() is False:
                raise AiUnavailable(
                    f"O modelo {client.model} não aceita ferramentas. Escolha outro em Configurações › IA local "
                    "(por exemplo, um modelo qwen).",
                    fatal=True,
                )
            return client.chat_tools(ASSISTANT_SYSTEM, messages, tools)

        def done(result: object) -> None:
            if self.session is not session:  # the vault closed meanwhile
                return
            self._answered(result)

        self.ai_row.start(client, work, 0, "pensando…", done, check=first)
        self._update_controls()

    def _answered(self, result: object) -> None:
        client = self._client
        if self.session is None or client is None:
            return
        if not isinstance(result, ModelTurn):
            self._note(f"IA local: {failure_text(result)}")
            self._update_controls()
            return
        step = self.conversation.receive(result, self.session.ledger, client.source_for(ASSISTANT_VERSION))
        for line in step.activity:
            self._note(line)
        for label, ref in step.links:
            self._offer_link(label, ref)
        for pending in step.pending:
            self._note(self._decide(pending, client.model))
        if step.stop is not None:
            self._note(step.stop)
        elif step.answer is not None:
            self._say("Assistente", step.answer)
        elif self.ai_row.cancelled:
            self._note("Consulta cancelada.")
        else:
            self._next(first=False)
            return
        self._update_controls()

    def _decide(self, pending: Pending, model: str) -> str:
        """Each change waits for the user: approved, it runs now as one undo step."""
        dialog = ApprovalDialog(self, pending.edit.summary, pending.edit.details, model)
        approved = bool(dialog.exec())
        line = self.conversation.resolve(pending, approved)
        if approved and line.startswith("Aplicado"):
            self.changed()
        return line

    def _offer_link(self, label: str, ref: object) -> None:
        layout = self.links.layout()
        if layout is None:
            return
        layout.addWidget(button(f"Ver no Livro: {label}", lambda r=ref: self.navigate("ledger", r), role="plain"))
        self.links.show()
