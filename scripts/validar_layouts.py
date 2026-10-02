"""Validate parsers against a PRIVATE corpus of real documents (phase 7, docs/08 §7).

The corpus lives outside the repository (ideally on an encrypted volume). Next to each
document `X.pdf|csv|ofx` sits `X.esperado.json`, written or reviewed by a person:

    {
      "conferido": true,                 # only reviewed files count towards validation
      "layout": "nubank-cartao-pdf",
      "cabecalho": {"due_on": "2026-02-10", "total": "1050.30"},   # only listed fields are checked
      "itens": [
        {"data": "2026-01-05", "descricao": "Mercado", "valor": "100.00", "tipo": "purchase", "parcela": [1, 3]}
      ]
    }

Usage:
    uv run python scripts/validar_layouts.py CORPUS_DIR                  # report
    uv run python scripts/validar_layouts.py CORPUS_DIR --detalhes       # show differing values
    uv run python scripts/validar_layouts.py CORPUS_DIR --gerar-esperado # drafts for files without one

By default the report names fields and item positions only, not values, so it can be
shared. PDF passwords are asked interactively and never stored.
"""

import argparse
import getpass
import json
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from opesvault.importing.parsers.base import ParsedItem, ParseResult  # noqa: E402
from opesvault.importing.pipeline import ParseFailed, choose_parser, run_parser  # noqa: E402
from opesvault.importing.source import Source, SourceError, SourceProblem, load_source  # noqa: E402

DOCUMENT_SUFFIXES = (".pdf", ".csv", ".ofx", ".txt")
EXPECTED_SUFFIX = ".esperado.json"
REQUIRED_DOCUMENTS = 3  # per layout version, docs/09 §1.2 (phase 7)
HEADER_FIELDS = (
    "due_on",
    "closing_on",
    "total",
    "previous_balance",
    "opening_balance",
    "closing_balance",
    "period_start",
    "period_end",
    "trade_date",
    "settlement_date",
    "net_amount",
    "note_number",
)


@dataclass
class DocumentReport:
    name: str
    reviewed: bool
    layout_expected: str | None
    layout_found: str | None
    version: str | None
    problems: list[str] = field(default_factory=list)
    details: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems


def _norm_text(text: str) -> str:
    return " ".join(text.casefold().split())


def _item_key(data: Any, value: Any, kind: Any, installment: Any) -> tuple[str, str, str, str]:
    amount = "" if value is None else str(Decimal(str(value)).quantize(Decimal("0.01")))
    parts = "" if not installment else f"{installment[0]}/{installment[1]}"
    return (str(data or ""), amount, str(kind or ""), parts)


def item_to_json(item: ParsedItem) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "data": item.occurred_on.isoformat() if item.occurred_on else None,
        "descricao": item.description,
        "valor": None if item.amount is None else str(item.amount),
        "tipo": item.kind.value,
    }
    if item.installment:
        entry["parcela"] = list(item.installment)
    return entry


def _header_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value.quantize(Decimal("0.01")))
    return str(value)


def compare(expected: dict[str, Any], parser_id: str | None, result: ParseResult | None) -> tuple[list[str], list[str]]:
    """Returns (problems without values, details with values)."""
    problems: list[str] = []
    details: list[str] = []
    if expected.get("layout") and expected["layout"] != parser_id:
        problems.append(f"layout detectado {parser_id or 'nenhum'}, esperado {expected['layout']}")
        return problems, details
    if result is None:
        problems.append("documento não interpretado")
        return problems, details
    for name, want in (expected.get("cabecalho") or {}).items():
        if name not in HEADER_FIELDS:
            problems.append(f"campo de cabeçalho desconhecido no esperado: {name}")
            continue
        got = _header_value(getattr(result.header, name))
        want_norm = (
            _header_value(Decimal(str(want))) if name.endswith(("total", "balance", "amount")) and want else want
        )
        if got != want_norm:
            problems.append(f"cabeçalho.{name} diverge")
            details.append(f"cabeçalho.{name}: obtido {got!r}, esperado {want_norm!r}")
    want_items = expected.get("itens") or []
    want_keys = Counter(_item_key(i.get("data"), i.get("valor"), i.get("tipo"), i.get("parcela")) for i in want_items)
    got_keys = Counter(
        _item_key(i.occurred_on.isoformat() if i.occurred_on else None, i.amount, i.kind.value, i.installment)
        for i in result.items
    )
    missing, extra = want_keys - got_keys, got_keys - want_keys
    if missing:
        problems.append(f"{sum(missing.values())} item(ns) esperado(s) não extraído(s)")
        details += [f"faltando: {k}" for k in missing.elements()]
    if extra:
        problems.append(f"{sum(extra.values())} item(ns) extraído(s) a mais")
        details += [f"a mais: {k}" for k in extra.elements()]
    # Descriptions: compared per matching key, ignoring case and spacing.
    by_key: dict[tuple[str, str, str, str], list[str]] = defaultdict(list)
    for item in result.items:
        key = _item_key(
            item.occurred_on.isoformat() if item.occurred_on else None, item.amount, item.kind.value, item.installment
        )
        by_key[key].append(_norm_text(item.description))
    for index, want in enumerate(want_items, start=1):
        key = _item_key(want.get("data"), want.get("valor"), want.get("tipo"), want.get("parcela"))
        if want.get("descricao") and by_key.get(key) and _norm_text(want["descricao"]) not in by_key[key]:
            problems.append(f"descrição do item {index} diverge")
            details.append(f"item {index}: esperado {want['descricao']!r}, obtido {by_key[key]!r}")
    if result.unmapped:
        details.append(f"{len(result.unmapped)} linha(s) não mapeada(s)")
    return problems, details


def _load(path: Path, ask_password: bool) -> Source:
    data = path.read_bytes()
    try:
        return load_source(path.name, data)
    except SourceError as exc:
        if exc.problem is not SourceProblem.PASSWORD_REQUIRED or not ask_password:
            raise
    password = getpass.getpass(f"Senha do PDF {path.name} (não será guardada): ")
    try:
        return load_source(path.name, data, password)
    finally:
        del password


def check_document(path: Path, ask_password: bool = True) -> DocumentReport:
    expected_path = path.with_name(path.stem + EXPECTED_SUFFIX)
    expected = json.loads(expected_path.read_text("utf-8")) if expected_path.exists() else {}
    report = DocumentReport(path.name, bool(expected.get("conferido")), expected.get("layout"), None, None)
    if not expected:
        report.problems.append("sem arquivo .esperado.json")
    try:
        source = _load(path, ask_password)
    except SourceError as exc:
        report.problems.append(f"arquivo não lido ({exc.problem.value})")
        return report
    # Detection is part of what is validated: the import itself does not force a layout.
    parser, candidates = choose_parser(source)
    if parser is None and candidates:
        report.problems.append(f"detecção ambígua entre {', '.join(candidates)}")
    result = None
    if parser is not None:
        report.layout_found, report.version = parser.id, parser.version
        try:
            result = run_parser(parser, source)
        except ParseFailed:
            result = None
    if expected:
        problems, details = compare(expected, report.layout_found, result)
        report.problems += problems
        report.details += details
    return report


def draft_expected(path: Path) -> Path | None:
    target = path.with_name(path.stem + EXPECTED_SUFFIX)
    if target.exists():
        return None
    source = _load(path, ask_password=True)
    parser, _ = choose_parser(source)
    draft: dict[str, Any] = {"conferido": False, "layout": parser.id if parser else None, "cabecalho": {}, "itens": []}
    if parser is not None:
        result = run_parser(parser, source)
        draft["cabecalho"] = {
            name: _header_value(getattr(result.header, name))
            for name in HEADER_FIELDS
            if getattr(result.header, name) is not None
        }
        draft["itens"] = [item_to_json(item) for item in result.items]
    target.write_text(json.dumps(draft, ensure_ascii=False, indent=2), "utf-8")
    return target


def summarize(reports: list[DocumentReport]) -> list[str]:
    lines = []
    by_layout: dict[tuple[str, str], list[DocumentReport]] = defaultdict(list)
    for report in reports:
        if report.layout_found:
            by_layout[(report.layout_found, report.version or "?")].append(report)
    for (layout, version), group in sorted(by_layout.items()):
        passing = [r for r in group if r.ok and r.reviewed]
        verdict = (
            "pronto para validated_with_real_documents"
            if len(passing) >= REQUIRED_DOCUMENTS
            else f"faltam {REQUIRED_DOCUMENTS - len(passing)} documento(s) conferido(s) sem divergência"
        )
        lines.append(f"{layout} v{version}: {len(passing)}/{len(group)} aprovados — {verdict}")
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("corpus", type=Path)
    parser.add_argument("--detalhes", action="store_true", help="mostra valores divergentes (não compartilhe)")
    parser.add_argument("--gerar-esperado", action="store_true", help="cria rascunhos para conferência humana")
    args = parser.parse_args()
    documents = sorted(p for p in args.corpus.rglob("*") if p.suffix.lower() in DOCUMENT_SUFFIXES and p.is_file())
    if not documents:
        print("Nenhum documento encontrado.")
        return 1
    if args.gerar_esperado:
        for path in documents:
            created = draft_expected(path)
            if created:
                print(f'rascunho criado: {created.name} (confira e marque "conferido": true)')
        return 0
    reports = [check_document(path) for path in documents]
    for report in reports:
        status = "OK " if report.ok else "ERR"
        reviewed = "" if report.reviewed else " (não conferido)"
        print(f"[{status}] {report.name} — {report.layout_found or 'sem layout'}{reviewed}")
        for problem in report.problems:
            print(f"      - {problem}")
        if args.detalhes:
            for detail in report.details:
                print(f"        · {detail}")
    print()
    for line in summarize(reports):
        print(line)
    return 0 if all(r.ok for r in reports) else 1


if __name__ == "__main__":
    sys.exit(main())
