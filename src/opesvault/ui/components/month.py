"""Choosing a month: the name in full, with previous and next."""

from PySide6.QtCore import Signal
from PySide6.QtGui import QKeySequence
from PySide6.QtWidgets import (
    QToolButton,
    QWidget,
)

from opesvault.ui.components.basics import hbox


class MonthPicker(QWidget):
    """‹ month ›: steps through competence months; the combo jumps further."""

    changed = Signal()

    def __init__(self, months_back: int = 60, months_ahead: int = 0) -> None:
        from datetime import date

        from PySide6.QtWidgets import QComboBox

        from opesvault.domain.model import YearMonth
        from opesvault.ui.common import month_label

        super().__init__()
        self.combo = QComboBox()
        self.combo.setAccessibleName("Mês")
        today = YearMonth.of(date.today())
        for offset in range(months_back, -months_ahead - 1, -1):
            month = today.add(-offset)
            self.combo.addItem(month_label(month), month)
        self.combo.setCurrentIndex(months_back)  # today
        self.combo.setMinimumContentsLength(16)
        previous = QToolButton()
        previous.setObjectName("Stepper")
        previous.setText("‹")
        previous.setToolTip("Mês anterior (Alt+←)")
        previous.setAccessibleName("Mês anterior")
        previous.setShortcut(QKeySequence("Alt+Left"))
        previous.clicked.connect(lambda: self.step(-1))
        following = QToolButton()
        following.setObjectName("Stepper")
        following.setText("›")
        following.setToolTip("Próximo mês (Alt+→)")
        following.setAccessibleName("Próximo mês")
        following.setShortcut(QKeySequence("Alt+Right"))
        following.clicked.connect(lambda: self.step(1))
        self.combo.setMinimumHeight(previous.sizeHint().height())
        row = hbox(previous, self.combo, following, spacing=2)
        self.setLayout(row)
        self.combo.currentIndexChanged.connect(lambda _: self.changed.emit())

    def current(self):  # type: ignore[no-untyped-def]
        return self.combo.currentData()

    def set_month(self, month: object) -> None:
        # findData compares wrapped Python objects by identity; compare values instead.
        for index in range(self.combo.count()):
            if self.combo.itemData(index) == month:
                self.combo.setCurrentIndex(index)
                return

    def step(self, delta: int) -> None:
        index = self.combo.currentIndex() + delta
        if 0 <= index < self.combo.count():
            self.combo.setCurrentIndex(index)
