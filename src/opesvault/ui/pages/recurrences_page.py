"""Recorrências: rules, forecasts and linking forecasts to realized operations (RF-11)."""

from datetime import date, timedelta

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QComboBox,
    QInputDialog,
    QLineEdit,
    QMessageBox,
    QSpinBox,
    QStackedWidget,
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
    fit_to_rows,
    fmt,
    fmt_date,
    from_qdate,
    money_edit,
    read_money,
    run_guarded,
    selected_id,
    set_rows,
    stretch_column,
    summary_table,
)
from opesvault.ui.components import (
    Collapsible,
    EmptyState,
    Section,
    adaptive,
    button,
    confirm,
    menu_button,
    scroll_body,
    text,
)
from opesvault.ui.dialogs import FormDialog, balance_accounts, category_items
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import tokens

FORECAST_LABELS = {
    ForecastStatus.PENDING: "Prevista",
    ForecastStatus.LATE: "Atrasada",
    ForecastStatus.REALIZED: "Realizada",
    ForecastStatus.SKIPPED: "Pulada",
}
FREQUENCY_LABELS = {Frequency.MONTHLY: "Mensal", Frequency.YEARLY: "Anual", Frequency.WEEKLY: "Semanal"}


class RuleDialog(FormDialog):
    def __init__(self, parent, ledger: Ledger, suggestion=None) -> None:  # type: ignore[no-untyped-def]
        super().__init__(parent, "Nova recorrência", "Criar recorrência")
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
        self.tolerance.setToolTip(
            "Quanto o valor pago pode variar para mais ou para menos e ainda ser o mesmo compromisso"
        )
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
            ("Variação aceita:", self.tolerance),
            ("Frequência:", self.frequency),
            ("Dia:", self.day),
            ("Início:", self.start),
        ):
            self.form.addRow(label, widget)
        if suggestion is not None:  # a charge that repeats (domain.subscriptions.candidates)
            from opesvault.domain.money import format_brl
            from opesvault.ui.common import select_combo

            self.description.setText(suggestion.description)
            select_combo(self.account, suggestion.account_id)
            select_combo(self.counterpart, suggestion.category_id)
            self.amount.setText(format_brl(suggestion.amount).replace("R$", "").strip())
            self.day.setValue(suggestion.day)
        self.form.insertRow(
            5,
            "",
            text(
                "Quanto o valor pago pode variar e ainda ser este compromisso (0 = valor exato).", "caption", wrap=True
            ),
        )

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
        self.rules = summary_table(["Descrição", "Valor", "Frequência", "Dia", "Situação"], max_rows=8)
        self.forecast_table = summary_table(["Data", "Descrição", "Valor", "Situação"], max_rows=12)
        self.rules.setAccessibleName("Regras de recorrência")
        self.forecast_table.setAccessibleName("Previsões")
        stretch_column(self.rules, 0)
        stretch_column(self.forecast_table, 1)
        self._forecasts: list[Forecast] = []
        self.header.add(button("Nova recorrência…", self.add, role="primary"))
        rules_section = Section("Regras", "Contas fixas e receitas esperadas.")
        rules_section.add_actions(button("Pausar ou retomar", self.toggle))
        rules_section.add(self.rules)
        forecasts_section = Section("Previsões", "De 3 meses atrás a 6 meses à frente. Previsões nunca alteram saldos.")
        forecasts_section.add_actions(
            button("Vincular realizado…", self.link_selected),
            menu_button(
                "Mais",
                [
                    ("Vincular sugestões únicas", self.link_suggestions),
                    ("Pular previsão…", self.skip_selected),
                    None,
                    ("Projeção de compromissos (Relatórios)", lambda: self.navigate("reports", "projection")),
                ],
                tip="Vincular quando há um único candidato, ou pular uma previsão",
            ),
        )
        forecasts_section.add(self.forecast_table)
        # Subscriptions and fixed bills: what they cost per year, and charges that look recurring.
        self.commitments = summary_table(
            ["Descrição", "Valor", "Frequência", "Por ano", "Última cobrança", "Situação"], max_rows=10
        )
        self.commitments.setAccessibleName("Assinaturas e contas fixas")
        stretch_column(self.commitments, 0)
        self.commitments_section = Collapsible(
            "Assinaturas e contas fixas",
            "recorrencias/assinaturas",
            caption="Despesas recorrentes ativas, do maior custo anual para o menor. "
            "A última cobrança vem do lançamento vinculado à previsão.",
        )
        self.commitments_total = text("", "strong")
        self.commitments_section.add(self.commitments_total)
        self.commitments_section.add(self.commitments)
        self.candidates = summary_table(["Descrição", "Valor", "Dia", "Meses seguidos", "Última"], max_rows=8)
        self.candidates.setAccessibleName("Cobranças que parecem recorrentes")
        stretch_column(self.candidates, 0)
        self.candidates.doubleClicked.connect(lambda _: self.create_from_candidate())
        self._candidates: list = []
        self.candidates_section = Collapsible(
            "Parecem recorrentes",
            "recorrencias/candidatas",
            caption="Cobranças com a mesma descrição e valor parecido em meses seguidos, sem recorrência. "
            "Nada é criado sozinho.",
        )
        self.candidates_section.add_actions(button("Criar recorrência…", self.create_from_candidate))
        self.candidates_section.add(self.candidates)
        scroll, body = scroll_body()
        body.addWidget(rules_section)
        body.addWidget(forecasts_section)
        # wide: what is already recurring beside what looks recurring but is not registered
        body.addWidget(adaptive(1400, (self.commitments_section, 3), (self.candidates_section, 2)))
        body.addStretch(1)
        self.empty = EmptyState(
            "Nenhuma recorrência",
            "Cadastre contas fixas e receitas esperadas (aluguel, salário, escola). O aplicativo prevê cada "
            "vencimento, avisa quando atrasa e liga a previsão ao lançamento quando ele acontece. "
            "Previsões nunca alteram saldos.",
            [button("Nova recorrência…", self.add)],
        )
        self.views = QStackedWidget()
        self.views.addWidget(scroll)
        self.views.addWidget(self.empty)
        layout = self.page_layout()
        layout.addWidget(self.views, 1)

    def _window(self) -> tuple[date, date]:
        today = date.today()
        return today - timedelta(days=92), today + timedelta(days=186)

    def refresh(self) -> None:
        if self.session is None:
            for table in (self.rules, self.forecast_table, self.commitments, self.candidates):
                table.setRowCount(0)
            self._candidates = []
            return
        ledger = self.session.ledger
        all_rules = list(rules(ledger).values())
        self.views.setCurrentIndex(0 if all_rules else 1)
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
                for r in all_rules
            ],
        )
        start, end = self._window()
        self._forecasts = forecasts(ledger, start, end)
        rows = [
            ([fmt_date(f.due_on), f.description, fmt(f.amount), FORECAST_LABELS[f.status]], index)
            for index, f in enumerate(self._forecasts)
        ]
        set_rows(self.forecast_table, rows)  # type: ignore[arg-type] - row key is the forecast index
        late = [r for r, f in enumerate(self._forecasts) if f.status is ForecastStatus.LATE]
        for row in late:  # the state is in words; color only reinforces it
            item = self.forecast_table.item(row, 3)
            if item is not None:
                item.setForeground(QColor(tokens().warning))
        for table in (self.rules, self.forecast_table):
            fit_to_rows(table)
        self._refresh_subscriptions()
        # Charges that look recurring are worth showing even before the first rule exists.
        self.views.setCurrentIndex(0 if all_rules or self._candidates else 1)
        active = sum(1 for r in all_rules if not r.paused)
        summary = [f"{active} regra(s) ativa(s)"] if all_rules else []
        if late:
            summary.append(f"{len(late)} previsão(ões) atrasada(s)")
        self.header.set_subtitle(" · ".join(summary))

    def _refresh_subscriptions(self) -> None:
        assert self.session is not None
        from opesvault.domain.subscriptions import candidates as recurring_candidates
        from opesvault.domain.subscriptions import commitments

        ledger = self.session.ledger
        found = commitments(ledger)
        rows = []
        for c in found:
            if c.price_changed:
                situation = "Valor mudou"
            elif c.last_paid is None:
                situation = "Sem cobrança vinculada"
            else:
                situation = "Como previsto"
            last = f"{fmt(c.last_paid)} em {fmt_date(c.last_paid_on)}" if c.last_paid is not None else "—"
            rows.append(
                (
                    [
                        c.rule.description,
                        fmt(c.rule.amount),
                        FREQUENCY_LABELS[c.rule.frequency],
                        fmt(c.per_year),
                        last,
                        situation,
                    ],
                    c.rule.id,
                )
            )
        set_rows(self.commitments, rows)
        for row, c in enumerate(found):
            item = self.commitments.item(row, 5)
            if item is not None and c.price_changed:
                item.setForeground(QColor(tokens().warning))  # the words carry the state; color reinforces
        fit_to_rows(self.commitments)
        total = sum((c.per_year for c in found), ZERO)
        self.commitments_total.setText(f"{len(found)} compromisso(s) · {fmt(total)} por ano")
        self.commitments_section.setVisible(bool(found))
        self._candidates = recurring_candidates(ledger)
        set_rows(
            self.candidates,
            [
                ([c.description, fmt(c.amount), str(c.day), str(c.months), fmt_date(c.last_on)], index)
                for index, c in enumerate(self._candidates)
            ],  # type: ignore[arg-type] - row key is the candidate index
        )
        fit_to_rows(self.candidates)
        self.candidates_section.setVisible(bool(self._candidates))

    def create_from_candidate(self) -> None:
        index = selected_id(self.candidates)
        if self.session is None or not isinstance(index, int) or index >= len(self._candidates):
            return
        ledger = self.session.ledger
        dialog = RuleDialog(self, ledger, self._candidates[index])
        if dialog.exec() and run_guarded(self, lambda: add_rule(ledger, dialog.build())):
            self.notify("Recorrência criada a partir das cobranças repetidas.")
            self.changed()

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
        if not confirm(self, f"Vincular {len(pairs)} previsão(ões) aos lançamentos?", summary, "Vincular"):
            return
        for forecast, op in pairs:
            run_guarded(self, lambda f=forecast, o=op: realize(ledger, f.rule_id, f.due_on, o.id))
        self.changed()

    def reveal(self, ref: object, *, act: bool = False) -> None:
        """A forecast alert: select that forecast and, when it is late, open Vincular.

        ("rule", id): a price change, shown in the subscriptions section.
        """
        if isinstance(ref, tuple) and len(ref) == 2 and ref[0] == "rule":
            self.commitments_section.set_expanded(True)
            for table in (self.rules, self.commitments):
                for row in range(table.rowCount()):
                    item = table.item(row, 0)
                    if item is not None and item.data(Qt.ItemDataRole.UserRole) == ref[1]:
                        table.selectRow(row)
            return
        if not (isinstance(ref, tuple) and len(ref) == 2):
            return
        rule_id, due_on = ref
        for row in range(self.forecast_table.rowCount()):
            item = self.forecast_table.item(row, 0)
            index = item.data(Qt.ItemDataRole.UserRole) if item is not None else None
            if isinstance(index, int) and index < len(self._forecasts):
                forecast = self._forecasts[index]
                if (forecast.rule_id, forecast.due_on) == (rule_id, due_on):
                    self.forecast_table.selectRow(row)
                    if act:
                        self.link_selected()
                    return

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
