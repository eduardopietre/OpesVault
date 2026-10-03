"""What each sheet of the Imposto de renda page shows, as plain rows and notes (no Qt).

Every function returns `(cells, key)` pairs for `set_rows`: the key is the row's index in the
domain list (or an id), so a command on the selected row finds what it refers to. Unknown
amounts read "—" or "falta", never zero (docs/00 §5).
"""

from collections.abc import Callable, Mapping
from typing import Any
from uuid import UUID

from opesvault.domain.alerts import Severity
from opesvault.domain.deductibles import KIND_LABELS
from opesvault.domain.ledger import Ledger
from opesvault.tax import checklist, declaration, ids, issues, simulation, statements, variable_income
from opesvault.tax.model import BUCKET_LABELS, FIELD_LABELS, NATURE_SHORT, IncomeReport, NatureSubject
from opesvault.ui.common import fmt, fmt_date

Row = tuple[list[str], Any]
Names = Callable[[UUID | None], str]  # member id → name ("—" when none)

SEVERITY_WORDS = {Severity.URGENT: "Corrigir", Severity.SOON: "Em breve", Severity.INFO: "Conferir"}
SEVERITY_TONES = {Severity.URGENT: "negative", Severity.SOON: "warning", Severity.INFO: None}


def tax_id(value: str | None) -> str:
    """A CPF or CNPJ formatted for reading, or "falta" when the declaration needs one."""
    return ids.display(value) if value else "falta"


def _optional(value: Any) -> str:
    return fmt(value) if value else "—"


def _month(month: Any) -> str:
    return f"{month.month:02d}/{month.year}"


def issue_rows(found: list[issues.Issue]) -> list[Row]:
    return [([SEVERITY_WORDS[i.severity], i.title, i.detail], index) for index, i in enumerate(found)]


def document_rows(found: list[checklist.Expected]) -> list[Row]:
    rows = []
    for index, item in enumerate(found):
        state = "Recebido" if item.received else "Falta"
        rows.append(([item.title, state + (" (marcado)" if item.by_hand else "")], index))
    return rows


def taxable_rows(found: declaration.Income, name: Names) -> list[Row]:
    """Salaries and other income from companies; "*" marks a deposit counted by its net amount."""
    return [
        (
            [
                r.payer,
                tax_id(r.tax_id),
                name(r.member_id),
                fmt(r.taxable) + (" *" if r.net_only else ""),
                fmt(r.social_security),
                fmt(r.withheld),
                fmt(r.thirteenth),
                fmt(r.thirteenth_withheld),
            ],
            index,
        )
        for index, r in enumerate(found.taxable)
    ]


def other_income_rows(found: declaration.Income, name: Names) -> list[Row]:
    return [
        (
            [
                (NATURE_SHORT[r.nature] + (f" ({r.code})" if r.code else "")) if r.nature else "A definir",
                r.source,
                tax_id(r.tax_id) if r.subject is NatureSubject.CATEGORY or r.tax_id else "—",
                name(r.member_id),
                fmt(r.amount),
                _optional(r.withheld),
            ],
            index,
        )
        for index, r in enumerate(found.other)
    ]


def carne_leao_rows(found: declaration.Income, name: Names) -> list[Row]:
    return [
        (
            [
                _month(m.month),
                name(m.member_id),
                fmt(m.amount),
                fmt(m.paid) if m.paid else "não registrado",
                fmt_date(variable_income.due_date(m.month)),
            ],
            index,
        )
        for index, m in enumerate(found.carne_leao)
    ]


def payment_rows(found: list[declaration.PaymentRow], name: Names) -> list[Row]:
    rows = []
    for index, r in enumerate(found):
        count = len(r.operations)
        rows.append(
            (
                [
                    KIND_LABELS[r.kind],
                    r.payee,
                    tax_id(r.tax_id),
                    name(r.beneficiary_id),
                    fmt(r.paid),
                    _optional(r.not_deductible),
                    fmt(r.net),
                    f"{count - r.without_receipt} de {count}",
                ],
                index,
            )
        )
    return rows


def asset_rows(found: list[declaration.AssetRow]) -> list[Row]:
    """A group the app suggested says so: the user decides the filing (CLAUDE.md, imposto de renda)."""
    rows = []
    for index, r in enumerate(found):
        group = r.group or "a definir"
        if r.suggested and r.group:
            group += " (sugerido)"
        rows.append(
            (
                [
                    group,
                    r.code or "—",
                    r.name,
                    r.description,
                    tax_id(r.tax_id) if r.subject != "declared" else "—",
                    fmt(r.previous),
                    fmt(r.current),
                ],
                index,
            )
        )
    return rows


def debt_rows(found: list[declaration.DebtRow]) -> list[Row]:
    return [([d.name, tax_id(d.tax_id), fmt(abs(d.previous)), fmt(abs(d.current))], d.account_id) for d in found]


def variable_rows(found: list[variable_income.MonthResult]) -> list[Row]:
    return [
        (
            [
                _month(r.month),
                BUCKET_LABELS[r.bucket] + (" *" if r.approximate else ""),
                fmt(r.sales),
                fmt(r.result),
                _optional(r.exempt_gain),
                _optional(r.compensated),
                fmt(r.base),
                fmt(r.tax),
                _optional(r.withheld),
                fmt(r.due),
                fmt_date(r.due_date),
                _optional(r.paid),
            ],
            index,
        )
        for index, r in enumerate(found)
    ]


def variable_notes(found: list[variable_income.MonthResult], carried: Mapping[Any, Any]) -> str:
    notes = []
    losses = [f"{BUCKET_LABELS[b]}: {fmt(v)}" for b, v in carried.items() if v]
    if losses:
        notes.append("Prejuízo a compensar no fim do ano — " + "; ".join(losses) + ".")
    if any(r.approximate for r in found):
        notes.append("* Day trade separado pelo preço médio das compras do mesmo dia; confira com a nota.")
    if any(r.missing_rate for r in found):
        notes.append("Há base tributável sem alíquota: informe em Regras… (o imposto fica desconhecido).")
    notes.append("O vencimento é o último dia útil do mês seguinte sem contar feriados; confira a data.")
    return " ".join(notes)


def simulation_rows(comparison: simulation.Comparison) -> list[Row]:
    """The two models side by side; a model that cannot be computed shows "—" in every cell."""
    simple, full = comparison.simplified, comparison.itemized

    def cell(model: simulation.Model | None, attr: str) -> str:
        return fmt(getattr(model, attr) if model is not None else None)

    return [
        (["Rendimentos tributáveis", fmt(comparison.taxable), fmt(comparison.taxable)], "taxable"),
        (["Desconto ou deduções", cell(simple, "deductions"), cell(full, "deductions")], "deductions"),
        (["Base de cálculo", cell(simple, "base"), cell(full, "base")], "base"),
        (["Imposto devido", cell(simple, "tax"), cell(full, "tax")], "tax"),
        (["Imposto já pago ou retido", fmt(comparison.withheld), fmt(comparison.withheld)], "paid"),
        (
            ["A pagar (+) ou a restituir (−)", fmt(comparison.balance(simple)), fmt(comparison.balance(full))],
            "balance",
        ),
    ]


def simulation_notes(comparison: simulation.Comparison) -> str:
    notes = []
    if comparison.missing:
        notes.append("Falta informar " + ", ".join(comparison.missing) + " (Tabela do ano…).")
    if comparison.best is not None:
        notes.append(f"Com estes números, a {comparison.best.name.lower()} resulta em menos imposto.")
    for title, values in (("Deduções", comparison.deductions), ("Fora da base", comparison.left_out)):
        if values:
            notes.append(f"{title}: " + "; ".join(f"{label} {fmt(value)}" for label, value in values.items()) + ".")
    return " ".join(notes)


def report_rows(ledger: Ledger, found: list[IncomeReport]) -> list[Row]:
    rows = []
    for report in found:
        source = ledger.accounts.get(report.source_id)
        diffs = statements.differences(ledger, report)
        state = f"{len(diffs)} diferença(s)" if diffs else "confere"
        rows.append(
            ([source.name if source else "?", tax_id(report.payer_tax_id), str(len(report.lines)), state], report.id)
        )
    return rows


def check_rows(found: list[statements.Check]) -> list[Row]:
    return [
        (
            [
                FIELD_LABELS[c.field],
                fmt(c.informed),
                fmt(c.recorded) if c.recorded is not None else "sem registro",
                "—" if c.matches or c.difference is None else fmt(c.difference),
            ],
            c.field,
        )
        for c in found
    ]
