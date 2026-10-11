"""The chart model: points, series, a chart with its provenance, and the table of values behind it."""

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from opesvault.domain.model import YearMonth
from opesvault.domain.money import ZERO, round_money


@dataclass(frozen=True)
class Point:
    x: date | str
    y: Decimal | None
    info: dict[str, str] = field(default_factory=dict)  # tooltip: origin, nature, method, quality…


@dataclass
class Series:
    name: str
    points: list[Point]
    style: str = "bar"  # bar, line, scatter, step, forecast
    marker_points: bool = False
    hidden: bool = False  # only in the table of values, not drawn (keeps the chart readable)
    # Whether a total over the rows means something: flows (bars) add up, positions (lines) do not.
    summable: bool | None = None
    # "right": drawn against a second scale (a loan's installment beside its balance), so a small
    # series is not flattened by a large one
    axis: str = "left"

    @property
    def adds_up(self) -> bool:
        return self.summable if self.summable is not None else self.style in ("bar", "forecast")


@dataclass
class Chart:
    title: str
    unit: str  # "BRL" or "%"
    series: list[Series]
    notes: list[str] = field(default_factory=list)
    regime: str | None = None


def months_between(start: YearMonth, end: YearMonth) -> list[YearMonth]:
    out, cursor = [], start
    while cursor <= end:
        out.append(cursor)
        cursor = cursor.add(1)
    return out


@dataclass(frozen=True)
class TableRow:
    x: date | str | None  # None for the summary rows
    label: str
    values: list[Decimal | None]


def table_rows(chart: Chart) -> tuple[list[str], list[TableRow]]:
    """The chart's numbers as rows (one per x) and columns (one per series, hidden ones included).

    Monthly charts get "Total" and "Média" rows for the series that add up (flows); positions
    such as balances never get a total. Unknown values stay None.
    """
    xs: list[date | str] = []
    for series in chart.series:
        for point in series.points:
            if point.x not in xs:
                xs.append(point.x)
    if all(isinstance(x, date) for x in xs):
        xs.sort()  # type: ignore[call-overload]
    lookup = [{p.x: p.y for p in s.points} for s in chart.series]
    rows = [TableRow(x, str(x), [values.get(x) for values in lookup]) for x in xs]
    monthly = bool(xs) and all(isinstance(x, str) and _is_month(x) for x in xs)
    summable = [s.adds_up for s in chart.series]
    if monthly and len(rows) > 1 and any(summable) and chart.unit == "BRL":
        totals: list[Decimal | None] = []
        averages: list[Decimal | None] = []
        for column, adds in enumerate(summable):
            known = [r.values[column] for r in rows if r.values[column] is not None]
            if not adds or not known:
                totals.append(None)
                averages.append(None)
                continue
            total = sum((v for v in known if v is not None), ZERO)
            totals.append(total)
            averages.append(round_money(total / len(known)))
        rows.append(TableRow(None, "Total", totals))
        rows.append(TableRow(None, "Média", averages))
    return [s.name for s in chart.series], rows


def _is_month(text: str) -> bool:
    try:
        YearMonth.parse(text)
    except (ValueError, TypeError):
        return False
    return True


def month_name(month: YearMonth) -> str:
    names = ("jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez")
    return f"{names[month.month - 1]}/{month.year}"
