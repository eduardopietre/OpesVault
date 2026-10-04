"""The assistant's tools, described the way MCP describes them (name, description, inputSchema).

The app is the host: the local model only asks for a tool; the app validates the arguments,
runs reads itself and prepares each change for the user to approve. There is no MCP server
process and no port: nothing outside this app can reach the vault through these tools.

A tool is either a read (`run` returns data) or an edit (`prepare` checks everything and returns
a `PreparedEdit` that says in words what will change; only `PreparedEdit.apply`, called after
the user approves, touches the ledger). Arguments are pydantic models with `extra="forbid"`, so
an unknown field or a wrong type is an error sent back to the model, never a guess.

Accounts, categories and members are referred to by name (a small model copies names better
than UUIDs); operations by the short `id` the read tools return (the first 8 hex digits).
"""

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import StrEnum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ValidationError

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount, Operation, YearMonth
from opesvault.domain.money import CENT, MoneyError, parse_brl, to_decimal

MAX_ROWS = 50  # rows a read returns at most; the total says how many matched
SHORT_ID = 8


class ToolKind(StrEnum):
    READ = "read"
    EDIT = "edit"


class ToolError(Exception):
    """The arguments are wrong in a way the model can fix; the message goes back to it."""


@dataclass(frozen=True)
class PreparedEdit:
    """A change checked and described, waiting for the user. Nothing has changed yet."""

    tool: str
    summary: str  # one line, shown as the title of the approval
    details: tuple[str, ...]  # what exactly changes, one line each
    apply: Callable[[], dict[str, Any]]  # runs on the UI thread, after the approval


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    arguments: type[BaseModel]
    kind: ToolKind
    run: Callable[[Ledger, Any], Any] | None = None  # reads
    prepare: Callable[[Ledger, Any, str], PreparedEdit] | None = None  # edits; the str is the origin

    def schema(self) -> dict[str, Any]:
        found = self.arguments.model_json_schema()
        found.pop("title", None)
        for prop in found.get("properties", {}).values():
            prop.pop("title", None)
        return found

    def mcp(self) -> dict[str, Any]:
        """The MCP `Tool` shape (tools/list)."""
        return {"name": self.name, "description": self.description, "inputSchema": self.schema()}

    def ollama(self) -> dict[str, Any]:
        """The same tool as Ollama's chat API expects it."""
        return {
            "type": "function",
            "function": {"name": self.name, "description": self.description, "parameters": self.schema()},
        }


@dataclass
class Registry:
    tools: dict[str, Tool] = field(default_factory=dict)

    def add(self, tool: Tool) -> None:
        self.tools[tool.name] = tool

    def mcp_list(self) -> list[dict[str, Any]]:
        return [t.mcp() for t in self.tools.values()]

    def ollama_list(self) -> list[dict[str, Any]]:
        return [t.ollama() for t in self.tools.values()]

    def parse(self, name: str, arguments: object) -> tuple[Tool, BaseModel]:
        """The tool and its validated arguments; ToolError says what is wrong, for the model to fix."""
        tool = self.tools.get(name)
        if tool is None:
            known = ", ".join(sorted(self.tools))
            raise ToolError(f"Ferramenta desconhecida: '{name}'. Use uma destas: {known}.")
        if arguments is None:
            arguments = {}
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments or "{}", parse_float=Decimal)
            except json.JSONDecodeError as exc:
                raise ToolError(f"Argumentos ilegíveis para {name}: não são JSON.") from exc
        if not isinstance(arguments, dict):
            raise ToolError(f"Os argumentos de {name} devem ser um objeto JSON.")
        try:
            return tool, tool.arguments.model_validate(arguments)
        except ValidationError as exc:
            problems = "; ".join(
                f"{'.'.join(str(p) for p in e['loc']) or 'argumentos'}: {_problem(e)}" for e in exc.errors()[:5]
            )
            raise ToolError(f"Argumentos inválidos para {name}: {problems}.") from exc


def _problem(error: Any) -> str:
    kind = error.get("type", "")
    if kind == "missing":
        return "obrigatório"
    if kind == "extra_forbidden":
        return "campo que não existe"
    return str(error.get("msg", "valor inválido"))


def result_text(data: object) -> str:
    """What a tool result looks like to the model: compact JSON, money and dates as text."""
    return json.dumps(data, ensure_ascii=False, default=_plain, separators=(",", ":"))


def _plain(value: object) -> object:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (date, YearMonth, UUID)):
        return str(value)
    raise TypeError(type(value).__name__)


# ── reading what the model typed ────────────────────


def money(value: object, what: str = "valor") -> Decimal:
    """A positive amount in cents: "123.45", "123,45", "R$ 1.234,56" or a JSON number (as Decimal)."""
    try:
        if isinstance(value, str) and not re.fullmatch(r"\s*-?\d+(\.\d+)?\s*", value):
            amount = parse_brl(value)
        else:
            amount = to_decimal(value)
    except (MoneyError, ValueError, ArithmeticError) as exc:
        raise ToolError(f"{what} ilegível: use números como 123.45.") from exc
    if amount <= 0:
        raise ToolError(f"{what} deve ser positivo.")
    if amount != amount.quantize(CENT):
        raise ToolError(f"{what} deve ter no máximo duas casas decimais.")
    return amount


def day(text: str | None, what: str = "data") -> date | None:
    if text is None or not text.strip():
        return None
    try:
        return date.fromisoformat(text.strip())
    except ValueError as exc:
        raise ToolError(f"{what} inválida: use AAAA-MM-DD.") from exc


def month(text: str | None, what: str = "mês") -> YearMonth | None:
    if text is None or not text.strip():
        return None
    found = re.fullmatch(r"\s*(\d{4})-(\d{1,2})\s*", text)
    if found is None or not 1 <= int(found.group(2)) <= 12:
        raise ToolError(f"{what} inválido: use AAAA-MM.")
    return YearMonth(year=int(found.group(1)), month=int(found.group(2)))


def account_label(ledger: Ledger, account: LedgerAccount) -> str:
    parent = ledger.accounts.get(account.parent_id) if account.parent_id else None
    return f"{parent.name} › {account.name}" if parent else account.name


def _fold(text: str) -> str:
    import unicodedata

    plain = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    return " ".join(plain.casefold().replace(">", "›").split())


def find_account(ledger: Ledger, name: str, *, categories: bool | None = None) -> LedgerAccount:
    """By name, ignoring case and accents; a category also by "Pai › Filho".

    `categories`: True only categories, False only balance accounts, None either.
    """
    wanted = _fold(name)
    pool = [
        a
        for a in ledger.accounts.values()
        if not a.archived
        and (categories is None or (a.subtype is AccountSubtype.CATEGORY) == categories)
        and a.type is not AccountType.EQUITY
    ]
    exact = [a for a in pool if _fold(account_label(ledger, a)) == wanted]
    if not exact:
        exact = [a for a in pool if _fold(a.name) == wanted]
    if len(exact) == 1:
        return exact[0]
    what = "categoria" if categories else "conta" if categories is False else "conta ou categoria"
    if len(exact) > 1:
        options = ", ".join(sorted(account_label(ledger, a) for a in exact))
        raise ToolError(f"Há mais de uma {what} chamada '{name}': {options}. Use o nome completo.")
    hint = "list_categories" if categories else "list_accounts"
    raise ToolError(f"Não existe {what} chamada '{name}'. Consulte {hint}.")


def find_category(ledger: Ledger, name: str, kind: AccountType | None = None) -> LedgerAccount:
    found = find_account(ledger, name, categories=True)
    if kind is not None and found.type is not kind:
        expected = "despesa" if kind is AccountType.EXPENSE else "receita"
        raise ToolError(f"'{name}' não é uma categoria de {expected}.")
    return found


def find_member(ledger: Ledger, name: str) -> UUID:
    wanted = _fold(name)
    for member in ledger.members.values():
        if member.active and _fold(member.name) == wanted:
            return member.id
    raise ToolError(f"Não existe integrante chamado '{name}'. Consulte list_members.")


def short_id(op_id: UUID) -> str:
    return op_id.hex[:SHORT_ID]


def find_operation(ledger: Ledger, ref: str) -> Operation:
    text = ref.strip().lower().replace("-", "")
    if len(text) < SHORT_ID or not re.fullmatch(r"[0-9a-f]+", text):
        raise ToolError(f"id de lançamento inválido: '{ref}'. Use o 'id' devolvido por search_operations.")
    found = [op for op in ledger.operations.values() if op.id.hex.startswith(text)]
    if len(found) != 1:
        raise ToolError(f"Não existe lançamento com id '{ref}'. Use o 'id' devolvido por search_operations.")
    return found[0]


def guarded(action: Callable[[], Any]) -> Any:
    """Domain checks become ToolErrors: the model reads the reason and may correct itself."""
    try:
        return action()
    except DomainError as exc:
        raise ToolError(str(exc)) from exc
