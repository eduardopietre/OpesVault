"""assistant/{tools,reads,edits,conversation}.py over the desktop's demo project.

Five parts, all on the same records (the demo vault plus a cancelled operation and a transfer):
- `schemas`: the MCP and Ollama tool lists (names, descriptions, JSON Schemas);
- `parse`: the arguments the model may send, valid and hostile, and what the registry makes of them
  (the parsed arguments or the exact message that goes back to the model);
- `reads`: every read tool on many arguments, as the exact text the model receives;
- `edits`: every edit tool prepared (summary and details), then applied on a fresh copy, with the
  records left behind;
- `conversations`: scripted model answers through `Conversation.receive`/`resolve`: transcript lines,
  the messages sent back, counters and the interruption rules.

Ids are random on both sides: tools show only the first 8 hex digits of an operation, so arguments
name operations by description ("@op:Aluguel") and items by position ("@item:0"). `today` is
recorded because two tools read the calendar.
"""

import json
import re
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

from opesvault.ai.ollama import ModelTurn, ToolCall
from opesvault.assistant.conversation import MAX_ATTEMPTS, MAX_MESSAGES, MAX_STEPS, Conversation
from opesvault.assistant.tools import ToolError, ToolKind, result_text
from opesvault.domain.ledger import Ledger
from opesvault.importing import pipeline
from scripts.golden.cases_investments import known_ids, records_of
from tests.demo_vault import demo_session

UUID_IN_TEXT = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")
ORIGIN = "ollama:m:a1"
BIG = 10**30


def enc(value: Any) -> Any:
    """JSON with Decimal as {"$dec"} and huge integers as {"$big"}."""
    if isinstance(value, Decimal):
        return {"$dec": str(value)}
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and abs(value) > 2**53:
        return {"$big": str(value)}
    if isinstance(value, dict):
        return {k: enc(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [enc(v) for v in value]
    return value


def dec(value: Any) -> Any:
    if isinstance(value, dict):
        if set(value) == {"$dec"}:
            return Decimal(value["$dec"])
        if set(value) == {"$big"}:
            return int(value["$big"])
        return {k: dec(v) for k, v in value.items()}
    if isinstance(value, list):
        return [dec(v) for v in value]
    return value


# ── the project ─────────────────────────────────────


def build() -> tuple[list[dict[str, Any]], str]:
    ledger = demo_session(Path("/nonexistent/demo.opesvault")).ledger
    by_name = {a.name: a.id for a in ledger.accounts.values()}
    groceries = next(a.id for a in ledger.categories(_expense()) if a.name == "Alimentação")
    dup = ledger.record_expense(by_name["Banco A"], groceries, "33.00", date(2026, 3, 20), "Estorno duplicado")
    ledger.cancel_operation(dup.id, "duplicado")
    ledger.record_transfer(by_name["Banco A"], by_name["Poupança"], "100.00", date(2026, 3, 21), "Poupança teste")
    return records_of(ledger), date.today().isoformat()


def _expense() -> Any:
    from opesvault.domain.model import AccountType

    return AccountType.EXPENSE


def fresh(records: list[dict[str, Any]]) -> Ledger:
    return Ledger.from_records([(UUID(r["id"]), r["kind"], r["payload"]) for r in records])


def resolve(ledger: Ledger, value: Any) -> Any:
    if isinstance(value, str) and value.startswith("@op:"):
        description = value[4:]
        return next(op.id.hex[:8] for op in ledger.operations.values() if op.description == description)
    if isinstance(value, str) and value.startswith("@item:"):
        return list(pipeline.items(ledger))[int(value[6:])].hex[:8]
    if isinstance(value, list):
        return [resolve(ledger, v) for v in value]
    if isinstance(value, dict):
        return {k: resolve(ledger, v) for k, v in value.items()}
    return value


def canonical(row: Any) -> str:
    """The sort key of a row: compact JSON with sorted keys and no ASCII escapes (the TS side builds the same)."""
    return json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def state(ledger: Ledger, known: set[str]) -> list[Any]:
    """Every record, ids unknown before the call as "<new>", instants as "<instant>", sorted."""

    def norm(v: Any) -> Any:
        if isinstance(v, str):
            if INSTANT.match(v):
                return "<instant>"
            return UUID_IN_TEXT.sub(lambda m: m.group() if m.group() in known else "<new>", v)
        if isinstance(v, list):
            return [norm(x) for x in v]
        if isinstance(v, dict):
            return {k: norm(x) for k, x in v.items()}
        return v

    rows = [{"kind": kind, "payload": norm(payload)} for _id, kind, payload in ledger.to_records()]
    return sorted(rows, key=canonical)


def delta(after: list[Any], before: list[Any]) -> dict[str, list[Any]]:
    """Rows that appeared and rows that went away (both lists are sorted, ids already normalized)."""
    from collections import Counter

    a, b = Counter(map(canonical, after)), Counter(map(canonical, before))
    return {
        "added": [json.loads(k) for k in sorted((a - b).elements())],
        "removed": [json.loads(k) for k in sorted((b - a).elements())],
    }


# ── parse ───────────────────────────────────────────

D = Decimal
PARSE_CASES: list[tuple[str, Any]] = [
    ("search_operations", {"limit": "5"}),
    ("search_operations", {"limit": " 5 "}),
    ("search_operations", {"limit": "+5"}),
    ("search_operations", {"limit": "1_0"}),
    ("search_operations", {"limit": "5.0"}),
    ("search_operations", {"limit": "5.5"}),
    ("search_operations", {"limit": "1e1"}),
    ("search_operations", {"limit": "-3"}),
    ("search_operations", {"limit": "٣"}),
    ("search_operations", {"limit": "abc"}),
    ("search_operations", {"limit": ""}),
    ("search_operations", {"limit": D("5.0")}),
    ("search_operations", {"limit": D("5.5")}),
    ("search_operations", {"limit": D("1E+1")}),
    ("search_operations", {"limit": D("0.0")}),
    ("search_operations", {"limit": True}),
    ("search_operations", {"limit": False}),
    ("search_operations", {"limit": None}),
    ("search_operations", {"limit": 0}),
    ("search_operations", {"limit": 50}),
    ("search_operations", {"limit": 51}),
    ("search_operations", {"limit": BIG}),
    ("search_operations", {"limit": -BIG}),
    ("search_operations", {"limit": [1]}),
    ("search_operations", {"limit": {"a": 1}}),
    ("search_operations", {"text": 5}),
    ("search_operations", {"text": None}),
    ("search_operations", {"text": D("1.5")}),
    ("search_operations", {"text": ["a"]}),
    ("search_operations", {"text": True}),
    ("search_operations", {"status": "foo"}),
    ("search_operations", {"status": 5}),
    ("search_operations", {"status": None}),
    ("search_operations", {"status": "Ativos"}),
    ("search_operations", {"status": "todos", "limit": 1, "min_amount": "10", "tag": "x"}),
    ("search_operations", {"x": 1, "y": 2, "limit": 0}),
    ("search_operations", {"y": 1, "text": 3, "x": 2}),
    ("search_operations", {"a": 1, "b": 2, "c": 3, "d": 4, "e": 5, "f": 6, "text": 5}),
    ("list_categories", {"kind": "outra"}),
    ("list_categories", {"kind": "receita"}),
    ("tag_operations", {"ids": [], "tag": "x"}),
    ("tag_operations", {"ids": ["a"] * 200, "tag": "x"}),
    ("tag_operations", {"ids": ["a"] * 201, "tag": "x"}),
    ("tag_operations", {"ids": "abc", "tag": "x"}),
    ("tag_operations", {"ids": [1, 2], "tag": "x"}),
    ("tag_operations", {"ids": [1, "a"], "tag": ""}),
    ("tag_operations", {"ids": [1] * 201, "tag": "x"}),
    ("tag_operations", {"ids": None, "tag": "x"}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x" * 40}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x" * 41}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "é" * 40}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "😀" * 41}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": "yes"}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": "maybe"}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": 2}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": 1}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": 0}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": D("1")}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": D("1.0")}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": D("0.0")}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": D("2")}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": D("0.5")}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": None}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": "TRUE"}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": "On"}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": "off"}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": "F"}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": "n"}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": "0"}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": " true "}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": ""}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": []}),
    ("tag_operations", {"ids": ["abcdefgh"], "tag": "x", "remove": BIG}),
    ("reclassify_operations", {"ids": ["a"], "category": "x", "reason": "ab"}),
    ("reclassify_operations", {"ids": ["a"], "category": "x", "reason": "abc"}),
    ("reclassify_operations", {"ids": ["a"], "category": "x", "reason": "a" * 200}),
    ("reclassify_operations", {"ids": ["a"], "category": "x", "reason": "a" * 201}),
    ("reclassify_operations", {"ids": ["a"], "category": 3, "reason": "abc"}),
    ("reclassify_operations", {"ids": ["a"]}),
    ("reclassify_operations", {}),
    ("reclassify_operations", {"zz": 1}),
    ("set_budget", {"month": "2026-03", "category": "x", "amount": None}),
    ("set_budget", {"month": 5, "category": "x", "amount": "1"}),
    ("set_budget", {"month": "2026-03", "category": "x", "amount": [1]}),
    ("set_budget", {"month": "2026-03", "category": "x", "amount": D("1.5")}),
    ("set_budget", {"month": "2026-03", "category": "x", "amount": 3}),
    ("set_budget", {"month": "2026-03", "category": "x"}),
    ("record_expense", {"account": "a", "category": "b", "amount": "1", "date": 5, "description": ""}),
    (
        "record_expense",
        {"account": "a", "category": "b", "amount": "1", "date": "2026-01-01", "description": "x" * 201},
    ),
    ("name_merchant", {"description": "", "name": ""}),
    ("name_merchant", {"description": "x", "name": "n" * 61}),
    ("create_category_rule", {"pattern": "ab", "category": "c"}),
    ("create_category_rule", {"pattern": "a" * 81, "category": "c"}),
    ("set_import_item_category", {"item": 1}),
    ("get_operation", {"id": 5}),
    ("get_operation", {"id": None}),
    ("get_operation", {"id": "abcdefgh"}),
    ("list_members", {"a": 1}),
    ("list_members", None),
    ("list_members", ""),
    ("list_members", "  "),
    ("list_members", "{}"),
    ("list_members", '{"a": 1}'),
    ("list_members", "[]"),
    ("list_members", "[1]"),
    ("list_members", "null"),
    ("list_members", "5"),
    ("list_members", '"x"'),
    ("list_members", "true"),
    ("list_members", "NaN"),
    ("list_members", "{bad"),
    ("list_members", 5),
    ("list_members", []),
    ("list_members", [1]),
    ("list_members", True),
    ("list_members", D("1")),
    ("search_operations", '{"limit": 3.0}'),
    ("search_operations", '{"limit": 3.5}'),
    ("search_operations", '{"limit": 1e1}'),
    ("search_operations", '{"limit": 1E400}'),
    ("search_operations", '{"limit": 3, "limit": 4}'),
    ("search_operations", '{"limit": 99999999999999999999999}'),
    ("search_operations", '{"text": "ç\\u00e7"}'),
    ("set_budget", '{"month": "2026-03", "category": "Lazer", "amount": 12.50}'),
    ("set_budget", '{"month": "2026-03", "category": "Lazer", "amount": 1e2}'),
    ("nope", {}),
    ("", {}),
    ("get_overview", {"month": 5}),
    ("get_overview", {"month": "2026-03"}),
]


def parse_cases() -> list[dict[str, Any]]:
    registry = Conversation().registry
    out = []
    for name, args in PARSE_CASES:
        try:
            _tool, parsed = registry.parse(name, args)
            result: dict[str, Any] = {"ok": enc(parsed.model_dump())}
        except ToolError as exc:
            result = {"error": str(exc)}
        except Exception:
            result = {"crash": True}
        out.append({"tool": name, "args": enc(args), "result": result})
    return out


# ── reads ───────────────────────────────────────────

READ_CASES: list[tuple[str, dict[str, Any]]] = [
    ("get_overview", {}),
    ("get_overview", {"month": "2026-01"}),
    ("get_overview", {"month": "2026-03"}),
    ("get_overview", {"month": "2030-12"}),
    ("get_overview", {"month": "1900-01"}),
    ("get_overview", {"month": "1899-12"}),
    ("get_overview", {"month": "2026-13"}),
    ("get_overview", {"month": "2026-3"}),
    ("get_overview", {"month": " 2026-03 "}),
    ("get_overview", {"month": "   "}),
    ("get_overview", {"month": "marco"}),
    ("list_accounts", {}),
    ("list_categories", {}),
    ("list_categories", {"kind": "despesa"}),
    ("list_categories", {"kind": "receita"}),
    ("list_members", {}),
    ("search_operations", {}),
    ("search_operations", {"limit": 3}),
    ("search_operations", {"text": "mercado"}),
    ("search_operations", {"text": "MERCADO", "limit": 50}),
    ("search_operations", {"text": "pão"}),
    ("search_operations", {"text": "zzzz"}),
    ("search_operations", {"start": "2026-03-01", "end": "2026-03-31"}),
    ("search_operations", {"start": "20260301", "end": "2026-W10-1"}),
    ("search_operations", {"start": "2026-W53-1"}),
    ("search_operations", {"start": "2020-W53-7"}),
    ("search_operations", {"start": "2026-02-30"}),
    ("search_operations", {"start": "01/03/2026"}),
    ("search_operations", {"end": "x"}),
    ("search_operations", {"start": "  2026-03-01  "}),
    ("search_operations", {"account": "Banco A"}),
    ("search_operations", {"account": "banco a", "limit": 50}),
    ("search_operations", {"account": "Alimentação"}),
    ("search_operations", {"account": "alimentacao"}),
    ("search_operations", {"account": "Cartão X"}),
    ("search_operations", {"account": "Inexistente"}),
    ("search_operations", {"member": "Bruno"}),
    ("search_operations", {"member": "ana"}),
    ("search_operations", {"member": "Zé"}),
    ("search_operations", {"tag": "Viagem Serra 2026"}),
    ("search_operations", {"tag": "outra"}),
    ("search_operations", {"min_amount": "1000"}),
    ("search_operations", {"min_amount": "100,50", "max_amount": "R$ 400,00"}),
    ("search_operations", {"max_amount": "50"}),
    ("search_operations", {"min_amount": "abc"}),
    ("search_operations", {"min_amount": "-5"}),
    ("search_operations", {"min_amount": "0"}),
    ("search_operations", {"max_amount": "1.001"}),
    ("search_operations", {"min_amount": "1e3"}),
    ("search_operations", {"status": "cancelados"}),
    ("search_operations", {"status": "todos", "limit": 50}),
    ("search_operations", {"status": "ativos", "text": "estorno"}),
    ("search_operations", {"status": "todos", "text": "estorno"}),
    ("search_operations", {"account": "Poupança", "status": "todos"}),
    ("get_operation", {"id": "@op:Aluguel"}),
    ("get_operation", {"id": "@op:Mercado Pão de Açúcar"}),
    ("get_operation", {"id": "@op:TV 55 (6x)"}),
    ("get_operation", {"id": "@op:NETFLIX.COM"}),
    ("get_operation", {"id": "@op:Consulta pediatra"}),
    ("get_operation", {"id": "@op:Estorno duplicado"}),
    ("get_operation", {"id": "@op:Poupança teste"}),
    ("get_operation", {"id": "@op:Pousada Serra"}),
    ("get_operation", {"id": "@op:Salário"}),
    ("get_operation", {"id": "zz"}),
    ("get_operation", {"id": "abcdefgh"}),
    ("get_operation", {"id": "ABCDEFGH"}),
    ("get_operation", {"id": "0000"}),
    ("get_operation", {"id": "00000000"}),
    ("spending_by_category", {"start": "2026-01"}),
    ("spending_by_category", {"start": "2026-01", "end": "2026-03"}),
    ("spending_by_category", {"start": "2026-03", "end": "2026-01"}),
    ("spending_by_category", {"start": "2026-02", "end": "2026-02"}),
    ("spending_by_category", {"start": "x"}),
    ("spending_by_category", {"start": ""}),
    ("spending_by_category", {"start": "2026-01", "end": "  "}),
    ("spending_by_category", {"start": "2026-01", "end": "2025-13"}),
    ("month_summary", {}),
    ("month_summary", {"month": "2026-02"}),
    ("month_summary", {"month": "2026-03"}),
    ("month_summary", {"month": "2020-01"}),
    ("budget_status", {}),
    ("budget_status", {"month": "2026-03"}),
    ("budget_status", {"month": "2026-02"}),
    ("list_tags", {}),
    ("list_rules", {}),
    ("list_pending_import_items", {}),
    ("list_pending_import_items", {"limit": 2}),
    ("merchant_totals", {"start": "2026-01"}),
    ("merchant_totals", {"start": "2026-02", "end": "2026-03"}),
    ("merchant_totals", {"start": "2030-01"}),
    ("merchant_totals", {"start": "bad"}),
    ("show_in_ledger", {"account": "Alimentação"}),
    ("show_in_ledger", {"account": "Banco A", "start": "2026-03-01", "end": "2026-03-31"}),
    ("show_in_ledger", {"account": "Banco A", "start": "2026-03-01"}),
    ("show_in_ledger", {"account": "Banco A", "start": "bad", "end": "2026-03-31"}),
    ("show_in_ledger", {"tag": "Viagem Serra 2026"}),
    ("show_in_ledger", {"tag": "viagem serra 2026"}),
    ("show_in_ledger", {"tag": "nenhum"}),
    ("show_in_ledger", {}),
    ("show_in_ledger", {"account": "Nada"}),
]


def _link(data: Any) -> Any:
    link = data.get("link") if isinstance(data, dict) else None
    if link is None:
        return None
    return [
        link[0],
        *[str(x) if isinstance(x, UUID) else x for x in link[1:2]],
        *[[str(d) for d in x] if x else None for x in link[2:]],
    ]


def run_read(
    ledger: Ledger, records: list[dict[str, Any]], today: date, name: str, args: dict[str, Any]
) -> dict[str, Any]:
    import opesvault.assistant.reads as reads_mod

    registry = Conversation().registry
    resolved = resolve(ledger, args)
    try:
        tool, parsed = registry.parse(name, resolved)
        assert tool.run is not None
        original = reads_mod.date
        reads_mod.date = type("FrozenDate", (date,), {"today": staticmethod(lambda: today)})  # type: ignore[misc,assignment]
        try:
            data = tool.run(ledger, parsed)
        finally:
            reads_mod.date = original  # type: ignore[misc]
    except ToolError as exc:
        return {"error": str(exc)}
    except Exception:
        return {"crash": True}
    out: dict[str, Any] = {"text": result_text(data) if name != "show_in_ledger" else None}
    if name == "show_in_ledger":
        out["rotulo"] = data["rotulo"]
        out["link"] = _link(data)
    return out


# ── edits ───────────────────────────────────────────

EDIT_CASES: list[tuple[str, dict[str, Any], bool]] = [
    (
        "reclassify_operations",
        {"ids": ["@op:Mercado Pão de Açúcar"], "category": "Transporte", "reason": "é corrida"},
        True,
    ),
    (
        "reclassify_operations",
        {
            "ids": ["@op:Mercado Pão de Açúcar", "@op:Padaria Real"],
            "category": "transporte",
            "reason": "  dois   lançamentos  ",
        },
        True,
    ),
    (
        "reclassify_operations",
        {"ids": ["@op:Mercado Pão de Açúcar", "@op:Mercado Pão de Açúcar"], "category": "Lazer", "reason": "repetido"},
        True,
    ),
    (
        "reclassify_operations",
        {"ids": ["@op:Mercado Pão de Açúcar"], "category": "Alimentação", "reason": "mesma"},
        False,
    ),
    ("reclassify_operations", {"ids": ["@op:Salário"], "category": "Lazer", "reason": "tipo errado"}, False),
    ("reclassify_operations", {"ids": ["@op:Poupança teste"], "category": "Lazer", "reason": "transferência"}, False),
    ("reclassify_operations", {"ids": ["@op:Estorno duplicado"], "category": "Lazer", "reason": "cancelado"}, False),
    ("reclassify_operations", {"ids": ["@op:Aluguel"], "category": "Inventada", "reason": "xyz"}, False),
    ("reclassify_operations", {"ids": ["nao-existe-id"], "category": "Lazer", "reason": "xyz"}, False),
    ("reclassify_operations", {"ids": ["@op:Aluguel"], "category": "Banco A", "reason": "xyz"}, False),
    ("reclassify_operations", {"ids": ["@op:Aluguel"], "category": "Salário", "reason": "xyz"}, False),
    ("reclassify_operations", {"ids": ["@op:TV 55 (6x)"], "category": "Educação", "reason": "parcelas"}, True),
    ("tag_operations", {"ids": ["@op:Aluguel"], "tag": "Casa"}, True),
    ("tag_operations", {"ids": ["@op:Aluguel", "@op:Salário"], "tag": "  Dupla   marca "}, True),
    ("tag_operations", {"ids": ["@op:Pousada Serra"], "tag": "viagem serra 2026"}, False),
    ("tag_operations", {"ids": ["@op:Pousada Serra", "@op:Aluguel"], "tag": "VIAGEM SERRA 2026"}, True),
    ("tag_operations", {"ids": ["@op:Pousada Serra"], "tag": "Viagem Serra 2026", "remove": True}, True),
    ("tag_operations", {"ids": ["@op:Aluguel"], "tag": "Viagem Serra 2026", "remove": True}, False),
    ("tag_operations", {"ids": ["@op:Aluguel"], "tag": "   "}, False),
    ("tag_operations", {"ids": ["@op:Estorno duplicado"], "tag": "x"}, False),
    ("tag_operations", {"ids": ["@op:Aluguel"] * 3, "tag": "Repetido"}, True),
    ("name_merchant", {"description": "NETFLIX.COM", "name": "Netflix Brasil"}, True),
    ("name_merchant", {"description": "NETFLIX.COM", "name": "Netflix"}, False),
    ("name_merchant", {"description": "Padaria Real", "name": "  Padaria   do Bairro "}, True),
    ("name_merchant", {"description": "IFD*IFOOD", "name": "iFood"}, False),
    ("name_merchant", {"description": "Mercado Pão de Açúcar", "name": "Pão de Açúcar"}, True),
    ("create_category_rule", {"pattern": "ifood", "category": "Lazer"}, True),
    ("create_category_rule", {"pattern": "  Farmácia  ", "category": "Saúde"}, True),
    ("create_category_rule", {"pattern": "padaria", "category": "Alimentação"}, False),
    ("create_category_rule", {"pattern": "PADARIA", "category": "Lazer"}, False),
    ("create_category_rule", {"pattern": "a b", "category": "Lazer"}, True),
    ("create_category_rule", {"pattern": "   xy   ", "category": "Lazer"}, False),
    ("create_category_rule", {"pattern": "nova", "category": "Nada"}, False),
    ("set_budget", {"month": "2026-03", "category": "Lazer", "amount": "300,00"}, True),
    ("set_budget", {"month": "2026-03", "category": "Alimentação", "amount": "600.00"}, False),
    ("set_budget", {"month": "2026-03", "category": "Alimentação", "amount": "R$ 650,50"}, True),
    ("set_budget", {"month": "2026-04", "category": "Moradia", "amount": D("2400")}, True),
    ("set_budget", {"month": "2026-04", "category": "Moradia", "amount": 2400}, True),
    ("set_budget", {"month": "2026-04", "category": "Salário", "amount": "10"}, False),
    ("set_budget", {"month": "2026-04", "category": "Lazer", "amount": "0"}, False),
    ("set_budget", {"month": "2026-04", "category": "Lazer", "amount": "-5"}, False),
    ("set_budget", {"month": "2026-04", "category": "Lazer", "amount": "10.001"}, False),
    ("set_budget", {"month": "2026-04", "category": "Lazer", "amount": True}, False),
    ("set_budget", {"month": "2026-04", "category": "Lazer", "amount": [1]}, False),
    ("set_budget", {"month": "2026-04", "category": "Lazer", "amount": None}, False),
    ("set_budget", {"month": "2026-04", "category": "Lazer", "amount": "1e2"}, False),
    ("set_budget", {"month": "2026-04", "category": "Lazer", "amount": D("12.5")}, True),
    ("set_budget", {"month": "  ", "category": "Lazer", "amount": "10"}, False),
    ("set_budget", {"month": "abril", "category": "Lazer", "amount": "10"}, False),
    (
        "record_expense",
        {
            "account": "Banco A",
            "category": "Saúde",
            "amount": "R$ 1.234,56",
            "date": "2026-02-06",
            "description": "Exame",
        },
        True,
    ),
    (
        "record_expense",
        {
            "account": "banco a",
            "category": "Saúde",
            "amount": D("87.4"),
            "date": "2026-02-06",
            "description": "  Exame   de  sangue ",
        },
        True,
    ),
    (
        "record_expense",
        {"account": "Cartão X", "category": "Saúde", "amount": "1", "date": "2026-02-06", "description": "x"},
        False,
    ),
    (
        "record_expense",
        {"account": "Alimentação", "category": "Saúde", "amount": "1", "date": "2026-02-06", "description": "x"},
        False,
    ),
    (
        "record_expense",
        {"account": "Banco A", "category": "Salário", "amount": "1", "date": "2026-02-06", "description": "x"},
        False,
    ),
    (
        "record_expense",
        {"account": "Banco A", "category": "Saúde", "amount": "1", "date": "", "description": "x"},
        False,
    ),
    (
        "record_expense",
        {"account": "Banco A", "category": "Saúde", "amount": "1", "date": "2999-01-01", "description": "x"},
        False,
    ),
    (
        "record_expense",
        {"account": "Banco A", "category": "Saúde", "amount": "1", "date": "26-01-01", "description": "x"},
        False,
    ),
    (
        "record_expense",
        {
            "account": "Banco A",
            "category": "Saúde",
            "amount": "1",
            "date": "20260206",
            "description": "formato compacto",
        },
        True,
    ),
    (
        "record_expense",
        {"account": "Banco A", "category": "Saúde", "amount": "1", "date": "2026-W06-5", "description": "semana"},
        True,
    ),
    (
        "record_expense",
        {"account": "Inexistente", "category": "Saúde", "amount": "1", "date": "2026-02-06", "description": "x"},
        False,
    ),
    (
        "record_income",
        {
            "account": "Banco A",
            "category": "Salário",
            "amount": D("4000"),
            "date": "2026-02-05",
            "description": "Salário extra",
        },
        True,
    ),
    (
        "record_income",
        {
            "account": "Poupança",
            "category": "Salário",
            "amount": "10,05",
            "date": "2026-02-05",
            "description": "Rendimento",
        },
        True,
    ),
    (
        "record_income",
        {"account": "Banco A", "category": "Lazer", "amount": "10", "date": "2026-02-05", "description": "tipo errado"},
        False,
    ),
    (
        "record_income",
        {
            "account": "Conjunta",
            "category": "Salário",
            "amount": "1000000000000000000000000000000",
            "date": "2026-02-05",
            "description": "enorme",
        },
        False,
    ),
    ("set_import_item_category", {"item": "@item:0", "category": "Alimentação"}, True),
    ("set_import_item_category", {"item": "@item:1", "category": "Lazer"}, True),
    ("set_import_item_category", {"item": "@item:0", "category": "Nada"}, False),
    ("set_import_item_category", {"item": "zzzzzzzz", "category": "Lazer"}, False),
    ("set_import_item_category", {"item": "abc", "category": "Lazer"}, False),
    ("set_import_item_category", {"item": "@op:Aluguel", "category": "Lazer"}, False),
]


def run_edit(
    records: list[dict[str, Any]], today: date, name: str, args: dict[str, Any], do_apply: bool
) -> dict[str, Any]:
    import opesvault.assistant.edits as edits_mod

    ledger = fresh(records)
    known = known_ids(ledger)
    registry = Conversation().registry
    resolved = resolve(ledger, args)
    before = ledger.change_count
    out: dict[str, Any] = {}
    original = edits_mod.date
    edits_mod.date = type("FrozenDate", (date,), {"today": staticmethod(lambda: today)})  # type: ignore[misc,assignment]
    try:
        try:
            tool, parsed = registry.parse(name, resolved)
            assert tool.prepare is not None
            prepared = tool.prepare(ledger, parsed, ORIGIN)
        except ToolError as exc:
            return {"error": str(exc)}
        except Exception:
            return {"crash": True}
    finally:
        edits_mod.date = original  # type: ignore[misc]
    out["prepared"] = {"tool": prepared.tool, "summary": prepared.summary, "details": list(prepared.details)}
    out["untouched"] = ledger.change_count == before
    if do_apply:
        try:
            applied = enc(prepared.apply())
            if "id" in applied:
                applied["id"] = "<id>"  # the new operation's short id is random
            out["applied"] = applied
        except ToolError as exc:
            out["applied"] = {"error": str(exc)}
        except Exception:
            out["applied"] = {"crash": True}
        out["state"] = delta(state(ledger, known), state(fresh(records), known))
    return out


# ── conversations ───────────────────────────────────


def _turn(call_list: list[list[Any]], content: str) -> ModelTurn:
    calls = [(n, a) for n, a in call_list]
    raw = {
        "role": "assistant",
        "content": content,
        "tool_calls": [{"function": {"name": n, "arguments": a}} for n, a in calls],
    }
    return ModelTurn(content, tuple(ToolCall(n, a) for n, a in calls), raw)


def _text_calls(raw_calls: list[list[Any]]) -> list[list[Any]]:
    return [[n, dec(a)] for n, a in raw_calls]


def c(name: str, args: Any = None) -> list[Any]:
    return [name, enc(args) if not isinstance(args, str) else args]


SCRIPTS: dict[str, list[dict[str, Any]]] = {
    "a question answered with reads and an approved edit": [
        {"op": "ask", "text": "  Os Uber estão em Transporte?  "},
        {"op": "turn", "calls": [c("search_operations", {"text": "mercado"})]},
        {
            "op": "turn",
            "calls": [
                c(
                    "reclassify_operations",
                    {"ids": ["@op:Mercado Pão de Açúcar"], "category": "Transporte", "reason": "é corrida"},
                )
            ],
        },
        {"op": "resolve", "index": 0, "approved": True},
        {"op": "turn", "calls": [c("show_in_ledger", {"account": "Transporte"})]},
        {"op": "turn", "calls": [c("get_overview", {}), c("list_members", {})]},
        {"op": "turn", "calls": [], "content": "Pronto: 1 lançamento foi para Transporte."},
    ],
    "a refused edit": [
        {"op": "ask", "text": "orçamento"},
        {"op": "turn", "calls": [c("set_budget", {"month": "2026-03", "category": "Lazer", "amount": "300,00"})]},
        {"op": "resolve", "index": 0, "approved": False},
        {"op": "turn", "calls": [], "content": "Tudo bem."},
    ],
    "several edits in one answer": [
        {"op": "ask", "text": "x"},
        {
            "op": "turn",
            "calls": [
                c("tag_operations", {"ids": ["@op:Aluguel"], "tag": "Casa"}),
                c("set_budget", {"month": "2026-04", "category": "Moradia", "amount": 2400}),
                c("name_merchant", {"description": "Padaria Real", "name": "Padaria"}),
            ],
        },
        {"op": "resolve", "index": 0, "approved": True},
        {"op": "resolve", "index": 1, "approved": False},
        {"op": "resolve", "index": 2, "approved": True},
    ],
    "an edit that fails on apply": [
        {"op": "ask", "text": "x"},
        {
            "op": "turn",
            "calls": [
                c("reclassify_operations", {"ids": ["@op:Padaria Real"], "category": "Lazer", "reason": "lanche"})
            ],
        },
        {"op": "mutate", "cancel": "Padaria Real"},
        {"op": "resolve", "index": 0, "approved": True},
        {"op": "turn", "calls": [c("tag_operations", {"ids": ["@op:Aluguel"], "tag": "Casa"})]},
        {"op": "mutate", "tag": ["Aluguel", "Casa"]},
        {"op": "resolve", "index": 0, "approved": True},
    ],
    "wrong arguments go back to the model": [
        {"op": "ask", "text": "x"},
        {"op": "turn", "calls": [c("apagar_tudo", {})]},
        {"op": "turn", "calls": [c("search_operations", {"texto": "uber"})]},
        {"op": "turn", "calls": [c("get_overview", {}), c("set_budget", {"month": "2026-03", "category": "Lazer"})]},
        {"op": "turn", "calls": [c("set_budget", {"month": "2026-03", "category": "Lazer", "amount": D("0.5")})]},
        {"op": "turn", "calls": [c("search_operations", "{não é json")]},
        {"op": "turn", "calls": [c("get_operation", {"id": "zz"})]},
    ],
    "three invalid answers in a row interrupt and a valid one resets": [
        {"op": "ask", "text": "x"},
        {"op": "turn", "calls": [c("nope", {})]},
        {"op": "turn", "calls": [], "content": ""},
        {"op": "turn", "calls": [c("list_members", {})]},
        {"op": "turn", "calls": [], "content": '{"name": "list_members", "arguments": {}}'},
        {"op": "turn", "calls": [], "content": '```json\n{"name": "list_members"}'},
        {"op": "turn", "calls": [], "content": "  <tool_call>x"},
    ],
    "text that is not a tool call is an answer": [
        {"op": "ask", "text": "x"},
        {"op": "turn", "calls": [], "content": '{"nome": "x"}'},
        {"op": "ask", "text": "y"},
        {"op": "turn", "calls": [], "content": "[tool_call] but later"},
        {"op": "turn", "calls": [], "content": "  [Tool_Call"},
        {"op": "turn", "calls": [], "content": "Olá."},
        {"op": "turn", "calls": [], "content": "   "},
    ],
    "a question cannot loop forever": [{"op": "ask", "text": "x"}]
    + [{"op": "turn", "calls": [c("list_members", {})]}] * (MAX_STEPS + 1),
    "pending edits are dropped when the question is interrupted": [
        {"op": "ask", "text": "x"},
        {"op": "turn", "calls": [c("nope", {})]},
        {"op": "turn", "calls": [c("nope", {})]},
        {"op": "turn", "calls": [c("tag_operations", {"ids": ["@op:Aluguel"], "tag": "Casa"}), c("nope", {})]},
    ],
    "the context keeps a bounded number of messages": [
        step
        for n in range(MAX_MESSAGES)
        for step in (
            {"op": "ask", "text": f"pergunta {n}"},
            {"op": "turn", "calls": [c("list_members", {})]},
            {"op": "turn", "calls": [], "content": f"resposta {n}"},
        )
    ],
    "reset": [
        {"op": "ask", "text": "x"},
        {"op": "turn", "calls": [c("nope", {})]},
        {"op": "reset"},
        {"op": "ask", "text": "y"},
    ],
    "a malformed call": [
        {"op": "ask", "text": "x"},
        {"op": "turn", "calls": [["", None]]},
        {"op": "turn", "calls": [["list_members", None]]},
        {"op": "turn", "calls": [["list_members", "{}"]]},
        {"op": "turn", "calls": [["list_members", "[]"]]},
    ],
}


BRIEF = {"the context keeps a bounded number of messages"}


def _step_json(step: Any) -> Any:
    return {
        "answer": step.answer,
        "activity": step.activity,
        "pending": [[p.tool, p.edit.summary, list(p.edit.details)] for p in step.pending],
        "links": [[label, _link({"link": link})] for label, link in step.links],
        "stop": step.stop,
        "again": step.again,
    }


def run_script(
    records: list[dict[str, Any]], today: date, steps: list[dict[str, Any]], brief: bool = False
) -> list[dict[str, Any]]:
    import opesvault.assistant.edits as edits_mod
    import opesvault.assistant.reads as reads_mod

    ledger = fresh(records)
    known = known_ids(ledger)
    conversation = Conversation()
    pendings: list[Any] = []
    out: list[dict[str, Any]] = []
    frozen = type("FrozenDate", (date,), {"today": staticmethod(lambda: today)})
    saved = (reads_mod.date, edits_mod.date)
    reads_mod.date = frozen  # type: ignore[misc,assignment]
    edits_mod.date = frozen  # type: ignore[misc,assignment]
    try:
        for step in steps:
            entry: dict[str, Any] = {}
            match step["op"]:
                case "ask":
                    conversation.ask(step["text"])
                case "reset":
                    conversation.reset()
                case "turn":
                    resolved = [[n, resolve(ledger, dec(a)) if not isinstance(a, str) else a] for n, a in step["calls"]]
                    result = conversation.receive(_turn(resolved, step.get("content", "")), ledger, ORIGIN)
                    entry["step"] = _step_json(result)
                    pendings = list(result.pending)
                case "resolve":
                    entry["line"] = conversation.resolve(pendings[step["index"]], step["approved"])
                case "mutate":
                    if "cancel" in step:
                        op = next(o for o in ledger.operations.values() if o.description == step["cancel"])
                        ledger.cancel_operation(op.id, "mudou")
                    if "tag" in step:
                        from opesvault.domain import tags

                        op = next(o for o in ledger.operations.values() if o.description == step["tag"][0])
                        tags.add_tag(ledger, [op.id], step["tag"][1])
            if brief:
                entry["messages"] = [
                    len(conversation.messages),
                    enc(conversation.messages[0]),
                    enc(conversation.messages[-1]),
                ]
            else:
                entry["messages"] = enc(conversation.messages)
            entry["counters"] = [conversation.invalid, conversation.steps]
            entry["ledger_changes"] = ledger.change_count
            out.append(entry)
        if brief:
            out[-1]["all_messages"] = enc(conversation.messages)
        out[-1]["state"] = delta(state(ledger, known), state(fresh(records), known))
    finally:
        reads_mod.date, edits_mod.date = saved  # type: ignore[misc]
    return out


# ── the file ────────────────────────────────────────


def generate() -> dict[str, Any]:
    records, today_text = build()
    today = date.fromisoformat(today_text)
    ledger = fresh(records)
    registry = Conversation().registry
    return {
        "today": today_text,
        "records": records,
        "schemas": {
            "mcp": registry.mcp_list(),
            "ollama": registry.ollama_list(),
            "kinds": {t.name: t.kind.value for t in registry.tools.values()},
            "edit_descriptions_mention_approval": all(
                "aprovação" in t.description for t in registry.tools.values() if t.kind is ToolKind.EDIT
            ),
        },
        "constants": {"max_attempts": MAX_ATTEMPTS, "max_steps": MAX_STEPS, "max_messages": MAX_MESSAGES},
        "parse": parse_cases(),
        "reads": [{"tool": n, "args": a, "result": run_read(ledger, records, today, n, a)} for n, a in READ_CASES],
        "edits": [
            {"tool": n, "args": enc(a), "apply": ap, "result": run_edit(records, today, n, a, ap)}
            for n, a, ap in EDIT_CASES
        ],
        "conversations": [
            {
                "name": name,
                "steps": steps,
                "brief": name in BRIEF,
                "results": run_script(records, today, steps, name in BRIEF),
            }
            for name, steps in SCRIPTS.items()
        ],
    }
