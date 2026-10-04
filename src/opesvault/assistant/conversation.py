"""One conversation with the local model and its tools, step by step (no Qt, no threads).

The page drives it the same way as every other AI task (docs/05 §5):

1. `ask` adds the user's question; `request` copies the messages to send (UI thread);
2. the model answers in the background (`OllamaClient.chat_tools`), never touching the ledger;
3. `receive` reads the answer on the UI thread: reads run at once, edits come back as
   `Pending` for the user to approve or refuse (`resolve`), and a final text is the answer.

An invalid answer (unknown tool, wrong arguments, an empty reply, a tool call written as text)
goes back to the model as an error, so it can correct itself. After `MAX_ATTEMPTS` invalid
answers in a row the question is interrupted; a valid answer resets the count. `MAX_STEPS`
bounds how many times the model is asked for one question, so a loop cannot run forever.
Nothing of the conversation is stored: it lives in memory and goes away with the vault.
"""

from dataclasses import dataclass, field
from typing import Any

from opesvault.ai.ollama import ModelTurn
from opesvault.assistant import edits, reads
from opesvault.assistant.tools import PreparedEdit, Registry, ToolError, result_text
from opesvault.domain.ledger import DomainError, Ledger

MAX_ATTEMPTS = 3
MAX_STEPS = 12
MAX_MESSAGES = 60  # older turns are dropped (whole questions), so the context stays small


def default_registry() -> Registry:
    registry = Registry()
    reads.register(registry)
    edits.register(registry)
    return registry


@dataclass
class Pending:
    """An edit waiting for the user: approve runs it, refuse tells the model it was refused."""

    tool: str
    edit: PreparedEdit
    resolved: bool = False


@dataclass
class Step:
    """What the page does after one answer of the model."""

    answer: str | None = None  # the final text for the user
    activity: list[str] = field(default_factory=list)  # one line per tool used, shown in the transcript
    pending: list[Pending] = field(default_factory=list)
    links: list[tuple[str, object]] = field(default_factory=list)  # (label, Livro filter) to offer
    stop: str | None = None  # the question was interrupted, and why

    @property
    def again(self) -> bool:
        """The model must be asked again (after the pending edits are resolved)."""
        return self.answer is None and self.stop is None


class Conversation:
    def __init__(self, registry: Registry | None = None) -> None:
        self.registry = registry or default_registry()
        self.messages: list[dict[str, Any]] = []
        self.invalid = 0  # invalid answers in a row
        self.steps = 0  # answers received for the current question

    def reset(self) -> None:
        self.messages.clear()
        self.invalid = self.steps = 0

    def ask(self, text: str) -> None:
        self._trim()
        self.messages.append({"role": "user", "content": text.strip()})
        self.invalid = self.steps = 0

    def request(self) -> list[dict[str, Any]]:
        return [dict(m) for m in self.messages]

    def tools(self) -> list[dict[str, Any]]:
        return self.registry.ollama_list()

    def _trim(self) -> None:
        while len(self.messages) > MAX_MESSAGES:
            del self.messages[0]
            while self.messages and self.messages[0].get("role") != "user":
                del self.messages[0]

    def _tool_message(self, name: str, data: object) -> None:
        self.messages.append({"role": "tool", "tool_name": name, "content": result_text(data)})

    def _invalid(self, step: Step, reason: str) -> Step:
        self.invalid += 1
        step.activity.append(f"Resposta inválida do modelo ({self.invalid} de {MAX_ATTEMPTS}): {reason}")
        if self.invalid >= MAX_ATTEMPTS:
            step.pending.clear()
            step.stop = f"A IA local errou {MAX_ATTEMPTS} vezes seguidas e a pergunta foi interrompida. {reason}"
        return step

    def receive(self, turn: ModelTurn, ledger: Ledger, origin: str) -> Step:
        self.steps += 1
        step = Step()
        if not turn.tool_calls:
            text = turn.content.strip()
            reason = None
            if not text:
                reason = "resposta vazia; responda ao usuário ou chame uma ferramenta."
            elif _looks_like_call(text):
                reason = "chamada de ferramenta escrita como texto; use o mecanismo de ferramentas."
            if reason is None:
                self.messages.append({"role": "assistant", "content": text})
                self.invalid = 0
                step.answer = text
                return step
            if text:
                self.messages.append({"role": "assistant", "content": text})
            self.messages.append({"role": "user", "content": f"Erro do aplicativo (não do usuário): {reason}"})
            return self._limit(self._invalid(step, reason))

        self.messages.append(dict(turn.raw))
        errors: list[str] = []
        for call in turn.tool_calls:
            try:
                tool, args = self.registry.parse(call.name, call.arguments)
                if tool.run is not None:
                    data = _run(tool.run, ledger, args)
                    if call.name == "show_in_ledger":
                        step.links.append((data["rotulo"], data["link"]))
                        data = {"resultado": "botão oferecido ao usuário", "rotulo": data["rotulo"]}
                    self._tool_message(call.name, data)
                    step.activity.append(f"Consultou {call.name}{_count(data)}")
                elif tool.prepare is not None:
                    step.pending.append(Pending(call.name, _run(tool.prepare, ledger, args, origin)))
            except ToolError as exc:
                errors.append(f"{call.name or '?'}: {exc}")
                self._tool_message(call.name or "?", {"erro": str(exc)})
        if errors:
            return self._limit(self._invalid(step, " ".join(errors)))
        self.invalid = 0
        return self._limit(step)

    def _limit(self, step: Step) -> Step:
        if step.again and self.steps >= MAX_STEPS:
            step.pending.clear()
            step.stop = f"A IA local passou de {MAX_STEPS} passos nesta pergunta e foi interrompida."
        return step

    def resolve(self, pending: Pending, approved: bool) -> str:
        """Runs (or refuses) one edit and tells the model what happened. Returns the transcript line."""
        pending.resolved = True
        if not approved:
            self._tool_message(pending.tool, {"resultado": "recusado pelo usuário; nada mudou"})
            return f"Você recusou: {pending.edit.summary}"
        try:
            outcome = _run(pending.edit.apply)
        except ToolError as exc:
            self._tool_message(pending.tool, {"erro": str(exc)})
            return f"Não foi possível aplicar: {exc}"
        self._tool_message(pending.tool, outcome)
        return f"Aplicado: {pending.edit.summary}"


def _run(action: Any, *args: Any) -> Any:
    try:
        return action(*args)
    except DomainError as exc:
        raise ToolError(str(exc)) from exc


def _looks_like_call(text: str) -> bool:
    start = text.lstrip("`").lstrip().lower()
    return (start.startswith("{") and '"name"' in start) or start.startswith(("<tool_call>", "[tool_call"))


def _count(data: object) -> str:
    if isinstance(data, dict) and isinstance(data.get("total"), int):
        return f" ({data['total']} encontrado(s))"
    return ""
