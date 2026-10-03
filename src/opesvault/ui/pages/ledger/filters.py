"""The ledger's search and filters: the widgets, what they select and how they are set from outside.

`LedgerFilters` owns the controls and turns them into an `OperationFilter`; it emits `changed`
once per choice (the search after a short pause), so the page refreshes once. Setting several
controls at once (a reset, a reveal from another page, a saved filter) emits `changed` once.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from typing import Any
from uuid import UUID

from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtWidgets import QComboBox, QLineEdit, QWidget

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountSubtype, AccountType, OriginKind, YearMonth
from opesvault.domain.search import OperationFilter, StatusFilter
from opesvault.ui.common import fill_combo, month_label, select_combo
from opesvault.ui.components import button, flow_row, hbox, text
from opesvault.ui.operation_edit import OptionalDate
from opesvault.ui.pages.ledger.model import MONTH_PERIOD, ORIGIN_LABELS, PERIODS, STATUS_LABELS, period_range

SEARCH_PAUSE_MS = 250


class LedgerFilters(QObject):
    changed = Signal()

    def __init__(self, parent: QWidget) -> None:
        super().__init__(parent)
        self.search = QLineEdit()
        self.search.setPlaceholderText("Buscar descrição ou observação")
        self.search.setClearButtonEnabled(True)
        self.search.setAccessibleName("Buscar lançamentos")
        self.search.setToolTip("Buscar (Ctrl+F)")
        self.search.setMinimumWidth(200)
        self.debounce = QTimer(self)
        self.debounce.setSingleShot(True)
        self.debounce.setInterval(SEARCH_PAUSE_MS)
        self.debounce.timeout.connect(lambda: self.changed.emit())
        self.search.textChanged.connect(lambda _: self.debounce.start())

        self.period = QComboBox()
        self.period.setAccessibleName("Período")
        fill_combo(self.period, list(PERIODS))
        self.month = YearMonth.of(date.today())
        self._label_month()
        self.start = OptionalDate(None)
        self.end = OptionalDate(None)
        self.start.edit.setAccessibleName("Data inicial")
        self.end.edit.setAccessibleName("Data final")
        for optional in (self.start, self.end):
            optional.known.setChecked(True)
            optional.known.hide()
        self.custom_dates = QWidget()
        self.custom_dates.setLayout(hbox(self.start, text("até", "secondary"), self.end))
        self.custom_dates.hide()
        self.account = QComboBox()
        self.account.setAccessibleName("Conta ou categoria")
        self.member = QComboBox()
        self.member.setAccessibleName("Integrante")
        self.status = QComboBox()
        self.status.setAccessibleName("Situação")
        fill_combo(self.status, [(label, s) for s, label in STATUS_LABELS.items()])
        self.tag = QComboBox()
        self.tag.setAccessibleName("Marcador")
        self.origin = QComboBox()
        self.origin.setAccessibleName("Origem")
        fill_combo(self.origin, [(label, o) for o, label in ORIGIN_LABELS.items()], empty="Todas as origens")
        # Short, fixed option lists show their whole text (the row wraps on narrow windows);
        # account names can be long, so that one keeps a bounded width.
        for combo in (self.period, self.member, self.status, self.origin, self.tag):
            combo.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToContents)
        self.account.setMinimumContentsLength(18)
        self.account.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon)
        self.period.currentIndexChanged.connect(self._period_changed)
        for combo in self.combos()[1:]:
            combo.currentIndexChanged.connect(lambda _: self.changed.emit())
        for optional in (self.start, self.end):
            optional.edit.dateChanged.connect(lambda _: self.changed.emit())
        self.clear_button = button("Limpar filtros", self.reset, role="plain")
        self.row = flow_row(
            self.period,
            self.custom_dates,
            self.account,
            self.member,
            self.status,
            self.origin,
            self.tag,
            self.clear_button,
        )

    def add_to_row(self, *widgets: QWidget) -> None:
        """Commands that wrap together with the filters (saved filters, row actions)."""
        flow = self.row.layout()
        assert flow is not None
        for widget in widgets:
            flow.addWidget(widget)

    def combos(self) -> tuple[QComboBox, ...]:
        """Period first: every filter that a reset or a reveal puts back to its first option."""
        return (self.period, self.account, self.member, self.status, self.origin, self.tag)

    @contextmanager
    def _quietly(self) -> Iterator[None]:
        """Several controls set at once; `changed` is emitted once, at the end."""
        widgets = [*self.combos(), self.search, self.start.edit, self.end.edit]
        for widget in widgets:
            widget.blockSignals(True)
        try:
            yield
        finally:
            for widget in widgets:
                widget.blockSignals(False)
        self.custom_dates.setVisible(self.period.currentData() == "custom")
        self.changed.emit()

    def _period_changed(self) -> None:
        self.custom_dates.setVisible(self.period.currentData() == "custom")
        self.changed.emit()

    def _label_month(self) -> None:
        self.period.setItemText(MONTH_PERIOD, month_label(self.month).capitalize())

    # ── the choices ─────────────────────────────────

    def fill(self, ledger: Ledger | None) -> None:
        """Accounts, members and tags of this vault, keeping the current choice; none without a vault.

        Their names are the vault's data, so a closed vault leaves the lists empty (TA-31).
        """
        accounts = sorted(ledger.accounts.values(), key=lambda a: (a.type.value, a.name.casefold())) if ledger else []
        self._refill(
            self.account,
            [
                (a.name if a.subtype is not AccountSubtype.CATEGORY else f"Categoria: {a.name}", a.id)
                for a in accounts
                if a.type in (AccountType.ASSET, AccountType.LIABILITY) or a.subtype is AccountSubtype.CATEGORY
            ],
            "Todas as contas",
        )
        members = [(m.name, m.id) for m in ledger.members.values()] if ledger else []
        self._refill(self.member, members, "Todos os integrantes")
        from opesvault.domain.tags import all_tags

        self._refill(self.tag, [(t, t) for t in all_tags(ledger)] if ledger else [], "Todos os marcadores")
        self.tag.setVisible(self.tag.count() > 1 or self.tag.currentIndex() > 0)

    @staticmethod
    def _refill(combo: QComboBox, items: list[tuple[str, Any]], empty: str) -> None:
        current = combo.currentData()
        was_blocked = combo.blockSignals(True)  # inside `_quietly` it must stay blocked
        fill_combo(combo, items, empty=empty)
        combo.setCurrentIndex(0)
        select_combo(combo, current)
        combo.blockSignals(was_blocked)

    def current(self, ledger: Ledger) -> OperationFilter:
        key = self.period.currentData() or "all"
        if key == "custom":
            start, end = self.start.value(), self.end.value()
        elif key == "month":
            start, end = self.month.first_day(), self.month.last_day()
        else:
            start, end = period_range(key, date.today())
        return OperationFilter(
            start=start,
            end=end,
            account_id=self.account.currentData(),
            member_id=self.member.currentData(),
            text=self.search.text(),
            status=self.status.currentData() or StatusFilter.ALL,
            origin=self.origin.currentData(),
            operation_ids=self._tagged(ledger),
        )

    def _tagged(self, ledger: Ledger) -> frozenset[UUID] | None:
        tag = self.tag.currentData()
        if tag is None:
            return None
        from opesvault.domain.tags import operations_with

        return frozenset(operations_with(ledger, tag))

    def active(self) -> bool:
        return any(c.currentIndex() > 0 for c in self.combos()) or bool(self.search.text().strip())

    def only_period(self) -> bool:
        """The month is the only choice: the empty state then offers the whole period."""
        others = self.combos()[1:]
        return not any(c.currentIndex() > 0 for c in others) and not self.search.text().strip()

    def month_only(self) -> bool:
        return self.period.currentData() == "month" and self.only_period()

    # ── set from outside ────────────────────────────

    def reset(self) -> None:
        with self._quietly():
            for combo in self.combos():
                combo.setCurrentIndex(0)
            self.search.clear()

    def follow_month(self, month: YearMonth) -> bool:
        """The month chosen in the Overview or the Budget; True when the shown operations change."""
        if month == self.month:
            return False
        self.month = month
        self._label_month()
        return self.period.currentData() == "month"

    def show_tag(self, ledger: Ledger, tag: str) -> None:
        with self._quietly():
            for combo in self.combos():
                combo.setCurrentIndex(0)
            self.search.clear()
            self.fill(ledger)
            select_combo(self.tag, tag)

    def show(self, ledger: Ledger, account_id: UUID | None, period: object, member_id: UUID | None = None) -> None:
        """The operations behind a number: an account or category, in a month, a (start, end) or all."""
        custom = isinstance(period, tuple)
        index = MONTH_PERIOD if isinstance(period, YearMonth) else self.period.count() - 1 if custom else 0
        with self._quietly():
            for combo in self.combos():
                combo.setCurrentIndex(index if combo is self.period else 0)
            if isinstance(period, tuple):
                for optional, day in zip((self.start, self.end), period, strict=True):
                    optional.set_value(day)
            self.search.clear()
            if isinstance(period, YearMonth):
                self.month = period
                self._label_month()
            self.fill(ledger)
            select_combo(self.account, account_id)
            select_combo(self.member, member_id)

    def apply_saved(self, ledger: Ledger, saved: Any) -> None:
        with self._quietly():
            self.fill(ledger)
            for combo, value in (
                (self.period, saved.period),
                (self.account, saved.account_id),
                (self.member, saved.member_id),
                (self.status, StatusFilter(saved.status)),
                (self.origin, OriginKind(saved.origin) if saved.origin else None),
                (self.tag, saved.tag),
            ):
                combo.setCurrentIndex(0)
                select_combo(combo, value)
            self.search.setText(saved.text)

    def snapshot(self, name: str) -> Any:
        """The current choice as a filter to keep in the vault (a custom period is not kept)."""
        from opesvault.domain.saved_filters import SavedFilter

        status = self.status.currentData()
        origin = self.origin.currentData()
        return SavedFilter(
            name=name,
            period=self.period.currentData() or "all",
            account_id=self.account.currentData(),
            member_id=self.member.currentData(),
            text=self.search.text().strip(),
            status=str(status.value if hasattr(status, "value") else status or "all"),
            origin=str(origin.value if hasattr(origin, "value") else origin) if origin else None,
            tag=self.tag.currentData(),
        )
