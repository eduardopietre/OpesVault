"""investments/benchmarks.py: importing a local index series from CSV and its variation over a period.

Every CSV is given as bytes (base64); the outcome is the stored benchmark without its id (or the
error type and message) and the variation between every pair of its dates plus dates it lacks.
"""

import base64
from datetime import date
from typing import Any

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.investments import benchmarks as bench
from scripts.golden.common import j

CASES: list[tuple[str, str, bytes, str]] = [
    ("CDI", "arquivo do usuário", b"data;valor\n01/01/2026;100,00\n01/03/2026;102,00\n", "semicolon, header"),
    ("IPCA", "tabela", b"data,valor\n01/01/2026,100.50\n01/02/2026,101.25\n01/03/2026,101.9\n", "comma and dots"),
    ("Mixed", "x", b"01/01/2026;1.000,50\n01/02/2026;1.010,75\n15/02/2026;1.012,00\n", "thousand separators, no header"),
    ("Unsorted", "x", b"01/03/2026;110,00\n01/01/2026;100,00\n01/02/2026;105,00\n", "unsorted dates"),
    ("Duplicate", "x", b"01/01/2026;100,00\n01/01/2026;120,00\n01/02/2026;130,00\n", "a date twice: the last wins"),
    ("BOM", "x", "﻿data;valor\n01/01/2026;100,00\n01/02/2026;101,00\n".encode(), "utf-8 BOM"),
    ("Few", "x", b"data;valor\n01/01/2026;100,00\n", "a single point"),
    ("Empty", "x", b"", "empty file"),
    ("Header", "x", b"data;valor\n", "only a header"),
    ("Invalid dates", "x", b"data;valor\n31/02/2026;1,00\nabc;2,00\n01/01/2026;100,00\n02/01/2026;101,00\n", "bad dates"),
    ("Bad value", "x", b"data;valor\n01/01/2026;100,00\n01/02/2026;1,2,3\n", "unreadable level in BR format"),
    ("Bad plain", "x", b"data;valor\n01/01/2026;100,00\n01/02/2026;abc\n", "unreadable plain level"),
    ("NaN", "x", b"01/01/2026;100,00\n01/02/2026;NaN\n", "non-finite"),
    ("Infinity", "x", b"01/01/2026;100,00\n01/02/2026;Infinity\n", "non-finite"),
    ("Exponent", "x", b"01/01/2026;1e2\n01/02/2026;1.5E+2\n", "exponents as plain decimals"),
    ("Zero", "x", b"01/01/2026;0,00\n01/02/2026;5,00\n01/03/2026;6,00\n", "non positive start"),
    ("Negative", "x", b"01/01/2026;-3,00\n01/02/2026;5,00\n", "negative start"),
    ("Short rows", "x", b"01/01/2026\n01/01/2026;100,00\n;\n01/02/2026;101,00\nx\n", "rows without a value"),
    ("Quoted", "x", b'"01/01/2026";"100,00"\n"01/02/2026";"101,50"\n', "quoted fields"),
    ("CRLF", "x", b"data;valor\r\n01/01/2026;100,00\r\n01/02/2026;101,00\r\n", "windows line ends"),
    ("More columns", "x", b"data;valor;obs\n01/01/2026;100,00;a\n01/02/2026;101,00;b;c\n", "extra columns"),
    ("Latin1", "x", b"data;valor\n01/01/2026;100,00\n01/02/2026;101,00\n\xe7\xe3o;1\n", "not utf-8"),
    ("Tabs", "x", b"01/01/2026\t100,00\n01/02/2026\t101,00\n", "tab separated is not split (counts of ; and , tie)"),
    ("", "x", b"01/01/2026;100,00\n01/02/2026;101,00\n", "empty name"),
    ("N" * 121, "x", b"01/01/2026;100,00\n01/02/2026;101,00\n", "name too long"),
    ("Long source", "s" * 201, b"01/01/2026;100,00\n01/02/2026;101,00\n", "source too long"),
    ("Accents", "índice açúcar", "01/01/2026;100,00\n01/02/2026;101,00\n".encode(), "unicode names"),
    ("Wide", "x", b"01/01/2026;100,000000000000001\n01/02/2026;100,000000000000003\n", "many decimals"),
    ("Wide2", "x", b"01/01/2026;3,00\n01/02/2026;7,00\n01/03/2026;1,00\n", "division with a long fraction"),
]


def _entity(value: Any) -> Any:
    out = value.model_dump(mode="json")
    out.pop("id")
    return out


def generate() -> dict[str, Any]:
    cases = []
    for name, source, data, why in CASES:
        ledger = Ledger.new("Projeto")
        entry: dict[str, Any] = {"why": why, "name": name, "source": source, "csv": base64.b64encode(data).decode()}
        try:
            made = bench.import_benchmark_csv(ledger, name, data, source)
        except DomainError as exc:
            entry["outcome"] = {"error": type(exc).__name__, "message": str(exc)}
        except Exception as exc:
            entry["outcome"] = {"error": type(exc).__name__}
        else:
            entry["outcome"] = {"ok": _entity(made)}
            days = sorted({d for d, _ in made.points} | {date(2026, 1, 2), date(2025, 12, 31)})
            entry["returns"] = [
                {"start": j(a), "end": j(b), "result": j(bench.benchmark_return(made, a, b))}
                for a in days
                for b in days
            ]
            entry["stored"] = len(bench.benchmarks(ledger))
        cases.append(entry)
    return {"cases": cases}
