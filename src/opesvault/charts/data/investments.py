"""Investments: evolution with flows, accumulated result, composition and returns by method."""

from datetime import date
from uuid import UUID

from opesvault.charts.data.model import Chart, Point, Series
from opesvault.domain.ledger import Ledger


def investment_evolution(ledger: Ledger, position_id: UUID) -> Chart:
    from opesvault.investments.model import NATURE_LABELS, EventKind, ValueNature
    from opesvault.investments.performance import selected_series
    from opesvault.investments.service import events_of

    series = []
    for nature in ValueNature:
        points = [
            Point(v.on, v.value, {"natureza": NATURE_LABELS[v.nature], "fonte": v.source, "origem": "observado"})
            for v in selected_series(ledger, position_id, nature)
        ]
        if points:
            series.append(Series(f"Valor {NATURE_LABELS[nature].lower()}", points, style="line", marker_points=True))
    labels = {EventKind.CONTRIBUTION: "Aporte", EventKind.WITHDRAWAL: "Resgate", EventKind.DISTRIBUTION: "Provento"}
    for kind, label in labels.items():
        markers = [
            Point(e.on, e.gross if e.gross is not None else e.net, {"evento": label, "qualidade": e.quality.value})
            for e in events_of(ledger, position_id)
            if e.kind is kind
        ]
        if markers:
            series.append(Series(label, markers, style="scatter"))
    return Chart(
        "Evolução do investimento",
        "BRL",
        series,
        ["Linhas ligam observações; não são preços diários. Bruto e líquido em séries separadas."],
    )


def investment_result(ledger: Ledger, position_id: UUID) -> Chart:
    """Cumulative monetary result at each observed date: capital contributed never counts as gain."""
    from opesvault.investments.model import ValueNature
    from opesvault.investments.performance import period_result, selected_series

    points = []
    gross = selected_series(ledger, position_id, ValueNature.GROSS)
    if gross:
        first = gross[0]
        for v in gross:
            result = period_result(ledger, position_id, first.on, v.on)
            points.append(Point(v.on, result.value, {"método": result.method, "qualidade": result.quality.value}))
    return Chart(
        "Resultado acumulado do investimento", "BRL", [Series("Resultado", points, style="line", marker_points=True)]
    )


def portfolio_composition(ledger: Ledger, at: date) -> Chart:
    from opesvault.investments.model import ASSET_CLASS_LABELS
    from opesvault.investments.performance import composition
    from opesvault.investments.service import assets, position

    portfolio = composition(ledger, at)
    points = []
    for line in portfolio.lines:
        pos = position(ledger, line.position_id)
        asset = assets(ledger)[pos.asset_id]
        info = {"classe": ASSET_CLASS_LABELS[asset.asset_class]}
        if line.as_of:
            info["data-base"] = f"{line.as_of:%d/%m/%Y} ({line.age_days} dias)"
        else:
            info["situação"] = "sem avaliação"
        points.append(Point(asset.name, line.value, info))
    notes = [f"Data-base {at:%d/%m/%Y}; último valor conhecido até a data."]
    if portfolio.partial:
        notes.append("Total parcial: há ativos sem avaliação.")
    return Chart("Composição da carteira", "BRL", [Series("Valor", points)], notes)


def returns_chart(ledger: Ledger, position_id: UUID, start: date, end: date) -> Chart:
    """Percentages by method; unavailable methods appear in notes with their reason, never as zero."""
    from opesvault.investments.returns import all_methods

    points, notes = [], []
    for result in all_methods(ledger, position_id, start, end):
        label = result.method.split(" (")[0]
        if result.value is None:
            notes.append(f"{label}: indisponível — {result.notes[0] if result.notes else ''}")
        points.append(
            Point(
                label,
                result.value,
                {
                    "método": result.method,
                    "qualidade": result.quality.value,
                    **({"notas": "; ".join(result.notes)} if result.notes else {}),
                },
            )
        )
    return Chart(f"Rentabilidade {start:%d/%m/%Y} a {end:%d/%m/%Y}", "%", [Series("Retorno", points)], notes)
