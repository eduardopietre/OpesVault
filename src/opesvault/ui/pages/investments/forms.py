"""The small declarative form every investment command fills, and the values it reads."""

from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from PySide6.QtWidgets import QCheckBox, QComboBox, QLineEdit, QWidget

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.money import format_decimal_br
from opesvault.ui.common import combo_value, fill_combo, from_qdate, read_money
from opesvault.ui.dialogs import FormDialog, asset_accounts

Field = tuple[str, str, QWidget]  # key, label, widget


class Form(FormDialog):
    """Fields are (key, label, widget); `check` validates before the dialog closes."""

    def __init__(self, parent: QWidget, title: str, fields: list[Field], check: Any = None) -> None:
        super().__init__(parent, title, "Registrar")
        self.fields = {key: widget for key, _, widget in fields}
        for _, label, widget in fields:
            self.form.addRow(label, widget)
        self._check = check

    def money(self, key: str, *, optional: bool = False) -> Decimal | None:
        widget = self.fields[key]
        assert isinstance(widget, QLineEdit)
        return read_money(widget, allow_empty=optional)

    def date(self, key: str) -> date:
        return from_qdate(self.fields[key].date())  # type: ignore[attr-defined]

    def value(self, key: str) -> Any:
        widget = self.fields[key]
        if isinstance(widget, QComboBox):
            return combo_value(widget)
        if isinstance(widget, QCheckBox):
            return widget.isChecked()
        if isinstance(widget, QLineEdit):
            return widget.text().strip()
        return None

    def quantity(self, key: str) -> Decimal:
        """A quantity typed the Brazilian way ("1.234,5"); never a float."""
        try:
            return Decimal(self.value(key).replace(".", "").replace(",", "."))
        except (InvalidOperation, AttributeError):
            raise DomainError("Quantidade inválida.") from None

    def validate(self) -> None:
        if self._check is not None:
            self._check(self)


def combo(items: list[tuple[str, Any]], empty: str | None = None) -> QComboBox:
    widget = QComboBox()
    fill_combo(widget, items, empty=empty)
    return widget


def cash_accounts(ledger: Ledger) -> list[tuple[str, UUID]]:
    """Accounts money comes from or goes to: assets that are not investments themselves."""
    from opesvault.domain.model import AccountSubtype

    return [(n, i) for n, i in asset_accounts(ledger) if ledger.accounts[i].subtype is not AccountSubtype.INVESTMENT]


def percent(value: Decimal | None) -> str:
    """A rate as "12,34%"; "indisponível" when the method could not compute it (never 0%)."""
    return "indisponível" if value is None else f"{format_decimal_br(value * 100, 2)}%"
