"""Deliberate exports (RF-20). Outputs are plain files outside the vault's protection.

Interchange format (version 1, docs/13 §5):
- UTF-8 JSON; decimals as strings with '.' separator and full precision;
- dates ISO 8601 (YYYY-MM-DD), instants with explicit offset;
- every entity keeps its stable UUID; documents' bytes are not included.
"""

import csv
import io
import json
import re
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from opesvault.domain.ledger import Ledger

INTERCHANGE_FORMAT = "opesvault-intercambio"
INTERCHANGE_VERSION = 1

LEDGER_COLUMNS = (
    "operacao_id",
    "versao",
    "situacao",
    "tipo",
    "descricao",
    "data_ocorrencia",
    "data_caixa",
    "competencia",
    "conta",
    "tipo_conta",
    "valor",
    "moeda",
    "integrante_rateio",
    "origem",
)


# Cells a spreadsheet would read as a formula (OWASP's CSV injection list: '=', '+', '-', '@', tab, CR).
_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")
_PLAIN_NUMBER = re.compile(r"[+-]?\d+(\.\d+)?")


def spreadsheet_text(text: str) -> str:
    """A free-text cell (description, name) a spreadsheet will not run: a leading "'" when it could be a formula."""
    return "'" + text if text.startswith(_FORMULA_START) else text


def spreadsheet_cell(text: str) -> str:
    """A cell that may hold a number or text: a plain number (like '-1485.00') is kept, anything else is guarded."""
    return text if _PLAIN_NUMBER.fullmatch(text) else spreadsheet_text(text)


def ledger_csv(ledger: Ledger) -> bytes:
    """One row per posting (debit positive, credit negative), so totals re-balance in any spreadsheet."""
    out = io.StringIO()
    writer = csv.writer(out, delimiter=";", lineterminator="\n")
    writer.writerow(LEDGER_COLUMNS)
    members = {m.id: m.name for m in ledger.members.values()}
    for op in sorted(
        ledger.operations.values(), key=lambda o: (o.cash_date or o.occurred_on or datetime.min.date(), str(o.id))
    ):
        for posting in op.postings:
            account = ledger.account(posting.account_id)
            writer.writerow(
                (
                    str(op.id),
                    op.version,
                    op.status.value,
                    op.kind.value,
                    spreadsheet_text(op.description),
                    op.occurred_on.isoformat() if op.occurred_on else "",
                    op.cash_date.isoformat() if op.cash_date else "",
                    str(op.competence) if op.competence else "",
                    spreadsheet_text(account.name),
                    account.type.value,
                    format(posting.amount, "f"),
                    op.currency,
                    spreadsheet_text(members.get(posting.member_id, "")) if posting.member_id else "",
                    op.origin.kind.value,
                )
            )
    return ("﻿" + out.getvalue()).encode("utf-8")


def interchange_json(ledger: Ledger) -> bytes:
    rows = ledger.to_records()
    payload: dict[str, Any] = {
        "formato": INTERCHANGE_FORMAT,
        "versao_formato": INTERCHANGE_VERSION,
        "versao_esquema": ledger.meta.schema_version,
        "exportado_em": datetime.now(UTC).isoformat(),
        "aviso": "Arquivo sem criptografia; contém dados financeiros.",
        "entidades": [{"id": str(rid), "tipo": kind, "dados": data} for rid, kind, data in rows],
    }
    return json.dumps(payload, ensure_ascii=False, indent=1).encode("utf-8")


# ── printable reports (PDF by explicit action; RF-20) ──────────────────────


def _h(text: object) -> str:
    import html

    return html.escape(str(text))


def _money(value: object) -> str:
    from decimal import Decimal

    from opesvault.domain.money import format_brl

    return "—" if value is None else format_brl(value) if isinstance(value, Decimal) else _h(value)


def _table(headers: list[str], rows: list[list[object]], numeric: set[int] | None = None) -> str:
    numeric = numeric or set()
    head = "".join(f'<th align="{"right" if i in numeric else "left"}">{_h(h)}</th>' for i, h in enumerate(headers))
    body = "".join(
        "<tr>"
        + "".join(f'<td align="{"right" if i in numeric else "left"}">{_money(c)}</td>' for i, c in enumerate(row))
        + "</tr>"
        for row in rows
    )
    if not rows:
        body = f'<tr><td colspan="{len(headers)}">Nada no período.</td></tr>'
    return f'<table width="100%" cellspacing="0" cellpadding="3" border="0"><tr>{head}</tr>{body}</table>'


_STYLE = (
    "<style>body{font-family:sans-serif;font-size:10pt} h1{font-size:16pt} h2{font-size:12pt;margin-top:14pt}"
    " th{border-bottom:1px solid #888} td{border-bottom:1px solid #ddd} .note{color:#555;font-size:8pt}</style>"
)
WARNING = "Arquivo exportado sem criptografia: contém dados financeiros do projeto."


def monthly_report_html(ledger: Ledger, month: Any, member_id: Any = None) -> str:
    """The month for the family conversation: summary, categories and budget, bills, commitments, pending."""
    from opesvault.domain import budget, queries
    from opesvault.domain.agenda import STATE_LABELS, month_events
    from opesvault.domain.comparisons import totals_comparison
    from opesvault.domain.indicators import indicators
    from opesvault.domain.periods import pending_items

    names = (
        "janeiro",
        "fevereiro",
        "março",
        "abril",
        "maio",
        "junho",
        "julho",
        "agosto",
        "setembro",
        "outubro",
        "novembro",
        "dezembro",
    )
    title = f"{names[month.month - 1]} de {month.year}"
    flow = queries.cash_flow(ledger, month, month)[month]
    statement = queries.income_statement(ledger, month, member_id)
    worth = queries.net_worth(ledger, month.last_day())
    member = ledger.members.get(member_id) if member_id else None
    parts = [
        f"<html><head><meta charset='utf-8'>{_STYLE}</head><body>",
        f"<h1>{_h(ledger.meta.family_name or 'Projeto')} — {_h(title)}</h1>",
        f'<p class="note">{_h(WARNING)}</p>',
    ]
    if member is not None:
        parts.append(f"<p>Visão de <b>{_h(member.name)}</b>: lançamentos e rateios atribuídos a este integrante.</p>")
    parts.append("<h2>Resumo</h2>")
    parts.append(
        _table(
            ["", "Valor"],
            [
                ["Entradas (caixa)", flow.inflow],
                ["Saídas (caixa)", flow.outflow],
                ["Receitas (competência)", statement.total_income],
                ["Despesas (competência)", statement.total_expense],
                ["Resultado", statement.result],
                ["Patrimônio líquido no fim do mês", worth.net],
            ],
            {1},
        )
    )
    comparison = totals_comparison(ledger, month)
    parts.append("<h2>Comparado aos meses anteriores</h2>")
    parts.append(
        _table(
            ["", "Este mês", "Média de 3 meses", "Um ano antes"],
            [[c.name, c.current, c.average, c.last_year] for c in comparison],
            {1, 2, 3},
        )
    )
    status = budget.status(ledger, month)
    plan = {r.category_id: r for r in status.rows}
    rows = []
    for category_id, value in sorted(statement.expense.items(), key=lambda kv: kv[1], reverse=True):
        row = plan.get(category_id)
        rows.append([ledger.account(category_id).name, value, row.planned if row else None])
    parts.append("<h2>Despesas por categoria</h2>")
    parts.append(_table(["Categoria", "Realizado", "Planejado"], rows, {1, 2}))
    events = month_events(ledger, month)
    parts.append("<h2>Vencimentos do mês</h2>")
    parts.append(
        _table(
            ["Data", "Descrição", "Valor", "Situação"],
            [[f"{e.on:%d/%m/%Y}", e.title, abs(e.amount), STATE_LABELS[e.state]] for e in events],
            {2},
        )
    )
    parts.append("<h2>Indicadores</h2>")
    rows = []
    for indicator in indicators(ledger, month):
        if indicator.value is None:
            shown = "—"
        elif indicator.unit == "%":
            shown = f"{(indicator.value * 100):.0f}%"
        else:
            shown = f"{indicator.value} meses".replace(".", ",")
        rows.append([indicator.label, shown, indicator.detail])
    parts.append(_table(["Indicador", "Valor", "Como é calculado"], rows, {1}))
    pending = pending_items(ledger, month)
    parts.append("<h2>Pendências</h2>")
    parts.append("<ul>" + "".join(f"<li>{_h(p)}</li>" for p in pending) + "</ul>" if pending else "<p>Nenhuma.</p>")
    parts.append("</body></html>")
    return "".join(parts)


def annual_report_html(ledger: Ledger, year: int) -> str:
    """Year-end support material (domain.annual) plus deductible expenses per person."""
    from opesvault.domain.annual import NOTICE, annual
    from opesvault.domain.deductibles import KIND_LABELS
    from opesvault.domain.deductibles import NOTICE as DEDUCTIBLE_NOTICE
    from opesvault.domain.deductibles import annual as deductible_groups
    from opesvault.domain.model import AccountType

    summary = annual(ledger, year)
    parts = [
        f"<html><head><meta charset='utf-8'>{_STYLE}</head><body>",
        f"<h1>{_h(ledger.meta.family_name or 'Projeto')} — fechamento de {year}</h1>",
        f'<p class="note">{_h(WARNING)} {_h(NOTICE)}</p>',
        f"<h2>Bens e dívidas em 31/12/{year}</h2>",
        _table(
            ["Conta", "Tipo", f"31/12/{year - 1}", f"31/12/{year}"],
            [
                [b.name, "Bem" if b.kind is AccountType.ASSET else "Dívida", b.previous_year_end, b.year_end]
                for b in summary.balances
            ],
            {2, 3},
        ),
        f"<p>Patrimônio líquido em 31/12/{year}: <b>{_money(summary.net_worth)}</b></p>",
        "<h2>Receitas do ano por categoria</h2>",
        _table(
            ["Categoria", "Valor"],
            [[ledger.account(k).name, v] for k, v in sorted(summary.income.items(), key=lambda kv: -kv[1])],
            {1},
        ),
        "<h2>Investimentos</h2>",
        _table(
            ["", "Valor"],
            [
                ["Proventos recebidos", summary.investment_income],
                ["Imposto retido na fonte", summary.tax_withheld],
                ["Ganhos realizados (resgates e vendas)", summary.realized_gains],
            ],
            {1},
        ),
    ]
    if summary.incomplete_events:
        left_out = f"{summary.incomplete_events} resgate(s) sem valor bruto ou custo ficaram fora dos ganhos."
        parts.append(f'<p class="note">{left_out}</p>')
    parts.append("<h2>Despesas dedutíveis</h2>")
    parts.append(f'<p class="note">{_h(DEDUCTIBLE_NOTICE)}</p>')
    for group in deductible_groups(ledger, year):
        member = ledger.members.get(group.member_id) if group.member_id else None
        person = member.name if member else "Sem integrante"
        parts.append(f"<p><b>{_h(KIND_LABELS[group.kind])} — {_h(person)}: {_money(group.total)}</b></p>")
        parts.append(
            _table(
                ["Data", "Descrição", "Valor"],
                [
                    [
                        f"{(line.operation.cash_date or line.operation.occurred_on):%d/%m/%Y}"
                        if (line.operation.cash_date or line.operation.occurred_on)
                        else "—",
                        line.operation.description,
                        line.amount,
                    ]
                    for line in group.lines
                ],
                {2},
            )
        )
    parts.append("</body></html>")
    return "".join(parts)


def tax_report_html(ledger: Ledger, year: int, declarant_id: UUID | None = None) -> str:
    """The year in the shape of the return's sheets, for the declarant and their dependents."""
    from opesvault.domain.deductibles import KIND_LABELS
    from opesvault.tax import checklist, declaration, ids, issues, records, simulation, variable_income
    from opesvault.tax.model import BUCKET_LABELS, NATURE_LABELS, IncomeNature

    people = records.people_of(ledger, declarant_id)

    def person(member_id: UUID | None) -> str:
        member = ledger.members.get(member_id) if member_id else None
        return member.name if member else "—"

    def tid(value: str | None) -> str:
        return ids.display(value) if value else "falta"

    who = person(declarant_id) if declarant_id else "todo o projeto"
    found = declaration.income(ledger, year, people)
    parts = [
        f"<html><head><meta charset='utf-8'>{_STYLE}</head><body>",
        f"<h1>{_h(ledger.meta.family_name or 'Projeto')} — imposto de renda, ano-calendário {year}</h1>",
        f"<p>Declarante: <b>{_h(who)}</b></p>",
        f'<p class="note">{_h(WARNING)} {_h(declaration.NOTICE)}</p>',
    ]
    if declarant_id:
        info = records.member_info(ledger, declarant_id)
        parts.append(f"<p>CPF: {_h(tid(info.cpf if info else None))}</p>")
        deps = declaration.dependents(ledger, declarant_id)
        if deps:
            parts.append("<h2>Dependentes</h2>")
            parts.append(
                _table(
                    ["Nome", "CPF", "Nascimento", "Relação"],
                    [
                        [
                            d.name,
                            tid(d.cpf),
                            d.birth_date.strftime("%d/%m/%Y") if d.birth_date else "—",
                            d.relation or "—",
                        ]
                        for d in deps
                    ],
                )
            )
    parts.append("<h2>Rendimentos tributáveis recebidos de pessoa jurídica</h2>")
    parts.append(
        _table(
            ["Fonte pagadora", "CNPJ", "Integrante", "Rendimentos", "INSS", "IR retido", "13º", "IR 13º"],
            [
                [
                    r.payer,
                    tid(r.tax_id),
                    person(r.member_id),
                    r.taxable,
                    r.social_security,
                    r.withheld,
                    r.thirteenth,
                    r.thirteenth_withheld,
                ]
                for r in found.taxable
            ],
            {3, 4, 5, 6, 7},
        )
    )
    for nature in (IncomeNature.CARNE_LEAO, IncomeNature.EXEMPT, IncomeNature.EXCLUSIVE, None):
        rows = found.by_nature(nature)
        if not rows:
            continue
        title = NATURE_LABELS[nature] if nature else "Rendimentos sem natureza definida (a classificar)"
        parts.append(f"<h2>{_h(title)}</h2>")
        parts.append(
            _table(
                ["Fonte", "CNPJ", "Integrante", "Valor", "IR retido"],
                [
                    [r.source, (r.tax_id and ids.display(r.tax_id)) or "—", person(r.member_id), r.amount, r.withheld]
                    for r in rows
                ],
                {3, 4},
            )
        )
    payments = declaration.payments(ledger, year, people)
    if payments:
        parts.append("<h2>Pagamentos efetuados</h2>")
        parts.append(
            _table(
                ["Tipo", "Quem recebeu", "CPF/CNPJ", "Beneficiário", "Pago", "Parcela não dedutível"],
                [
                    [
                        KIND_LABELS[r.kind],
                        r.payee,
                        tid(r.tax_id),
                        person(r.beneficiary_id),
                        r.paid,
                        r.not_deductible,
                    ]  # type: ignore[call-overload]
                    for r in payments
                ],
                {4, 5},
            )
        )
    parts.append("<h2>Bens e direitos (custo de aquisição)</h2>")
    parts.append(
        _table(
            ["Grupo", "Código", "Discriminação", "CNPJ", f"31/12/{year - 1}", f"31/12/{year}"],
            [
                [
                    f"{r.group or '—'}{' (sugerido)' if r.suggested else ''}",
                    r.code or "—",
                    r.description,
                    tid(r.tax_id) if r.subject != "declared" else "—",
                    "—" if r.previous is None else r.previous,
                    "—" if r.current is None else r.current,
                ]
                for r in declaration.assets(ledger, year, people)
            ],
            {4, 5},
        )
    )
    debts = declaration.debts(ledger, year, people)
    if debts:
        parts.append("<h2>Dívidas e ônus reais</h2>")
        parts.append(
            _table(
                ["Dívida", "CNPJ", f"31/12/{year - 1}", f"31/12/{year}"],
                [[d.name, tid(d.tax_id), abs(d.previous), abs(d.current)] for d in debts],
                {2, 3},
            )
        )
    months = variable_income.months(ledger, year, people)
    if months:
        parts.append("<h2>Renda variável</h2>")
        parts.append(
            _table(
                ["Mês", "Tipo", "Vendas", "Resultado", "Isento", "Base", "Imposto", "IR fonte", "DARF pago"],
                [
                    [
                        f"{r.month.month:02d}/{r.month.year}",
                        BUCKET_LABELS[r.bucket],
                        r.sales,
                        r.result,
                        r.exempt_gain,
                        r.base,
                        "—" if r.tax is None else r.tax,
                        r.withheld,
                        r.paid,
                    ]
                    for r in months
                ],
                {2, 3, 4, 5, 6, 7, 8},
            )
        )
    comparison = simulation.compare(ledger, year, declarant_id)
    parts.append("<h2>Simplificada ou completa (simulação)</h2>")
    parts.append(f'<p class="note">{_h(simulation.NOTICE)}</p>')
    if comparison.missing:
        parts.append(f"<p>Falta informar: {_h(', '.join(comparison.missing))}.</p>")
    else:
        parts.append(
            _table(
                ["", "Simplificada", "Completa"],
                [
                    [
                        "Base de cálculo",
                        comparison.simplified.base if comparison.simplified else "—",
                        comparison.itemized.base if comparison.itemized else "—",
                    ],
                    [
                        "Imposto devido",
                        comparison.simplified.tax if comparison.simplified else "—",
                        comparison.itemized.tax if comparison.itemized else "—",
                    ],
                ],
                {1, 2},
            )
        )
    pending = issues.issues(ledger, year, declarant_id)
    absent = checklist.missing(checklist.expected(ledger, year, people))
    if pending or absent:
        parts.append("<h2>Pendências e documentos que faltam</h2>")
        parts.append("<ul>" + "".join(f"<li>{_h(i.title)} — {_h(i.detail)}</li>" for i in pending))
        parts.append("".join(f"<li>{_h(d.title)}</li>" for d in absent) + "</ul>")
    parts.append("</body></html>")
    return "".join(parts)
