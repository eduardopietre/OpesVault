"""Calendário: card bills, recurrences and loan installments of the month, day by day
(docs/09 §1.3 E). Each event opens the screen where it is resolved."""

import calendar
from datetime import date
from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import QAbstractItemView, QHeaderView, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget

from opesvault.domain.agenda import STATE_LABELS, AgendaEvent, EventState, by_day, month_events
from opesvault.domain.model import YearMonth
from opesvault.domain.money import ZERO
from opesvault.ui.common import fit_to_rows, fmt, fmt_date, month_label, set_rows, stretch_column, summary_table
from opesvault.ui.components import Collapsible, Figures, MonthPicker, adaptive, button, scroll_body, text
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_L, tokens

WEEKDAYS = ("Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb")
KIND_LABELS = {
    "fatura": "Fatura",
    "recorrência": "Recorrência",
    "financiamento": "Financiamento",
    "vencimento": "Investimento",
}
DAY_ROLE = Qt.ItemDataRole.UserRole + 1


class AgendaPage(Page):
    title = "Calendário"
    section = "Dia a dia"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.month = MonthPicker(months_back=24, months_ahead=12)
        self._following = False
        self.month.changed.connect(self._month_changed)
        self.header.add(self.month)
        self.figures = Figures(["A pagar", "Atrasado", "Já pago", "A receber"])
        self.grid = QTableWidget(0, 7)
        self.grid.setHorizontalHeaderLabels(list(WEEKDAYS))
        self.grid.setAccessibleName("Dias do mês")
        self.grid.verticalHeader().setVisible(False)
        self.grid.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.grid.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.grid.setWordWrap(True)
        self.grid.setProperty("variant", "plain")
        self.grid.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.grid.verticalHeader().setDefaultSectionSize(64)
        self.grid.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.grid.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.grid.itemSelectionChanged.connect(self._day_selected)
        self.events = summary_table(["Data", "Descrição", "Tipo", "Valor", "Situação"], max_rows=12)
        self.events.setAccessibleName("Vencimentos")
        stretch_column(self.events, 1)
        self.events.doubleClicked.connect(lambda _: self.open_selected())
        self.events_section = Collapsible("Vencimentos do mês", "calendario/lista")
        self.open_button = button("Abrir…", self.open_selected, tip="Abre a tela onde se paga ou vincula")
        self.show_month = button("Mês inteiro", self._show_whole_month, role="plain")
        self.events_section.add_actions(self.show_month, self.open_button)
        self.events_section.add(self.events)
        self.caption = text(
            "Faturas de cartão, contas recorrentes e parcelas de financiamento. Compras parceladas aparecem "
            "dentro da fatura. Previsões não alteram saldos.",
            "caption",
            wrap=True,
        )
        self._events: list[AgendaEvent] = []
        self._shown: list[AgendaEvent] = []
        self._day: date | None = None
        scroll, content = scroll_body()
        content.setSpacing(SPACE_L)
        content.addWidget(self.figures)
        month_view = QWidget()
        days = QVBoxLayout(month_view)
        days.setContentsMargins(0, 0, 0, 0)
        days.setSpacing(SPACE_L)
        days.addWidget(self.grid)
        days.addWidget(self.caption)
        # wide: the list of the month (or of the chosen day) beside the calendar, not below it
        content.addWidget(adaptive(1200, (month_view, 3), (self.events_section, 2)))
        content.addStretch(1)
        layout = self.page_layout()
        layout.addWidget(scroll, 1)

    def _month_changed(self) -> None:
        self._day = None
        self.refresh()
        if not self._following:
            self.month_chosen(self.month.current())

    def follow_month(self, month: object) -> None:
        self._following = True
        try:
            self.month.set_month(month)
        finally:
            self._following = False

    def refresh(self) -> None:
        if self.session is None:
            self.grid.setRowCount(0)
            self.events.setRowCount(0)
            return
        month: YearMonth = self.month.current()
        today = date.today()
        self._events = month_events(self.session.ledger, month, today)
        pending = [e for e in self._events if e.state is not EventState.DONE]
        self.figures.set("A pagar", fmt(sum((-e.amount for e in pending if e.amount < 0), ZERO)))
        late = sum((-e.amount for e in pending if e.amount < 0 and e.state is EventState.LATE), ZERO)
        self.figures.set("Atrasado", fmt(late), "negative" if late else None)
        done = [e for e in self._events if e.state is EventState.DONE and e.amount < 0]
        self.figures.set("Já pago", fmt(sum((-e.amount for e in done), ZERO)))
        self.figures.set("A receber", fmt(sum((e.amount for e in pending if e.amount > 0), ZERO)))
        self.header.set_subtitle(f"{len(self._events)} vencimento(s) em {month_label(month)}")
        self._fill_grid(month, today)
        self._show_events()

    def _fill_grid(self, month: YearMonth, today: date) -> None:
        days = by_day(self._events)
        first_weekday = (month.first_day().weekday() + 1) % 7  # Sunday first, as Brazilian calendars
        last = calendar.monthrange(month.year, month.month)[1]
        rows = (first_weekday + last + 6) // 7
        self.grid.blockSignals(True)
        self.grid.clearContents()
        self.grid.setRowCount(rows)
        t = tokens()
        for index in range(rows * 7):
            day = index - first_weekday + 1
            row, column = divmod(index, 7)
            if not 1 <= day <= last:
                empty = QTableWidgetItem("")
                empty.setFlags(Qt.ItemFlag.NoItemFlags)
                self.grid.setItem(row, column, empty)
                continue
            when = date(month.year, month.month, day)
            found = days.get(when, [])
            lines = [str(day) + (" · hoje" if when == today else "")]
            if found:  # one short line: the amount due (and how many items), details in the list below
                out = sum((-e.amount for e in found if e.amount < 0), ZERO)
                count = f" ({len(found)})" if len(found) > 1 else ""
                lines.append((fmt(out) if out else f"{len(found)} item(ns)") + count)
            item = QTableWidgetItem("\n".join(lines))
            item.setTextAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
            item.setData(DAY_ROLE, when)
            if found:
                item.setToolTip("\n".join(f"{e.title} · {fmt(abs(e.amount))} · {STATE_LABELS[e.state]}" for e in found))
                if any(e.state is EventState.LATE for e in found):
                    item.setForeground(QColor(t.warning))  # "Atrasado" is in the list below, in words
                font = item.font()
                font.setBold(True)
                item.setFont(font)
            self.grid.setItem(row, column, item)
        self.grid.blockSignals(False)
        header = self.grid.horizontalHeader().sizeHint().height()
        self.grid.setFixedHeight(header + rows * self.grid.verticalHeader().defaultSectionSize() + 2)

    def _day_selected(self) -> None:
        item = self.grid.currentItem()
        when = item.data(DAY_ROLE) if item is not None else None
        self._day = when if isinstance(when, date) else None
        self._show_events()

    def _show_whole_month(self) -> None:
        self._day = None
        self.grid.clearSelection()
        self._show_events()

    def _show_events(self) -> None:
        self._shown = [e for e in self._events if self._day is None or e.on == self._day]
        title = f"Vencimentos de {fmt_date(self._day)}" if self._day else "Vencimentos do mês"
        self.events_section.set_title(title)
        self.show_month.setVisible(self._day is not None and self.events_section.expanded)
        rows: list[tuple[list[Any], Any]] = [
            (
                [fmt_date(e.on), e.title, KIND_LABELS.get(e.kind, e.kind), fmt(abs(e.amount)), STATE_LABELS[e.state]],
                index,
            )
            for index, e in enumerate(self._shown)
        ]
        set_rows(self.events, rows)
        for row, event in enumerate(self._shown):
            item = self.events.item(row, 4)
            if item is not None and event.state is EventState.LATE:
                item.setForeground(QColor(tokens().warning))
        fit_to_rows(self.events)

    def open_selected(self) -> None:
        from opesvault.ui.common import selected_id

        index = selected_id(self.events)
        if not isinstance(index, int) or index >= len(self._shown):
            return
        event = self._shown[index]
        # A pending bill or installment opens ready to pay; a late recurrence ready to link.
        act = event.state is not EventState.DONE and (
            event.target == "accounts" or (event.target == "recurrences" and event.state is EventState.LATE)
        )
        self.navigate(event.target, event.ref, act=act)
