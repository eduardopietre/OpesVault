"""What is incomplete or inconsistent for the return (pendências), and the monthly tax reminders.

Checks of completeness and agreement, never legal judgments: a payment without the payee's
CNPJ, a receipt not attached, an informe that differs from the records, an income without a
nature, a DARF not registered. Each issue says where it is fixed.
"""

from dataclasses import dataclass
from datetime import date, timedelta
from uuid import UUID

from opesvault.domain.alerts import LOOKBACK_DAYS, Severity
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import YearMonth
from opesvault.domain.money import format_brl
from opesvault.tax import checklist, declaration, records, simulation, statements, variable_income
from opesvault.tax.model import FIELD_LABELS, IncomeNature, NatureSubject, TaxSubject


@dataclass(frozen=True)
class Issue:
    severity: Severity
    title: str
    detail: str
    action: str  # what the tax page opens: identity, member, nature, filing, detail, report, ...
    ref: object = None


def issues(ledger: Ledger, year: int, declarant_id: UUID | None = None, today: date | None = None) -> list[Issue]:
    """Cached by the ledger's state: the overview asks for it on every refresh."""
    today = today or date.today()
    key = (ledger.change_count, year, declarant_id, today)
    cached = getattr(ledger, "_tax_issues", None)
    if cached is not None and cached[0] == key:
        return cached[1]
    found = _issues(ledger, year, declarant_id, today)
    ledger._tax_issues = (key, found)  # type: ignore[attr-defined]
    return found


def _person(ledger: Ledger, member_id: UUID | None) -> str:
    member = ledger.members.get(member_id) if member_id else None
    return member.name if member else "sem integrante"


def _issues(ledger: Ledger, year: int, declarant_id: UUID | None, today: date) -> list[Issue]:
    people = records.people_of(ledger, declarant_id)
    out: list[Issue] = []
    out += _people_issues(ledger, declarant_id)
    found = declaration.income(ledger, year, people)
    for row in found.taxable:
        if row.tax_id is None:
            out.append(
                Issue(
                    Severity.URGENT,
                    f"CNPJ da fonte pagadora: {row.payer}",
                    "obrigatório na ficha de rendimentos",
                    "identity",
                    (TaxSubject.CATEGORY, row.source_id),
                )
            )
        if row.net_only:
            out.append(
                Issue(
                    Severity.INFO,
                    f"Bruto, imposto retido e INSS: {row.payer}",
                    f"{row.net_only} depósito(s) contados pelo valor líquido; detalhe pelo contracheque",
                    "detail",
                    tuple(row.operations),
                )
            )
    for row in found.unclassified:
        out.append(
            Issue(
                Severity.URGENT,
                f"Natureza do rendimento: {row.source}",
                f"{format_brl(row.amount)} sem saber se é tributável, isento ou exclusivo",
                "nature",
                (row.subject, row.ref),
            )
        )
    for row in found.other:
        if (
            row.nature in (IncomeNature.EXEMPT, IncomeNature.EXCLUSIVE)
            and row.tax_id is None
            and row.subject is NatureSubject.CATEGORY
        ):
            out.append(
                Issue(
                    Severity.INFO,
                    f"CNPJ da fonte: {row.source}",
                    "pedido na ficha de isentos e exclusivos",
                    "identity",
                    (TaxSubject.CATEGORY, row.ref),
                )
            )
    if people is not None and found.unassigned:
        out.append(
            Issue(
                Severity.INFO,
                "Receitas sem integrante",
                f"{found.unassigned} lançamento(s) de receita sem integrante ficaram fora desta declaração",
                "ledger",
            )
        )
    for item in declaration.payments(ledger, year, people):
        if item.net <= 0:
            continue
        if item.tax_id is None:
            out.append(
                Issue(
                    Severity.URGENT,
                    f"CPF/CNPJ de quem recebeu: {item.payee}",
                    f"{format_brl(item.paid)} em pagamentos dedutíveis",
                    "identity",
                    (TaxSubject.MERCHANT, item.payee_key),
                )
            )
        if item.without_receipt:
            out.append(
                Issue(
                    Severity.SOON,
                    f"Comprovante não anexado: {item.payee}",
                    f"{item.without_receipt} pagamento(s) sem recibo ou nota",
                    "receipts",
                    tuple(item.operations),
                )
            )
    for asset in declaration.assets(ledger, year, people):
        if asset.suggested or asset.code is None:
            out.append(
                Issue(
                    Severity.INFO,
                    f"Grupo e código do bem: {asset.name}",
                    "escolha como ele aparece em Bens e Direitos",
                    "filing",
                    (asset.subject, asset.ref),
                )
            )
        if asset.subject == "position" and asset.current is None:
            out.append(
                Issue(
                    Severity.SOON,
                    f"Custo de aquisição desconhecido: {asset.name}",
                    "Bens e Direitos usa o custo, não o valor de mercado",
                    "investments",
                    asset.ref,
                )
            )
        if asset.subject == "account" and asset.tax_id is None:
            out.append(
                Issue(
                    Severity.INFO,
                    f"CNPJ da instituição: {asset.name}",
                    "pedido em Bens e Direitos",
                    "identity",
                    (TaxSubject.ACCOUNT, asset.ref),
                )
            )
    for report in records.reports_of(ledger, year):
        source = ledger.accounts.get(report.source_id)
        for diff in statements.differences(ledger, report):
            out.append(
                Issue(
                    Severity.URGENT,
                    f"Informe diferente do registrado: {source.name if source else '?'}",
                    f"{FIELD_LABELS[diff.field]}: informe {format_brl(diff.informed)}, "
                    f"registrado {format_brl(diff.recorded or diff.informed)}",
                    "report",
                    report.id,
                )
            )
    absent = checklist.missing(checklist.expected(ledger, year, people))
    if absent:
        out.append(
            Issue(
                Severity.INFO,
                f"{len(absent)} documento(s) ainda não recebido(s)",
                "veja Documentos do ano",
                "checklist",
            )
        )
    out += _monthly_issues(ledger, year, people, today)
    comparison = simulation.compare(ledger, year, declarant_id)
    if comparison.missing:
        out.append(
            Issue(Severity.INFO, "Simulação incompleta", "falta informar " + ", ".join(comparison.missing), "params")
        )
    order = {Severity.URGENT: 0, Severity.SOON: 1, Severity.INFO: 2}
    return sorted(out, key=lambda i: order[i.severity])


def _people_issues(ledger: Ledger, declarant_id: UUID | None) -> list[Issue]:
    out = []
    targets = [declarant_id, *records.dependents_of(ledger, declarant_id)] if declarant_id else []
    for member_id in targets:
        info = records.member_info(ledger, member_id)
        if info is None or info.cpf is None:
            role = "Declarante" if member_id == declarant_id else "Dependente"
            out.append(
                Issue(Severity.URGENT, f"CPF: {_person(ledger, member_id)}", f"{role} sem CPF", "member", member_id)
            )
        elif member_id != declarant_id and info.birth_date is None:
            out.append(
                Issue(
                    Severity.INFO,
                    f"Data de nascimento: {_person(ledger, member_id)}",
                    "pedida na ficha de dependentes",
                    "member",
                    member_id,
                )
            )
    return out


def _monthly_issues(ledger: Ledger, year: int, people: set[UUID] | None, today: date) -> list[Issue]:
    out = []
    rows = variable_income.months(ledger, year, people)
    if any(r.missing_rate for r in rows):
        out.append(
            Issue(
                Severity.SOON,
                "Alíquotas de renda variável",
                "há meses com ganho tributável e sem alíquota informada",
                "rules",
            )
        )
    for month, (due, paid, when) in variable_income.due_by_month(rows).items():
        if paid < due:
            late = when < today
            out.append(
                Issue(
                    Severity.URGENT if late else Severity.SOON,
                    f"DARF de renda variável {month.month:02d}/{month.year}",
                    f"{format_brl(due - paid)} {'venceu' if late else 'vence'} em {when:%d/%m/%Y}",
                    "payment",
                    ("variable_income", month),
                )
            )
    for item in declaration.income(ledger, year, people).carne_leao:
        if item.paid > 0:
            continue
        when = variable_income.due_date(item.month)
        late = when < today
        out.append(
            Issue(
                Severity.URGENT if late else Severity.SOON,
                f"Carnê-Leão {item.month.month:02d}/{item.month.year}: {_person(ledger, item.member_id)}",
                f"{format_brl(item.amount)} recebido(s); o DARF {'venceu' if late else 'vence'} em {when:%d/%m/%Y}. "
                "Calcule no Carnê-Leão Web e registre o pagamento",
                "payment",
                ("carne_leao", item.month, item.member_id),
            )
        )
    return out


# ── reminders for the Atenção panel ──────────


Reminder = tuple[Severity, str, str, date, object]


def engaged(ledger: Ledger) -> bool:
    """The user started preparing a return here (any tax record): only then the season reminder shows."""
    from opesvault.tax.model import KINDS

    return any(ledger.entities(kind) for kind in KINDS)


def reminders(ledger: Ledger, today: date, horizon: int) -> list[Reminder]:
    """Monthly DARFs (renda variável, Carnê-Leão) near or past due, and the return's season."""
    key = (ledger.change_count, today, horizon)
    cached = getattr(ledger, "_tax_reminders", None)
    if cached is not None and cached[0] == key:
        return cached[1]
    found = _reminders(ledger, today, horizon)
    ledger._tax_reminders = (key, found)  # type: ignore[attr-defined]
    return found


def _reminders(ledger: Ledger, today: date, horizon: int) -> list[Reminder]:
    out: list[Reminder] = []
    if not engaged(ledger) and not _has_variable_income(ledger):
        return out
    window_start, window_end = today - timedelta(days=LOOKBACK_DAYS), today + timedelta(days=horizon)
    for month in (YearMonth.of(today).add(-2), YearMonth.of(today).add(-1)):
        when = variable_income.due_date(month)
        if not window_start <= when <= window_end:
            continue
        rows = variable_income.months(ledger, month.year)
        due = variable_income.due_by_month([r for r in rows if r.month == month]).get(month)
        if due is not None and due[1] < due[0]:
            severity = Severity.URGENT if when < today else Severity.SOON
            out.append(
                (
                    severity,
                    f"DARF de renda variável {month.month:02d}/{month.year}",
                    f"{format_brl(due[0] - due[1])}",
                    when,
                    ("variable_income", month),
                )
            )
        for item in declaration.income(ledger, month.year).carne_leao:
            if item.month == month and item.paid == 0:
                severity = Severity.URGENT if when < today else Severity.SOON
                out.append(
                    (
                        severity,
                        f"Carnê-Leão {month.month:02d}/{month.year}: {_person(ledger, item.member_id)}",
                        f"{format_brl(item.amount)} recebido(s) de pessoa física ou do exterior",
                        when,
                        ("carne_leao", month, item.member_id),
                    )
                )
    if 2 <= today.month <= 5 and engaged(ledger):
        year = today.year - 1
        pending = [i for i in issues(ledger, year, None, today) if i.severity is not Severity.INFO]
        if pending:
            out.append(
                (
                    Severity.INFO,
                    f"Declaração de {year}: {len(pending)} pendência(s)",
                    "CPF/CNPJ, comprovantes, informes e natureza dos rendimentos",
                    today,
                    ("year", year),
                )
            )
    return out


def _has_variable_income(ledger: Ledger) -> bool:
    from opesvault.investments.service import assets, positions

    return any(assets(ledger)[p.asset_id].asset_class in variable_income.CLASSES for p in positions(ledger).values())
