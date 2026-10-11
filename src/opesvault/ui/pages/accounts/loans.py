"""Financiamentos: each contract with its schedule, what is left to pay and early payments."""

from datetime import date
from typing import TYPE_CHECKING

from opesvault.ui.common import (
    fit_to_rows,
    fmt,
    fmt_date,
    run_guarded,
    select_id,
    selected_id,
    set_rows,
    stretch_column,
    summary_table,
)
from opesvault.ui.components import Collapsible, Figures, button, hbox, menu_button, scroll_body, text
from opesvault.ui.pages.accounts.tab import PageTab
from opesvault.ui.theme import SPACE_L

if TYPE_CHECKING:
    from opesvault.ui.pages.base import Page


class LoansTab(PageTab):
    """Loans and financing: the contract, its schedule and what is left to pay."""

    def __init__(self, page: "Page") -> None:
        super().__init__(page)
        from opesvault.charts.render import ChartWidget

        self.table = summary_table(
            ["Financiamento", "Sistema", "Taxa", "Parcelas pagas", "Próxima", "Saldo devedor", "No livro"], max_rows=6
        )
        self.table.setAccessibleName("Financiamentos")
        stretch_column(self.table)
        self.table.itemSelectionChanged.connect(self._show_detail)
        self.figures = Figures(["Saldo devedor", "Juros a pagar", "Parcelas vencidas", "Termina em"])
        self.chart = ChartWidget()
        self.chart.setFixedHeight(260)
        self.chart.setAccessibleName("Gráfico do financiamento")
        chart_section = Collapsible("Saldo devedor, juros e amortização", "contas/financiamento_grafico")
        chart_section.add(self.chart)
        self.schedule = summary_table(
            ["Nº", "Vencimento", "Parcela", "Amortização", "Juros", "Seguros e tarifas", "Saldo após", "Situação"],
            max_rows=14,
        )
        self.schedule.setAccessibleName("Cronograma de parcelas")
        self.schedule.doubleClicked.connect(lambda _: self.pay())
        schedule_section = Collapsible("Cronograma", "contas/financiamento_cronograma")
        schedule_section.add_actions(button("Pagar parcela…", self.pay))
        schedule_section.add(self.schedule)
        self.empty = text(
            "Nenhum financiamento. Cadastre o contrato para acompanhar parcelas, juros e o saldo devedor, "
            "e simular amortizações antecipadas.",
            "secondary",
            wrap=True,
        )
        layout = self.column()
        layout.addLayout(
            hbox(
                button("Novo financiamento…", self.add),
                button("Pagar parcela…", self.pay),
                menu_button(
                    "Mais",
                    [
                        ("Simular ou registrar amortização antecipada…", self.prepay),
                        ("Ver lançamentos do financiamento", self.open_ledger),
                    ],
                ),
                None,
            )
        )
        scroll, content = scroll_body()
        content.setSpacing(SPACE_L)
        content.addWidget(self.empty)
        content.addWidget(self.table)
        content.addWidget(self.figures)
        content.addWidget(chart_section)
        content.addWidget(schedule_section)
        content.addStretch(1)
        layout.addWidget(scroll, 1)
        self._detail = (self.figures, chart_section, schedule_section)

    def show_installment(self, plan_id: object, number: object, *, pay: bool = False) -> None:
        """A loan alert: the contract and the installment selected; `pay` opens its payment."""
        select_id(self.table, plan_id)
        self._show_detail()
        select_id(self.schedule, number)
        if pay:
            self.pay()

    def refresh(self) -> None:
        if self.session is None:
            self.table.setRowCount(0)
            self._show_detail()
            return
        from opesvault.domain.loans import SYSTEM_LABELS, plans, status
        from opesvault.ui.planning_dialogs import rate_label

        ledger = self.session.ledger
        selected = selected_id(self.table)
        rows = []
        for plan in sorted(plans(ledger).values(), key=lambda p: p.name.casefold()):
            current = status(ledger, plan.id)
            following = current.next_due
            rows.append(
                (
                    [
                        plan.name,
                        SYSTEM_LABELS[plan.system].split(" (")[0],
                        rate_label(plan.monthly_rate),
                        f"{current.paid} de {len(current.installments)}",
                        f"{fmt_date(following.due)} · {fmt(following.payment)}" if following else "quitado",
                        fmt(current.outstanding),
                        fmt(current.ledger_balance),
                    ],
                    plan.id,
                )
            )
        set_rows(self.table, rows)
        fit_to_rows(self.table)
        self.table.setVisible(bool(rows))
        self.empty.setVisible(not rows)
        select_id(self.table, selected)
        if rows and selected_id(self.table) is None:
            self.table.selectRow(0)
        self._show_detail()

    def _show_detail(self) -> None:
        plan_id = selected_id(self.table)
        for widget in self._detail:
            widget.setVisible(plan_id is not None and self.session is not None)
        if plan_id is None or self.session is None:
            self.schedule.setRowCount(0)
            self.chart.clear()
            return
        from opesvault.charts.data import loan_chart
        from opesvault.domain.loans import STATE_LABELS, InstallmentState, state_of, status

        ledger = self.session.ledger
        today = date.today()
        current = status(ledger, plan_id, today)
        self.figures.set("Saldo devedor", fmt(current.outstanding))
        self.figures.set("Juros a pagar", fmt(current.interest_to_come))
        self.figures.set("Parcelas vencidas", str(current.overdue), "negative" if current.overdue else None)
        self.figures.set("Termina em", fmt_date(current.end))
        self.chart.show_chart(loan_chart(ledger, plan_id))
        selected = selected_id(self.schedule)
        rows = []
        for item in current.installments:
            state = state_of(ledger, plan_id, item, today)
            label = STATE_LABELS[state]
            if item.prepaid_after:
                label += f" · amortização antecipada de {fmt(item.prepaid_after)}"
            rows.append(
                (
                    [
                        str(item.number),
                        fmt_date(item.due),
                        fmt(item.payment),
                        fmt(item.amortization),
                        fmt(item.interest),
                        fmt(item.fees),
                        fmt(item.balance_after),
                        label,
                    ],
                    item.number,
                )
            )
        set_rows(self.schedule, rows)
        fit_to_rows(self.schedule)
        select_id(self.schedule, selected)
        if selected_id(self.schedule) is None:
            following = next(
                (i for i in current.installments if state_of(ledger, plan_id, i, today) is not InstallmentState.PAID),
                None,
            )
            if following is not None:
                select_id(self.schedule, following.number)
                current = self.schedule.item(self.schedule.currentRow(), 0)
                if current is not None:
                    self.schedule.scrollToItem(current)

    def add(self) -> None:
        if self.session is None:
            return
        from opesvault.ui.planning_dialogs import LoanDialog

        dialog = LoanDialog(self, self.session.ledger)
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.notify("Financiamento criado. O cronograma foi calculado pelo contrato.")
            self.changed()

    def pay(self) -> None:
        plan_id = selected_id(self.table)
        number = selected_id(self.schedule)
        if self.session is None or plan_id is None or number is None:
            return
        from opesvault.domain.loans import paid_numbers, plan_schedule, plans
        from opesvault.ui.planning_dialogs import PayInstallmentDialog

        ledger = self.session.ledger
        if number in paid_numbers(ledger, plan_id):
            self.notify("Esta parcela já está paga.")
            return
        item = next((i for i in plan_schedule(ledger, plan_id) if i.number == number), None)
        if item is None:
            return
        dialog = PayInstallmentDialog(self, ledger, plans(ledger)[plan_id], item)
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.notify(f"Parcela {number} registrada: amortização, juros e encargos separados.")
            self.changed()

    def prepay(self) -> None:
        plan_id = selected_id(self.table)
        if self.session is None or plan_id is None:
            return
        from opesvault.domain.loans import plans
        from opesvault.ui.planning_dialogs import PrepaymentDialog

        ledger = self.session.ledger
        dialog = PrepaymentDialog(self, ledger, plans(ledger)[plan_id])
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.notify("Amortização antecipada registrada; o cronograma foi recalculado.")
            self.changed()

    def open_ledger(self) -> None:
        plan_id = selected_id(self.table)
        if self.session is None or plan_id is None:
            return
        from opesvault.domain.loans import plans

        self.navigate("ledger", ("filter", plans(self.session.ledger)[plan_id].liability_account_id, None))
