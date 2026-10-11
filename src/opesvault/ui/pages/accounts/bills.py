"""Faturas: a card's bills around today, the chart of them and paying the selected one (docs/04 §5)."""

from datetime import date
from typing import TYPE_CHECKING, Any

from PySide6.QtWidgets import QComboBox

from opesvault.domain.cards import BillStatus
from opesvault.domain.model import YearMonth
from opesvault.ui.common import fmt, frameless, make_table, run_guarded, select_combo, select_id, selected_id, set_rows
from opesvault.ui.components import Collapsible, button, hbox, text
from opesvault.ui.pages.accounts.tab import PageTab

if TYPE_CHECKING:
    from opesvault.ui.pages.base import Page

MONTHS_AROUND = 6  # bills shown before and after the current month
STATUS_COLUMN = 9
BILL_LABELS = {
    BillStatus.OPEN: "Aberta",
    BillStatus.CLOSED: "Fechada",
    BillStatus.PAID: "Paga",
    BillStatus.PARTIAL: "Paga parcialmente",
    BillStatus.OVERDUE: "Vencida",
}


class BillsTab(PageTab):
    def __init__(self, page: "Page") -> None:
        super().__init__(page)
        from opesvault.charts.render import ChartWidget

        self._bills: dict[YearMonth, Any] = {}  # bill month -> Bill
        self.card = QComboBox()
        self.card.setAccessibleName("Cartão")
        self.card.currentIndexChanged.connect(self.show_bills)
        self.table = make_table(
            [
                "Vencimento",
                "Fechamento",
                "Lançamentos",
                "Parcelas",
                "Créditos",
                "Total",
                "Pago",
                "Saldo",
                "Documento",
                "Situação",
            ]
        )
        self.table.setAccessibleName("Faturas do cartão")
        self.table.itemSelectionChanged.connect(self._bill_selected)
        self.table.doubleClicked.connect(lambda _: self.pay())
        self.pay_button = button("Pagar…", self.pay, role="primary", tip="Registra o pagamento da fatura selecionada")
        # The bills over time above the table of bills: the same numbers, read as a trend.
        self.chart = ChartWidget()
        self.chart.setFixedHeight(240)
        self.chart.setAccessibleName("Gráfico das faturas")
        self.chart_section = Collapsible("Faturas mês a mês", "contas/faturas_grafico")
        self.chart_section.add(self.chart)
        layout = self.column()
        layout.addLayout(hbox(text("Cartão", "secondary"), self.card, self.pay_button, None))
        layout.addWidget(self.chart_section)
        layout.addWidget(frameless(self.table), 1)

    def refresh(self) -> None:
        """Keeps the card that was chosen (when it still exists) and shows its bills."""
        current = self.card.currentData()
        self.card.blockSignals(True)
        self.card.clear()
        if self.session is not None:
            for card in self.session.ledger.cards.values():
                self.card.addItem(card.name, card.id)
            self.card.setCurrentIndex(0)
            select_combo(self.card, current)
        self.card.blockSignals(False)
        self.show_bills()

    def show_bills(self) -> None:
        card_id = self.card.currentData()
        if self.session is None or card_id is None:
            self.table.setRowCount(0)
            self.chart.clear()
            self._bills = {}
            self._bill_selected()
            return
        from opesvault.charts.data import card_bills_history
        from opesvault.domain.cards import bills
        from opesvault.importing.pipeline import batches

        ledger = self.session.ledger
        today = date.today()
        months = [YearMonth.of(today).add(offset) for offset in range(-MONTHS_AROUND, MONTHS_AROUND + 1)]
        imported = {
            YearMonth.of(b.header.due_on): b.header.total
            for b in batches(ledger).values()
            if b.card_id == card_id and b.header.due_on is not None and b.header.total is not None
        }
        self._bills = {}
        rows = []
        for bill in bills(ledger, card_id, months):
            document_total = imported.get(bill.cycle.month)
            if bill.total == 0 and bill.payments == 0 and document_total is None:
                continue
            doc_label = "—" if document_total is None else fmt(document_total)
            if document_total is not None and document_total != bill.total:
                doc_label += " (diverge)"
            self._bills[bill.cycle.month] = bill
            rows.append(
                (
                    [
                        bill.cycle.due.strftime("%d/%m/%Y"),
                        bill.cycle.closing.strftime("%d/%m/%Y"),
                        fmt(bill.charges),
                        fmt(bill.installments),
                        fmt(bill.credits),
                        fmt(bill.total),
                        fmt(bill.payments),
                        fmt(bill.remaining),
                        doc_label,
                        BILL_LABELS[bill.status(today)],
                    ],
                    bill.cycle.month,
                )
            )
        set_rows(self.table, rows)
        if rows and not self.table.selectedItems():
            # the oldest bill still open is the one to pay: "Pagar…" is ready without a click
            states = [self.table.item(r, STATUS_COLUMN) for r in range(self.table.rowCount())]
            open_rows = [r for r, cell in enumerate(states) if cell is not None and cell.text() != "Paga"]
            self.table.selectRow(open_rows[-1] if open_rows else 0)
        self._bill_selected()
        shown = [m for m in months if m in self._bills]
        if shown:
            self.chart.show_chart(card_bills_history(ledger, card_id, shown))
        else:
            self.chart.clear()
        self.chart_section.setVisible(bool(shown))

    def show_bill(self, card_id: object, month: object, *, pay: bool = False) -> None:
        """A bill alert: that card, that bill selected and, when asked, its payment open."""
        self.card.setCurrentIndex(0)
        select_combo(self.card, card_id)
        self.show_bills()
        select_id(self.table, month)
        if pay:
            self.pay()

    def _selected(self) -> Any:
        month = selected_id(self.table)
        return self._bills.get(month) if month is not None else None

    def _bill_selected(self) -> None:
        bill = self._selected()
        self.pay_button.setEnabled(bill is not None and bill.remaining > 0)

    def pay(self) -> None:
        """Pays the selected bill: the card, the remaining amount and today come filled in."""
        bill = self._selected()
        card_id = self.card.currentData()
        if self.session is None or bill is None or card_id is None or bill.remaining <= 0:
            return
        from opesvault.ui.dialogs import BillPaymentDialog

        ledger = self.session.ledger
        dialog = BillPaymentDialog(self, ledger, ledger.cards[card_id], bill)
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.notify(f"Pagamento da fatura de {ledger.cards[card_id].name} registrado.")
            self.changed()
