"""What the income tax dialogs share: amounts, rates and table cells typed the Brazilian way."""

from decimal import Decimal

from PySide6.QtWidgets import (
    QLineEdit,
    QTableWidget,
)

from opesvault.domain.ledger import DomainError
from opesvault.domain.money import MoneyError, format_brl, format_decimal_br, parse_brl
from opesvault.ui.components import text
from opesvault.ui.dialogs import FormDialog


def editable(value: Decimal | None) -> str:
    return "" if value is None else format_brl(value).replace("R$", "").strip()


def percent_text(rate: Decimal | None) -> str:
    """0.075 → "7,5" as typed, not "7,500" (the stored fraction carries extra places)."""
    return "" if rate is None else format_decimal_br((rate * 100).normalize())


def read_percent(edit: QLineEdit, label: str) -> Decimal | None:
    """'15' or '27,5' (percent) to 0.15 or 0.275; empty stays unknown."""
    raw = edit.text().strip().replace("%", "")
    if not raw:
        return None
    try:
        value = parse_brl(raw)
    except MoneyError:
        raise DomainError(f"{label}: use um percentual como 15 ou 27,5.") from None
    if not Decimal(0) <= value <= 100:
        raise DomainError(f"{label}: informe entre 0 e 100.")
    return value / 100


def cell_text(table: QTableWidget, row: int, column: int) -> str:
    item = table.item(row, column)
    return item.text().strip() if item is not None else ""


def caption(form: FormDialog, message: str) -> None:
    form.form.addRow("", text(message, "caption", wrap=True))


# ── CPF / CNPJ ──────────
