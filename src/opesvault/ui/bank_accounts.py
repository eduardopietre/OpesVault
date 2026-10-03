"""The "Contas bancárias" tab: each bank account with its parts and investments, values and actions."""

from collections.abc import Callable
from datetime import date
from typing import Any
from uuid import UUID

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QVBoxLayout, QWidget

from opesvault.catalogs.irpf import CHECKING, SAVINGS, asset_label
from opesvault.domain import balance_checks, banking
from opesvault.domain.money import ZERO
from opesvault.investments import profile as prof
from opesvault.ui.common import (
    fit_to_rows,
    fmt,
    fmt_date,
    frameless,
    make_table,
    run_guarded,
    selected_id,
    set_rows,
    stretch_column,
    summary_table,
)
from opesvault.ui.components import Collapsible, button, confirm, hbox, menu_button, scroll_body, text
from opesvault.ui.theme import SPACE_L, SPACE_M


class BankAccountsTab(QWidget):
    def __init__(self, changed: Callable[[], None], notify: Callable[[str], None]) -> None:
        super().__init__()
        self.session: Any = None
        self._changed, self._notify = changed, notify
        self.table = make_table(
            ["Conta", "Banco", "Agência", "Conta nº", "Titulares", "Corrente", "Poupança", "Investimentos", "Total"]
        )
        self.table.setAccessibleName("Contas bancárias")
        stretch_column(self.table)
        self.table.setProperty("maxRows", 10)
        self.table.setSortingEnabled(False)  # alphabetical, as listed
        self.table.itemSelectionChanged.connect(self._show_detail)
        self.table.doubleClicked.connect(lambda _: self.edit())
        self.parts = summary_table(
            [
                "Item",
                "Tipo no IRPF",
                "Rentabilidade",
                "Vencimento",
                "Tributação",
                "Valor hoje",
                "Último valor do banco",
            ],
            max_rows=12,
        )
        self.parts.setAccessibleName("Composição da conta bancária")
        stretch_column(self.parts, 0)
        self.parts.doubleClicked.connect(lambda _: self.edit_investment())
        self.detail = Collapsible("Composição", "contas/bancarias_composicao")
        self.detail.add_actions(
            button("Valores em uma data…", self.record_values),
            button("Características…", self.edit_investment, role="plain"),
        )
        self.where = text("", "caption", wrap=True)
        self.where.setMinimumWidth(160)
        self.detail.add(self.where)
        self.detail.add(self.parts)
        self.empty = text(
            "Nenhuma conta bancária. Cadastre banco, agência, conta e titulares; a conta pode ter corrente, "
            "poupança e investimentos, em qualquer combinação.",
            "secondary",
            wrap=True,
        )
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, SPACE_L, 0, 0)
        layout.setSpacing(SPACE_M)
        layout.addLayout(
            hbox(
                button("Nova conta bancária…", self.add, role="primary"),
                button("Editar…", self.edit),
                button("Valores em uma data…", self.record_values),
                button("Novo investimento…", self.add_investment),
                menu_button("Mais", [("Encerrar conta bancária…", self.archive)]),
                None,
            )
        )
        scroll, content = scroll_body()
        content.setSpacing(SPACE_L)
        content.addWidget(self.empty)
        content.addWidget(frameless(self.table))
        content.addWidget(self.detail)
        content.addStretch(1)
        layout.addWidget(scroll, 1)
        self._parts: list[tuple[str, UUID]] = []

    # ── data ──────────

    def _name(self, member_id: UUID | None) -> str:
        member = self.session.ledger.members.get(member_id) if member_id else None
        return member.name if member else "?"

    def refresh(self) -> None:
        if self.session is None:
            self.table.setRowCount(0)
            self.parts.setRowCount(0)
            return
        ledger = self.session.ledger
        today = date.today()
        current = selected_id(self.table)
        rows = []
        items = sorted(
            (b for b in banking.bank_accounts(ledger).values() if not b.archived), key=lambda b: b.name.casefold()
        )
        for item in items:
            values = banking.values_at(ledger, item.id, today)
            by_kind = {v.kind: v.value for v in values if v.kind != "investment"}
            invested = [v.value for v in values if v.kind == "investment"]
            known = [v for v in invested if v is not None]
            holders = self._name(item.holder_id) + (f" e {self._name(item.co_holder_id)}" if item.joint else "")
            rows.append(
                (
                    [
                        item.name,
                        _bank_label(item),
                        item.branch or "—",
                        item.number or "—",
                        holders + (" (conjunta)" if item.joint else ""),
                        fmt(by_kind.get("checking")) if "checking" in by_kind else "—",
                        fmt(by_kind.get("savings")) if "savings" in by_kind else "—",
                        (fmt(sum(known, ZERO)) if known else "—") + (" *" if len(known) < len(invested) else ""),
                        fmt(banking.total(values)),
                    ],
                    item.id,
                )
            )
        set_rows(self.table, rows)
        fit_to_rows(self.table)
        self.empty.setVisible(not rows)
        self.table.setVisible(bool(rows))
        if rows:
            for row in range(self.table.rowCount()):
                cell = self.table.item(row, 0)
                if cell is not None and cell.data(Qt.ItemDataRole.UserRole) == current:
                    self.table.selectRow(row)
                    break
            else:
                self.table.selectRow(0)
        self._show_detail()

    def _selected(self) -> banking.BankAccount | None:
        if self.session is None:
            return None
        bank_id = selected_id(self.table)
        return banking.bank_accounts(self.session.ledger).get(bank_id) if bank_id else None

    def _show_detail(self) -> None:
        item = self._selected()
        self.detail.setVisible(item is not None)
        if item is None or self.session is None:
            self.parts.setRowCount(0)
            return
        ledger = self.session.ledger
        today = date.today()
        latest = balance_checks.latest(ledger)
        from opesvault.investments.performance import value_at

        rows: list[tuple[list[Any], Any]] = []
        self._parts = []
        for value in banking.values_at(ledger, item.id, today):
            if value.kind == "investment":
                profile = prof.profile_of(ledger, value.ref)
                observed = value_at(ledger, value.ref, today)
                rows.append(
                    (
                        [
                            value.label,
                            asset_label(profile.irpf_group, profile.irpf_code) if profile else "a definir",
                            prof.yield_text(profile),
                            fmt_date(profile.maturity) if profile and profile.maturity else "—",
                            prof.TAX_LABELS[profile.tax] if profile and profile.tax else "—",
                            fmt(value.value),
                            f"{fmt(observed.valuation.value)} em {fmt_date(observed.valuation.on)}"
                            if observed
                            else "—",
                        ],
                        value.ref,
                    )
                )
            else:
                code = CHECKING if value.kind == "checking" else SAVINGS
                check = latest.get(value.ref)
                rows.append(
                    (
                        [
                            value.label,
                            asset_label(*code),
                            "—",
                            "—",
                            "—",
                            fmt(value.value),
                            f"{fmt(check.check.informed)} em {fmt_date(check.check.on)}" if check else "—",
                        ],
                        value.ref,
                    )
                )
            self._parts.append((value.kind, value.ref))
        set_rows(self.parts, rows)
        fit_to_rows(self.parts)
        self.where.setText(
            f"{item.where} · titular {self._name(item.holder_id)}"
            + (f", segundo titular {self._name(item.co_holder_id)}" if item.joint else "")
        )

    # ── actions ──────────

    def _run(self, dialog: Any, message: str) -> bool:
        if dialog.exec() and run_guarded(self, lambda: dialog.apply() or True):
            self._notify(message)
            self._changed()
            return True
        return False

    def add(self) -> None:
        from opesvault.ui.bank_dialogs import BankAccountDialog

        if self.session is None:
            return
        if not self.session.ledger.members:
            self._notify("Cadastre o titular na aba Integrantes antes.")
            return
        self._run(BankAccountDialog(self, self.session.ledger), "Conta bancária cadastrada.")

    def edit(self) -> None:
        from opesvault.ui.bank_dialogs import BankAccountDialog

        item = self._selected()
        if item is not None:
            self._run(BankAccountDialog(self, self.session.ledger, item), "Conta bancária salva.")

    def record_values(self) -> None:
        from opesvault.ui.bank_dialogs import ValuesDialog

        item = self._selected()
        if item is None:
            self._notify("Escolha a conta bancária.")
            return
        if not banking.values_at(self.session.ledger, item.id, date.today()):
            self._notify("Esta conta não tem corrente, poupança nem investimentos ainda.")
            return
        self._run(ValuesDialog(self, self.session.ledger, item.id), "Valores registrados.")

    def add_investment(self) -> None:
        from opesvault.ui.bank_dialogs import InvestmentDialog

        if self.session is None:
            return
        item = self._selected()
        self._run(
            InvestmentDialog(self, self.session.ledger, bank_id=item.id if item else None), "Investimento cadastrado."
        )

    def edit_investment(self) -> None:
        from opesvault.ui.bank_dialogs import InvestmentDialog

        ref = selected_id(self.parts)
        kind = next((k for k, r in self._parts if r == ref), None)
        if kind != "investment" or self.session is None:
            self._notify("Escolha um investimento na composição.")
            return
        self._run(InvestmentDialog(self, self.session.ledger, position_id=ref), "Características salvas.")

    def archive(self) -> None:
        item = self._selected()
        if item is None:
            return
        if confirm(
            self,
            "Encerrar esta conta bancária?",
            "Ela sai da lista; as contas e os lançamentos continuam no livro e podem ser arquivados em Contas.",
            "Encerrar",
        ):
            banking.archive(self.session.ledger, item.id)
            self._changed()


def _bank_label(item: banking.BankAccount) -> str:
    from opesvault.catalogs import bank

    listed = bank(item.bank_code)
    return f"{listed.code} — {listed.short_name}" if listed else item.bank_name
