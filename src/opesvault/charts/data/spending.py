"""Where the money went: categories, comparisons, budget, tags and merchants."""

from collections import defaultdict
from datetime import date
from decimal import Decimal
from uuid import UUID

from opesvault.charts.data.model import Chart, Point, Series, month_name, months_between
from opesvault.domain import queries
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType, OperationKind, YearMonth
from opesvault.domain.money import ZERO


def expenses_by_category(ledger: Ledger, start: YearMonth, end: YearMonth) -> Chart:
    totals = queries.expenses_by_category(ledger, start, end)
    refunds: dict[UUID, Decimal] = defaultdict(lambda: ZERO)
    for op in ledger.active_operations():
        if op.kind is OperationKind.REFUND and op.competence and start <= op.competence <= end:
            for p in op.postings:
                if ledger.account(p.account_id).type is AccountType.EXPENSE:
                    refunds[p.account_id] += -p.amount
    ordered = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)
    points = [
        Point(
            ledger.account(cid).name,
            value,
            {"estornos no período": str(refunds[cid])} if refunds.get(cid) else {},
        )
        for cid, value in ordered
    ]
    return Chart(
        "Despesas por categoria",
        "BRL",
        [Series("Despesas", points)],
        ["Valores já líquidos de estornos."],
        "competência",
    )


def category_monthly(ledger: Ledger, category_id: UUID, start: YearMonth, end: YearMonth) -> Chart:
    """One expense category (with its sub-categories) month by month, by competence."""
    family = {category_id}
    grew = True
    while grew:  # sub-categories at any depth
        children = {a.id for a in ledger.accounts.values() if a.parent_id in family} - family
        family |= children
        grew = bool(children)
    points = []
    for month in months_between(start, end):
        totals = queries.expenses_by_category(ledger, month, month)
        value = sum((v for cid, v in totals.items() if cid in family), ZERO)
        points.append(Point(str(month), value, {"regime": "competência"}))
    name = ledger.account(category_id).name
    return Chart(
        f"Despesas: {name}",
        "BRL",
        [Series(name, points)],
        ["Competência; inclui as subcategorias. Valores já líquidos de estornos."],
        "competência",
    )


def category_comparison_chart(ledger: Ledger, month: YearMonth, window: int = 3) -> Chart:
    from opesvault.domain.comparisons import category_comparison

    rows = category_comparison(ledger, month, window)
    label_now = f"{month_name(month)}"
    current, average, last_year = [], [], []
    for row in rows:
        info = {}
        if row.change is not None:
            info["variação"] = f"{row.change * 100:+.0f}% sobre a média".replace(".", ",")
        current.append(Point(row.name, row.current, info))
        average.append(Point(row.name, row.average, {"meses na média": str(row.months_averaged)}))
        last_year.append(Point(row.name, row.last_year))
    notes = [f"Competência. Média dos {window} meses anteriores com registros; meses sem registros não entram."]
    if rows and rows[0].months_averaged < window:
        notes.append(f"Só {rows[0].months_averaged} mês(es) anterior(es) com registros.")
    return Chart(
        "Comparação com a média",
        "BRL",
        [
            Series(label_now, current),
            Series(f"Média de {window} meses", average),
            Series("Mesmo mês do ano anterior", last_year),
        ],
        notes,
        "competência",
    )


def budget_history(ledger: Ledger, start: YearMonth, end: YearMonth, category_id: UUID | None = None) -> Chart:
    """Planned against actual month by month, for the whole budget or one category."""
    from opesvault.domain.budget import status

    planned, actual = [], []
    for month in months_between(start, end):
        current = status(ledger, month)
        if category_id is None:
            plan: Decimal | None = current.total_planned if current.rows else None
            spent: Decimal | None = current.total_actual if current.rows else None
        else:
            row = next((r for r in current.rows if r.category_id == category_id), None)
            plan = row.planned if row else None
            spent = row.actual if row else None
        planned.append(Point(str(month), plan, {"situação": "sem orçamento"} if plan is None else {}))
        actual.append(Point(str(month), spent, {"regime": "competência"}))
    name = ledger.account(category_id).name if category_id else "Categorias com orçamento"
    return Chart(
        f"Orçamento mês a mês: {name}",
        "BRL",
        [Series("Planejado", planned), Series("Realizado", actual)],
        ["Meses sem orçamento ficam vazios, não zerados."],
        "competência",
    )


def tag_chart(ledger: Ledger, tag: str) -> Chart:
    from opesvault.domain.tags import summary

    found = summary(ledger, tag)
    ordered = sorted(found.by_category.items(), key=lambda kv: kv[1], reverse=True)
    points = [Point(ledger.account(cid).name, value) for cid, value in ordered if value]
    span = ""
    if found.first and found.last:
        span = f"De {found.first:%d/%m/%Y} a {found.last:%d/%m/%Y}. "
    return Chart(
        f"Marcador: {tag}",
        "BRL",
        [Series("Despesas", points)],
        [span + "Despesas líquidas de estornos, em qualquer mês."],
    )


def tags_overview(ledger: Ledger) -> Chart:
    from opesvault.domain.tags import summaries

    rows = summaries(ledger)
    return Chart(
        "Marcadores",
        "BRL",
        [
            Series("Despesas", [Point(s.tag, s.expense, {"lançamentos": str(len(s.operations))}) for s in rows]),
            Series("Receitas", [Point(s.tag, s.income) for s in rows], hidden=True),
        ],
        ["Cada marcador soma seus lançamentos em qualquer mês, com várias categorias."],
    )


def merchants_chart(ledger: Ledger, start: date, end: date, top: int = 15) -> Chart:
    """Expense per merchant (approved names, or the cleaned description), largest first."""
    from opesvault.domain.merchants import totals

    found = totals(ledger, start, end)
    shown = found[:top]
    rest = sum((m.expense for m in found[top:]), ZERO)
    points = [
        Point(m.name, m.expense, {"lançamentos": str(m.count), "nome": "aprovado" if m.approved else "da descrição"})
        for m in shown
    ]
    if rest:
        points.append(Point("Outros", rest, {"estabelecimentos": str(len(found) - top)}))
    return Chart(
        "Despesas por estabelecimento",
        "BRL",
        [Series("Despesas", points)],
        ["Nomes aprovados no Livro (Ações › Nomear estabelecimento); os demais vêm da descrição, limpa."],
    )
