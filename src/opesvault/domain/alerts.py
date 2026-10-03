"""What needs attention when a vault is opened (docs/09 §1.3).

The app is offline and never notifies in the background, so the moment the vault is
opened is when it must say what is due, late or waiting. Alerts are computed from the
ledger, never stored, and never change anything.
"""

from dataclasses import dataclass
from datetime import date, timedelta
from enum import StrEnum

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import YearMonth
from opesvault.domain.money import format_brl

HORIZON_DAYS = 7  # "vence nos próximos dias"
LOOKBACK_DAYS = 31  # late items older than this are history, not alerts


class Severity(StrEnum):
    URGENT = "urgent"  # late or over: something already went wrong
    SOON = "soon"  # due within the horizon
    INFO = "info"  # waiting for the user (review, near the budget)


class Target(StrEnum):
    """Where the user acts on the alert."""

    ACCOUNTS = "accounts"
    RECURRENCES = "recurrences"
    IMPORT = "import"
    BUDGET = "budget"
    REPORTS = "reports"
    LEDGER = "ledger"
    SETTINGS = "settings"


@dataclass(frozen=True)
class Alert:
    severity: Severity
    title: str
    detail: str
    target: Target
    due_on: date | None = None
    # What the alert is about, so the screen can open it ready to act: (card id, bill
    # month), (rule id, due date), (category id, month) or a batch id. Opaque to this module.
    ref: object = None


def _when(due: date, today: date) -> str:
    days = (due - today).days
    if days == 0:
        return "vence hoje"
    if days == 1:
        return "vence amanhã"
    if days > 1:
        return f"vence em {days} dias ({due:%d/%m})"
    return f"venceu em {due:%d/%m}"


def card_alerts(ledger: Ledger, today: date, horizon: int = HORIZON_DAYS) -> list[Alert]:
    from opesvault.domain.cards import BillStatus, bills

    out: list[Alert] = []
    this_month = YearMonth.of(today)
    months = [this_month.add(-1), this_month, this_month.add(1)]
    for card in ledger.cards.values():
        for bill in bills(ledger, card.id, months):
            due = bill.cycle.due
            if bill.total <= 0 or bill.remaining <= 0:
                continue
            if not (today - timedelta(days=LOOKBACK_DAYS) <= due <= today + timedelta(days=horizon)):
                continue
            state = bill.status(today)
            if state in (BillStatus.OVERDUE, BillStatus.PARTIAL) and due < today:
                severity, verb = Severity.URGENT, "Fatura vencida"
            elif state is BillStatus.PAID:
                continue
            else:
                severity, verb = Severity.SOON, "Fatura a vencer"
            out.append(
                Alert(
                    severity,
                    f"{verb}: {card.name}",
                    f"{_when(due, today)} · falta pagar {format_brl(bill.remaining)}",
                    Target.ACCOUNTS,
                    due,
                    (card.id, bill.cycle.month),
                )
            )
    return out


def recurrence_alerts(ledger: Ledger, today: date, horizon: int = HORIZON_DAYS) -> list[Alert]:
    from opesvault.domain.recurrence import ForecastStatus, forecasts

    out: list[Alert] = []
    start, end = today - timedelta(days=LOOKBACK_DAYS), today + timedelta(days=horizon)
    for forecast in forecasts(ledger, start, end, today):
        value = format_brl(abs(forecast.amount))
        if forecast.status is ForecastStatus.LATE:
            out.append(
                Alert(
                    Severity.URGENT,
                    f"Previsão não realizada: {forecast.description}",
                    f"esperada em {forecast.due_on:%d/%m} · {value} · vincule ao lançamento ou pule",
                    Target.RECURRENCES,
                    forecast.due_on,
                    (forecast.rule_id, forecast.due_on),
                )
            )
        elif forecast.status is ForecastStatus.PENDING and forecast.due_on >= today:
            out.append(
                Alert(
                    Severity.SOON,
                    f"Conta a vencer: {forecast.description}"
                    if forecast.amount < 0
                    else f"Previsto: {forecast.description}",
                    f"{_when(forecast.due_on, today)} · {value}",
                    Target.RECURRENCES,
                    forecast.due_on,
                    (forecast.rule_id, forecast.due_on),
                )
            )
    return out


def import_alerts(ledger: Ledger) -> list[Alert]:
    from opesvault.importing import pipeline
    from opesvault.importing.model import BatchStatus, ItemStatus

    out: list[Alert] = []
    pending = [i for i in pipeline.items(ledger).values() if i.status in (ItemStatus.READY, ItemStatus.NEEDS_REVIEW)]
    if pending:
        documents = len({i.batch_id for i in pending})
        out.append(
            Alert(
                Severity.INFO,
                f"{len(pending)} item(ns) importado(s) aguardando revisão",
                f"em {documents} documento(s); só entram nas contas depois de aprovados",
                Target.IMPORT,
                ref=pending[0].batch_id,
            )
        )
    undecided = [
        b for b in pipeline.batches(ledger).values() if b.status in (BatchStatus.AMBIGUOUS, BatchStatus.UNSUPPORTED)
    ]
    if undecided:
        out.append(
            Alert(
                Severity.INFO,
                f"{len(undecided)} documento(s) sem layout definido",
                "escolha o layout ou registre os lançamentos manualmente",
                Target.IMPORT,
                ref=undecided[0].id,
            )
        )
    return out


def budget_alerts(ledger: Ledger, today: date) -> list[Alert]:
    from opesvault.domain.budget import status

    month = YearMonth.of(today)
    current = status(ledger, month)
    out = [
        Alert(
            Severity.URGENT,
            f"Orçamento estourado: {row.name}",
            f"gasto {format_brl(row.actual)} de {format_brl(row.planned)} ({int(row.used * 100)}%)",
            Target.BUDGET,
            ref=(row.category_id, month),
        )
        for row in current.over
    ]
    out += [
        Alert(
            Severity.INFO,
            f"Orçamento quase no limite: {row.name}",
            f"resta {format_brl(row.remaining)} de {format_brl(row.planned)}",
            Target.BUDGET,
            ref=(row.category_id, month),
        )
        for row in current.near
    ]
    return out


def loan_alerts(ledger: Ledger, today: date, horizon: int = HORIZON_DAYS) -> list[Alert]:
    from opesvault.domain.loans import upcoming

    out = []
    for plan, item in upcoming(ledger, today - timedelta(days=LOOKBACK_DAYS), today + timedelta(days=horizon)):
        late = item.due < today
        out.append(
            Alert(
                Severity.URGENT if late else Severity.SOON,
                f"{'Parcela vencida' if late else 'Parcela a vencer'}: {plan.name}",
                f"parcela {item.number} · {_when(item.due, today)} · {format_brl(item.payment)}",
                Target.ACCOUNTS,
                item.due,
                ("loan", plan.id, item.number),
            )
        )
    return out


def projection_alerts(ledger: Ledger, today: date) -> list[Alert]:
    from opesvault.domain.projection import ALERT_DAYS, negative_ahead

    out = []
    for projection in negative_ahead(ledger, today, ALERT_DAYS):
        first = projection.first_negative
        on, lowest = projection.lowest
        account = ledger.accounts.get(projection.account_id)
        if first is None or account is None:
            continue
        out.append(
            Alert(
                Severity.SOON,
                f"Saldo previsto negativo: {account.name}",
                f"a partir de {first:%d/%m}, chega a {format_brl(lowest)} em {on:%d/%m}, "
                "com faturas, recorrências e parcelas já registradas",
                Target.REPORTS,
                first,
                "projected_balance",
            )
        )
    return out


def balance_check_alerts(ledger: Ledger) -> list[Alert]:
    from opesvault.domain.balance_checks import divergent

    return [
        Alert(
            Severity.INFO,
            f"Saldo diferente do banco: {ledger.accounts[r.check.account_id].name}",
            f"em {r.check.on:%d/%m/%Y} o banco mostra {format_brl(r.check.informed)} e o aplicativo "
            f"{format_brl(r.computed)} (diferença {format_brl(r.difference)})",
            Target.ACCOUNTS,
            ref=("check", r.check.account_id),
        )
        for r in divergent(ledger)
    ]


def price_alerts(ledger: Ledger) -> list[Alert]:
    from opesvault.domain.subscriptions import commitments

    return [
        Alert(
            Severity.INFO,
            f"Valor mudou: {c.rule.description}",
            f"previsto {format_brl(c.rule.amount)}, cobrado {format_brl(c.last_paid)}"
            + (f" em {c.last_paid_on:%d/%m}" if c.last_paid_on else ""),
            Target.RECURRENCES,
            ref=("rule", c.rule.id),
        )
        for c in commitments(ledger)
        if c.price_changed and c.last_paid is not None
    ]


def suspicion_alerts(ledger: Ledger, today: date) -> list[Alert]:
    from opesvault.domain.anomalies import suspicions

    return [
        Alert(
            Severity.INFO,
            s.title,
            s.detail + " · no Livro, Ações › Está certo silencia o aviso",
            Target.LEDGER,
            s.on,
            ("filter", s.account_id, (s.on - timedelta(days=DUPLICATE_SPAN), s.on)),
        )
        for s in suspicions(ledger, today)
    ]


DUPLICATE_SPAN = 3
BACKUP_AGE_DAYS = 30


def backup_alert(last_backup: date | None, today: date, configured: bool) -> list[Alert]:
    """Said when the newest backup is old or missing. The caller reads the folder (not the domain)."""
    if last_backup is None:
        detail = (
            "nenhum backup encontrado na pasta de backups"
            if configured
            else "defina uma pasta de backups em Configurações ou use Cofre › Fazer backup agora"
        )
        return [Alert(Severity.INFO, "Faça um backup do cofre", detail, Target.SETTINGS)]
    age = (today - last_backup).days
    if age < BACKUP_AGE_DAYS:
        return []
    return [
        Alert(
            Severity.INFO,
            f"Último backup há {age} dias",
            f"de {last_backup:%d/%m/%Y}; faça um novo e confira com Cofre › Verificar backup",
            Target.SETTINGS,
        )
    ]


ORDER = {Severity.URGENT: 0, Severity.SOON: 1, Severity.INFO: 2}


def alerts(ledger: Ledger, today: date | None = None, horizon: int = HORIZON_DAYS) -> list[Alert]:
    """Most urgent first; within a level, the nearest date first."""
    today = today or date.today()
    found = [
        *card_alerts(ledger, today, horizon),
        *recurrence_alerts(ledger, today, horizon),
        *loan_alerts(ledger, today, horizon),
        *projection_alerts(ledger, today),
        *budget_alerts(ledger, today),
        *balance_check_alerts(ledger),
        *price_alerts(ledger),
        *suspicion_alerts(ledger, today),
        *import_alerts(ledger),
    ]
    return sorted(found, key=lambda a: (ORDER[a.severity], a.due_on or date.max, a.title))
