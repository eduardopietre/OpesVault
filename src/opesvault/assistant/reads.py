"""Read tools: what the assistant may look up. They never change the ledger.

They return plain data (money and dates as text) with at most `MAX_ROWS` rows and the total,
so a long history does not overflow the model's context. Personal tax data (CPF, CNPJ) is not
reachable from here.
"""

from datetime import date
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from opesvault.assistant.tools import (
    MAX_ROWS,
    Registry,
    Tool,
    ToolError,
    ToolKind,
    account_label,
    day,
    find_account,
    find_member,
    find_operation,
    money,
    month,
    short_id,
)
from opesvault.domain import budget, merchants, queries, tags
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountSubtype, AccountType, Operation, YearMonth
from opesvault.domain.money import ZERO
from opesvault.domain.search import OperationFilter, StatusFilter, find_operations


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NoArgs(_Args):
    pass


class MonthArgs(_Args):
    month: str | None = Field(default=None, description="Mês AAAA-MM; sem ele, o mês do lançamento mais recente")


class PeriodArgs(_Args):
    start: str = Field(description="Primeiro mês, AAAA-MM")
    end: str | None = Field(default=None, description="Último mês, AAAA-MM; sem ele, o mesmo do início")


class CategoriesArgs(_Args):
    kind: Literal["despesa", "receita", "todas"] = Field(default="todas", description="Tipo de categoria")


class SearchArgs(_Args):
    text: str | None = Field(default=None, description="Trecho da descrição ou das observações")
    start: str | None = Field(default=None, description="Data inicial AAAA-MM-DD")
    end: str | None = Field(default=None, description="Data final AAAA-MM-DD")
    account: str | None = Field(default=None, description="Nome de uma conta, cartão ou categoria")
    member: str | None = Field(default=None, description="Nome de um integrante")
    tag: str | None = Field(default=None, description="Marcador")
    min_amount: str | None = Field(default=None, description="Valor mínimo, ex.: 100.00")
    max_amount: str | None = Field(default=None, description="Valor máximo, ex.: 500.00")
    status: Literal["ativos", "cancelados", "todos"] = Field(default="ativos")
    limit: int = Field(default=20, ge=1, le=MAX_ROWS, description=f"Quantos devolver (até {MAX_ROWS})")


class OperationArgs(_Args):
    id: str = Field(description="O 'id' de um lançamento, devolvido por search_operations")


class LimitArgs(_Args):
    limit: int = Field(default=20, ge=1, le=MAX_ROWS)


def latest_month(ledger: Ledger) -> YearMonth:
    dates = [d for op in ledger.active_operations() if (d := op.occurred_on or op.cash_date) is not None]
    return YearMonth.of(max(dates) if dates else date.today())


def _month_or_latest(ledger: Ledger, text: str | None) -> YearMonth:
    return month(text) or latest_month(ledger)


def amount_of(ledger: Ledger, op: Operation) -> Any:
    """The operation's size: what moved into categories, or else the largest posting."""
    categories = [
        p.amount
        for p in op.postings
        if ledger.account(p.account_id).subtype is AccountSubtype.CATEGORY
        and ledger.account(p.account_id).type is AccountType.EXPENSE
    ]
    if categories:
        return sum(categories, ZERO)
    income = [-p.amount for p in op.postings if ledger.account(p.account_id).type is AccountType.INCOME]
    if income:
        return sum(income, ZERO)
    return max((abs(p.amount) for p in op.postings), default=ZERO)


def operation_row(ledger: Ledger, op: Operation) -> dict[str, Any]:
    sources = [account_label(ledger, ledger.account(p.account_id)) for p in op.postings if p.amount < 0]
    targets = [account_label(ledger, ledger.account(p.account_id)) for p in op.postings if p.amount > 0]
    row: dict[str, Any] = {
        "id": short_id(op.id),
        "data": op.occurred_on or op.cash_date,
        "descricao": op.description,
        "valor": amount_of(ledger, op),
        "de": ", ".join(sources),
        "para": ", ".join(targets),
    }
    if not op.active:
        row["cancelado"] = True
    found = tags.tags_of(ledger, op.id)
    if found:
        row["marcadores"] = list(found)
    return row


# ── tools ───────────────────────────────────────────


def get_overview(ledger: Ledger, args: MonthArgs) -> dict[str, Any]:
    current = _month_or_latest(ledger, args.month)
    statement = queries.income_statement(ledger, current)
    from opesvault.importing import pipeline
    from opesvault.importing.model import ItemStatus

    pending = sum(1 for i in pipeline.items(ledger).values() if i.status in (ItemStatus.READY, ItemStatus.NEEDS_REVIEW))
    worth = queries.net_worth(ledger)
    return {
        "projeto": ledger.meta.family_name,
        "mes": current,
        "receitas_do_mes": statement.total_income,
        "despesas_do_mes": statement.total_expense,
        "resultado_do_mes": statement.result,
        "patrimonio_liquido": worth.net,
        "lancamentos": len(ledger.operations),
        "itens_importados_pendentes": pending,
        "integrantes": [m.name for m in ledger.members.values() if m.active],
    }


def list_accounts(ledger: Ledger, _args: NoArgs) -> dict[str, Any]:
    balances = queries.balances(ledger)
    rows = []
    for account in sorted(ledger.accounts.values(), key=lambda a: (a.type.value, a.name)):
        if account.subtype is AccountSubtype.CATEGORY or account.type is AccountType.EQUITY or account.archived:
            continue
        rows.append(
            {
                "nome": account.name,
                "tipo": account.subtype.value,
                "saldo": balances.get(account.id, ZERO),
            }
        )
    return {"contas": rows}


def list_categories(ledger: Ledger, args: CategoriesArgs) -> dict[str, Any]:
    kinds = {
        "despesa": (AccountType.EXPENSE,),
        "receita": (AccountType.INCOME,),
        "todas": (AccountType.EXPENSE, AccountType.INCOME),
    }[args.kind]
    out: dict[str, list[str]] = {}
    for kind in kinds:
        label = "despesa" if kind is AccountType.EXPENSE else "receita"
        out[label] = sorted(account_label(ledger, a) for a in ledger.categories(kind))
    return out


def list_members(ledger: Ledger, _args: NoArgs) -> dict[str, Any]:
    return {"integrantes": [{"nome": m.name, "papel": m.role.value} for m in ledger.members.values() if m.active]}


def search_operations(ledger: Ledger, args: SearchArgs) -> dict[str, Any]:
    account_id: UUID | None = find_account(ledger, args.account).id if args.account else None
    member_id = find_member(ledger, args.member) if args.member else None
    restrict = None
    if args.tag:
        restrict = frozenset(tags.operations_with(ledger, args.tag))
    low = money(args.min_amount, "valor mínimo") if args.min_amount else None
    high = money(args.max_amount, "valor máximo") if args.max_amount else None
    status = {"ativos": StatusFilter.ACTIVE, "cancelados": StatusFilter.CANCELLED, "todos": StatusFilter.ALL}
    flt = OperationFilter(
        start=day(args.start, "data inicial"),
        end=day(args.end, "data final"),
        account_id=account_id,
        member_id=member_id,
        text=args.text or "",
        status=status[args.status],
        operation_ids=restrict,
    )
    found = find_operations(ledger, flt)
    if low is not None or high is not None:
        found = [
            op
            for op in found
            if (low is None or amount_of(ledger, op) >= low) and (high is None or amount_of(ledger, op) <= high)
        ]
    rows = [operation_row(ledger, op) for op in found[: args.limit]]
    return {"total": len(found), "mostrando": len(rows), "lancamentos": rows}


def get_operation(ledger: Ledger, args: OperationArgs) -> dict[str, Any]:
    op = find_operation(ledger, args.id)
    row = operation_row(ledger, op)
    row["partidas"] = [
        {"conta": account_label(ledger, ledger.account(p.account_id)), "valor": p.amount} for p in op.postings
    ]
    row["estabelecimento"] = merchants.merchant_of(ledger, op.description)
    row["competencia"] = op.competence
    if op.notes:
        row["observacoes"] = op.notes
    row["versoes"] = len(ledger.history_of(op.id))
    return row


def spending_by_category(ledger: Ledger, args: PeriodArgs) -> dict[str, Any]:
    start = month(args.start, "mês inicial")
    end = month(args.end, "mês final") or start
    if start is None or end is None:
        raise ToolError("Informe o mês inicial, AAAA-MM.")
    if end < start:
        raise ToolError("O mês final vem antes do inicial.")
    totals = queries.expenses_by_category(ledger, start, end)
    rows = sorted(
        ({"categoria": account_label(ledger, ledger.account(k)), "total": v} for k, v in totals.items() if v),
        key=lambda r: r["total"],
        reverse=True,
    )
    return {"de": start, "ate": end, "total": sum((r["total"] for r in rows), ZERO), "categorias": rows[:MAX_ROWS]}


def month_summary(ledger: Ledger, args: MonthArgs) -> dict[str, Any]:
    current = _month_or_latest(ledger, args.month)
    statement = queries.income_statement(ledger, current)

    def named(values: dict[UUID, Any]) -> list[dict[str, Any]]:
        rows = [{"categoria": account_label(ledger, ledger.account(k)), "total": v} for k, v in values.items() if v]
        return sorted(rows, key=lambda r: r["total"], reverse=True)[:10]

    return {
        "mes": current,
        "receitas": statement.total_income,
        "despesas": statement.total_expense,
        "resultado": statement.result,
        "maiores_despesas": named(statement.expense),
        "receitas_por_categoria": named(statement.income),
    }


def budget_status(ledger: Ledger, args: MonthArgs) -> dict[str, Any]:
    current = _month_or_latest(ledger, args.month)
    found = budget.status(ledger, current)
    return {
        "mes": current,
        "planejado": found.total_planned,
        "gasto_planejado": found.total_actual,
        "gasto_sem_plano": found.unbudgeted,
        "linhas": [
            {
                "categoria": account_label(ledger, ledger.account(r.category_id)),
                "planejado": r.planned,
                "gasto": r.actual,
                "restante": r.remaining,
                "situacao": r.state.value,
            }
            for r in found.rows
        ],
    }


def list_tags(ledger: Ledger, _args: NoArgs) -> dict[str, Any]:
    return {
        "marcadores": [
            {"nome": s.tag, "lancamentos": len(s.operations), "despesas": s.expense}
            for s in tags.summaries(ledger)[:MAX_ROWS]
        ]
    }


def list_rules(ledger: Ledger, _args: NoArgs) -> dict[str, Any]:
    from opesvault.importing import rules

    rows = []
    for rule in rules.rules(ledger).values():
        target = ledger.accounts.get(rule.target_account_id)
        rows.append(
            {
                "contem": rule.pattern,
                "categoria": account_label(ledger, target) if target else "?",
                "ativa": rule.active,
            }
        )
    return {"regras": rows[:MAX_ROWS], "total": len(rows)}


def list_pending_import_items(ledger: Ledger, args: LimitArgs) -> dict[str, Any]:
    from opesvault.importing import pipeline
    from opesvault.importing.model import ItemStatus

    pending = [i for i in pipeline.items(ledger).values() if i.status in (ItemStatus.READY, ItemStatus.NEEDS_REVIEW)]
    pending.sort(key=lambda i: (i.occurred_on or date.min, i.description))
    rows = []
    for item in pending[: args.limit]:
        target = ledger.accounts.get(item.target_account_id) if item.target_account_id else None
        rows.append(
            {
                "id": short_id(item.id),
                "data": item.occurred_on,
                "descricao": item.description,
                "valor": item.amount,
                "categoria": account_label(ledger, target) if target else None,
            }
        )
    return {"total": len(pending), "itens": rows}


def merchant_totals(ledger: Ledger, args: PeriodArgs) -> dict[str, Any]:
    start = month(args.start, "mês inicial")
    end = month(args.end, "mês final") or start
    if start is None or end is None:
        raise ToolError("Informe o mês inicial, AAAA-MM.")
    rows = merchants.totals(ledger, start.first_day(), end.last_day())
    return {
        "estabelecimentos": [{"nome": m.name, "despesas": m.expense, "lancamentos": m.count} for m in rows[:MAX_ROWS]]
    }


class ShowArgs(_Args):
    account: str | None = Field(default=None, description="Conta, cartão ou categoria a filtrar")
    tag: str | None = Field(default=None, description="Marcador a filtrar")
    start: str | None = Field(default=None, description="Data inicial AAAA-MM-DD")
    end: str | None = Field(default=None, description="Data final AAAA-MM-DD")


def show_in_ledger(ledger: Ledger, args: ShowArgs) -> dict[str, Any]:
    """Not an edit: offers the user a button that opens the Livro with these filters."""
    if args.tag:
        if args.tag not in tags.all_tags(ledger):
            raise ToolError(f"Não existe o marcador '{args.tag}'. Consulte list_tags.")
        return {"link": ("tag", args.tag), "rotulo": f"marcador {args.tag}"}
    if not args.account:
        raise ToolError("Informe a conta, a categoria ou o marcador a mostrar.")
    account = find_account(ledger, args.account)
    start, end = day(args.start, "data inicial"), day(args.end, "data final")
    period = (start, end) if start and end else None
    label = account_label(ledger, account)
    if period:
        label += f", de {start:%d/%m/%Y} a {end:%d/%m/%Y}"
    return {"link": ("filter", account.id, period), "rotulo": label}


READS: tuple[tuple[str, str, type[_Args], Any], ...] = (
    (
        "get_overview",
        "Resumo do projeto: integrantes, receitas, despesas e resultado de um mês, patrimônio e pendências.",
        MonthArgs,
        get_overview,
    ),
    ("list_accounts", "Contas, cartões e investimentos com o saldo atual.", NoArgs, list_accounts),
    ("list_categories", "Nomes das categorias de despesa e de receita.", CategoriesArgs, list_categories),
    ("list_members", "Integrantes do projeto.", NoArgs, list_members),
    (
        "search_operations",
        "Procura lançamentos com filtros (texto, período, conta ou categoria, integrante, marcador, valor). "
        "Devolve o total encontrado e os mais recentes primeiro, cada um com seu 'id'.",
        SearchArgs,
        search_operations,
    ),
    (
        "get_operation",
        "Detalhes de um lançamento pelo 'id': partidas, competência, versões.",
        OperationArgs,
        get_operation,
    ),
    ("spending_by_category", "Total de despesas por categoria num período de meses.", PeriodArgs, spending_by_category),
    ("month_summary", "Receitas, despesas e resultado de um mês, com as maiores categorias.", MonthArgs, month_summary),
    ("budget_status", "Orçamento de um mês: planejado, gasto e restante por categoria.", MonthArgs, budget_status),
    ("list_tags", "Marcadores com quantos lançamentos e quanto de despesa cada um tem.", NoArgs, list_tags),
    ("list_rules", "Regras de categoria (a descrição contém… → categoria).", NoArgs, list_rules),
    (
        "list_pending_import_items",
        "Itens importados que ainda aguardam revisão, com a categoria sugerida.",
        LimitArgs,
        list_pending_import_items,
    ),
    ("merchant_totals", "Despesas por estabelecimento num período de meses.", PeriodArgs, merchant_totals),
    (
        "show_in_ledger",
        "Oferece ao usuário um botão que abre o Livro financeiro filtrado por conta, categoria ou marcador "
        "(e período). Não muda nada.",
        ShowArgs,
        show_in_ledger,
    ),
)


def register(registry: Registry) -> None:
    for name, description, args, run in READS:
        registry.add(Tool(name, description, args, ToolKind.READ, run=run))
