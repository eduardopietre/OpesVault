"""Recorrências: rules, forecasts and linking forecasts to realized operations (RF-11)."""

from datetime import date, timedelta

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QInputDialog,
    QLineEdit,
    QMessageBox,
    QSpinBox,
    QSplitter,
)

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountType
from opesvault.domain.money import ZERO
from opesvault.domain.recurrence import (
    Forecast,
    ForecastStatus,
    Frequency,
    RecurrenceRule,
    add_rule,
    auto_suggestions,
    candidates,
    forecasts,
    realize,
    rules,
    skip,
    update_rule,
)
from opesvault.ui.common import (
    combo_value,
    date_edit,
    fill_combo,
    fmt,
    fmt_date,
    from_qdate,
    make_table,
    money_edit,
    read_money,
    run_guarded,
    selected_id,
    set_rows,
)
from opesvault.ui.components import Section, button, flow_row
from opesvault.ui.dialogs import FormDialog, balance_accounts, category_items
from opesvault.ui.pages.base import Page

FORECAST_LABELS = {
    ForecastStatus.PENDING: "Prevista",
    ForecastStatus.LATE: "Atrasada",
    ForecastStatus.REALIZED: "Realizada",
    ForecastStatus.SKIPPED: "Pulada",
}
FREQUENCY_LABELS = {Frequency.MONTHLY: "Mensal", Frequency.YEARLY: "Anual", Frequency.WEEKLY: "Semanal"}


class RuleDialog(FormDialog):
    def __init__(self, parent, ledger: Ledger) -> None:  # type: ignore[no-untyped-def]
        super().__init__(parent, "Nova recorrência")
        self.description = QLineEdit()
        self.account = QComboBox()
        fill_combo(self.account, balance_accounts(ledger))
        self.counterpart = QComboBox()
        fill_combo(
            self.counterpart,
            category_items(ledger, AccountType.INCOME) + category_items(ledger, AccountType.EXPENSE),
        )
        self.amount = money_edit()
        self.tolerance = money_edit("0,00")
        self.frequency = QComboBox()
        fill_combo(self.frequency, [(label, f) for f, label in FREQUENCY_LABELS.items()])
        self.day = QSpinBox()
        self.day.setRange(1, 31)
        self.day.setValue(5)
        self.start = date_edit(date.today().replace(day=1))
        for label, widget in (
            ("Descrição:", self.description),
            ("Conta:", self.account),
            ("Categoria:", self.counterpart),
            ("Valor esperado:", self.amount),
            ("Tolerância:", self.tolerance),
            ("Frequência:", self.frequency),
            ("Dia:", self.day),
            ("Início:", self.start),
        ):
            self.form.addRow(label, widget)

    def validate(self) -> None:
        self.build()

    def build(self) -> RecurrenceRule:
        if not self.description.text().strip():
            raise DomainError("Informe a descrição.")
        amount = read_money(self.amount)
        if combo_value(self.account) is None or combo_value(self.counterpart) is None:
            raise DomainError("Cadastre contas e categorias antes.")
        return RecurrenceRule(
            description=self.description.text().strip(),
            account_id=combo_value(self.account),
            counterpart_id=combo_value(self.counterpart),
            amount=abs(amount or ZERO),
            tolerance=abs(read_money(self.tolerance, allow_empty=True) or ZERO),
            frequency=combo_value(self.frequency),
            day=self.day.value(),
            start=from_qdate(self.start.date()),
        )


class RecurrencesPage(Page):
    title = "Recorrências"
    section = "Cadastros"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.rules = make_table(["Descrição", "Valor", "Frequência", "Dia", "Situação"])
        self.forecast_table = make_table(["Data", "Descrição", "Valor", "Situação"])
        self._forecasts: list[Forecast] = []
        self.header.add(button("Nova recorrência…", self.add, role="primary"))
        rules_section = Section("Regras", "Contas fixas e receitas esperadas.")
        rules_section.add(flow_row(button("Pausar ou retomar", self.toggle)))
        rules_section.add(self.rules, 1)
        forecasts_section = Section("Previsões", "De 3 meses atrás a 6 meses à frente. Previsões nunca alteram saldos.")
        forecasts_section.add(
            flow_row(
                button("Vincular realizado…", self.link_selected),
                button("Vincular sugestões únicas", self.link_suggestions, tip="Só quando há um único candidato"),
                button("Pular previsão…", self.skip_selected),
            )
        )
        forecasts_section.add(self.forecast_table, 1)
        split = QSplitter(Qt.Orientation.Vertical)
        split.setChildrenCollapsible(False)
        split.addWidget(rules_section)
        split.addWidget(forecasts_section)
        split.setSizes([260, 420])
        layout = self.page_layout()
        layout.addWidget(split, 1)

    def _window(self) -> tuple[date, date]:
        today = date.today()
        return today - timedelta(days=92), today + timedelta(days=186)

    def refresh(self) -> None:
        if self.session is None:
            self.rules.setRowCount(0)
            self.forecast_table.setRowCount(0)
            return
        ledger = self.session.ledger
        set_rows(
            self.rules,
            [
                (
                    [
                        r.description,
                        fmt(r.amount),
                        FREQUENCY_LABELS[r.frequency],
                        str(r.day),
                        "Pausada" if r.paused else "Ativa",
                    ],
                    r.id,
                )
                for r in rules(ledger).values()
            ],
        )
        start, end = self._window()
        self._forecasts = forecasts(ledger, start, end)
        rows = [
            ([fmt_date(f.due_on), f.description, fmt(f.amount), FORECAST_LABELS[f.status]], index)
            for index, f in enumerate(self._forecasts)
        ]
        set_rows(self.forecast_table, rows)  # type: ignore[arg-type] - row key is the forecast index

    def _selected_forecast(self) -> Forecast | None:
        index = selected_id(self.forecast_table)
        return self._forecasts[index] if isinstance(index, int) and index < len(self._forecasts) else None

    def add(self) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        dialog = RuleDialog(self, ledger)
        if dialog.exec() and run_guarded(self, lambda: add_rule(ledger, dialog.build())):
            self.changed()

    def toggle(self) -> None:
        rule_id = selected_id(self.rules)
        if self.session is None or rule_id is None:
            return
        ledger = self.session.ledger
        rule = rules(ledger)[rule_id]
        if run_guarded(
            self, lambda: update_rule(ledger, rule.model_copy(update={"paused": not rule.paused}), "pausar/retomar")
        ):
            self.changed()

    def link_suggestions(self) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        start, end = self._window()
        pairs = auto_suggestions(ledger, start, end)
        if not pairs:
            QMessageBox.information(self, "Recorrências", "Nenhuma previsão com um único lançamento compatível.")
            return
        summary = "\n".join(
            f"{fmt_date(f.due_on)} {f.description} ← {op.description} {fmt_date(op.cash_date)}" for f, op in pairs
        )
        if QMessageBox.question(self, "Confirmar vínculos", summary) != QMessageBox.StandardButton.Yes:
            return
        for forecast, op in pairs:
            run_guarded(self, lambda f=forecast, o=op: realize(ledger, f.rule_id, f.due_on, o.id))
        self.changed()

    def link_selected(self) -> None:
        forecast = self._selected_forecast()
        if self.session is None or forecast is None:
            return
        ledger = self.session.ledger
        found = candidates(ledger, forecast)
        if not found:
            QMessageBox.information(self, "Recorrências", "Nenhum lançamento compatível (conta, valor e data).")
            return
        labels = [f"{fmt_date(o.cash_date)} {o.description}" for o in found]
        choice, ok = QInputDialog.getItem(self, "Vincular", "Lançamento realizado:", labels, 0, False)
        if ok:
            op = found[labels.index(choice)]
            if run_guarded(self, lambda: realize(ledger, forecast.rule_id, forecast.due_on, op.id)):
                self.changed()

    def skip_selected(self) -> None:
        forecast = self._selected_forecast()
        if self.session is None or forecast is None:
            return
        ledger = self.session.ledger
        if run_guarded(self, lambda: skip(ledger, forecast.rule_id, forecast.due_on)):
            self.changed()
