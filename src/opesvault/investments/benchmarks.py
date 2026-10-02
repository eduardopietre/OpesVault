"""Local benchmark series (docs/06 §5): imported from a file, never fetched online."""

import csv
import io
from datetime import date
from decimal import Decimal
from uuid import UUID

from pydantic import Field

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import Amount, _Entity
from opesvault.domain.money import parse_brl, to_decimal
from opesvault.importing.parsers.base import dmy
from opesvault.investments.performance import Quality, Result, unavailable


class Benchmark(_Entity):
    name: str = Field(min_length=1, max_length=120)
    currency: str = "BRL"
    points: tuple[tuple[date, Amount], ...]  # index level by date
    source: str = Field(default="arquivo importado", max_length=200)


Ledger.register_kind("benchmark", Benchmark)


def benchmarks(ledger: Ledger) -> dict[UUID, Benchmark]:
    return ledger.entities("benchmark")


def import_benchmark_csv(ledger: Ledger, name: str, data: bytes, source: str) -> Benchmark:
    """CSV with 'data;valor' (dd/mm/aaaa; index level in Brazilian format)."""
    text = data.decode("utf-8-sig", errors="strict")
    delimiter = ";" if text.count(";") >= text.count(",") else ","
    points: dict[date, Decimal] = {}
    for row in csv.reader(io.StringIO(text), delimiter=delimiter):
        if len(row) < 2:
            continue
        when = dmy(row[0])
        if when is None:
            continue  # header or invalid line
        try:
            level = parse_brl(row[1]) if "," in row[1] else to_decimal(row[1])
        except ValueError:
            raise DomainError(f"Valor inválido na linha de {row[0]}.") from None
        points[when] = level
    if len(points) < 2:
        raise DomainError("O arquivo precisa de ao menos duas datas com valores.")
    return ledger.put("benchmark", Benchmark(name=name, points=tuple(sorted(points.items())), source=source))


def benchmark_return(benchmark: Benchmark, start: date, end: date) -> Result:
    method = f"variação do índice {benchmark.name} ({benchmark.source})"
    levels = dict(benchmark.points)
    if start not in levels or end not in levels:
        return unavailable(
            method, "A série local não tem valores exatamente nas datas do período.", start, end, "ratio"
        )
    if levels[start] <= 0:
        return unavailable(method, "Nível inicial não positivo.", start, end, "ratio")
    return Result(
        levels[end] / levels[start] - 1, "ratio", method, start, end, Quality.OBSERVED, ("mesma moeda e período",)
    )
