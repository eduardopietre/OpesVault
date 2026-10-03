"""Metas: savings and net-worth goals with progress, the monthly amount still needed and the
recent pace (docs/09 §1.3 C). A goal reads values the ledger already has; it never moves money."""

from datetime import date
from decimal import Decimal
from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QComboBox, QLineEdit, QListWidget, QListWidgetItem, QStackedWidget, QWidget

from opesvault.domain import goals as goals_domain
from opesvault.domain.goals import KIND_LABELS, Goal, GoalKind
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountType, YearMonth
from opesvault.ui.common import (
    combo_value,
    fill_combo,
    fit_to_rows,
    fmt,
    fmt_date,
    money_edit,
    month_label,
    read_money,
    run_guarded,
    select_combo,
    selected_id,
    set_rows,
    stretch_column,
    summary_table,
)
from opesvault.ui.components import EmptyState, button, menu_button, scroll_body, text
from opesvault.ui.dialogs import FormDialog, ask_reason
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_L


class GoalDialog(FormDialog):
    def __init__(self, parent: QWidget | None, ledger: Ledger, goal: Goal | None = None) -> None:
        from opesvault.ui.operation_edit import OptionalDate

        super().__init__(parent, "Editar meta" if goal else "Nova meta", "Salvar" if goal else "Criar meta")
        self.ledger = ledger
        self.original = goal
        self.name = QLineEdit(goal.name if goal else "")
        self.name.setPlaceholderText("ex.: Reserva de emergência, Entrada do apartamento")
        self.name.setAccessibleName("Nome")
        self.kind = QComboBox()
        self.kind.setAccessibleName("O que conta")
        fill_combo(self.kind, [(label, kind) for kind, label in KIND_LABELS.items()])
        self.accounts = QListWidget()
        self.accounts.setAccessibleName("Contas da meta")
        chosen = set(goal.account_ids) if goal else set()
        for account in sorted(ledger.accounts.values(), key=lambda a: a.name.casefold()):
            if account.type is not AccountType.ASSET or account.archived:
                continue
            item = QListWidgetItem(account.name)
            item.setData(Qt.ItemDataRole.UserRole, account.id)
            item.setCheckState(Qt.CheckState.Checked if account.id in chosen else Qt.CheckState.Unchecked)
            self.accounts.addItem(item)
        self.accounts.setMaximumHeight(140)
        self.target = money_edit()
        self.target.setAccessibleName("Valor da meta")
        self.deadline = OptionalDate(goal.target_date if goal else None)
        self.deadline.edit.setAccessibleName("Prazo")
        self.deadline.known.setText("com prazo")
        if goal is not None:
            select_combo(self.kind, goal.kind)
            self.target.setText(fmt(goal.target).replace("R$", "").strip())
        self.kind.currentIndexChanged.connect(lambda _: self._kind_changed())
        self.form.addRow("Nome:", self.name)
        self.form.addRow("Conta como:", self.kind)
        self.form.addRow("Contas:", self.accounts)
        self.form.addRow("Valor da meta:", self.target)
        self.form.addRow("Prazo:", self.deadline)
        self.form.addRow(
            "",
            text(
                "Patrimônio líquido: tudo o que a família tem menos o que deve. Contas escolhidas: o saldo somado "
                "de contas como a poupança da reserva. A meta só acompanha; não movimenta dinheiro.",
                "caption",
                wrap=True,
            ),
        )
        self._kind_changed()

    def _kind_changed(self) -> None:
        self.accounts.setEnabled(combo_value(self.kind) == GoalKind.ACCOUNTS)

    def build(self) -> Goal:
        target = read_money(self.target)
        if target is None:
            raise DomainError("Informe o valor da meta.")
        chosen = tuple(
            self.accounts.item(i).data(Qt.ItemDataRole.UserRole)
            for i in range(self.accounts.count())
            if self.accounts.item(i).checkState() == Qt.CheckState.Checked
        )
        kind = GoalKind(combo_value(self.kind))
        fields: dict[str, Any] = {
            "name": self.name.text().strip(),
            "kind": kind,
            "target": target,
            "target_date": self.deadline.value(),
            "account_ids": chosen if kind is GoalKind.ACCOUNTS else (),
        }
        if not fields["name"]:
            raise DomainError("Dê um nome à meta.")
        if self.original is not None:
            return self.original.model_copy(update=fields)
        return Goal(created_on=date.today(), **fields)

    def validate(self) -> None:
        goal = self.build()
        goals_domain._validate(self.ledger, goal)

    def apply(self) -> Goal:
        goal = self.build()
        if self.original is None:
            return goals_domain.add_goal(self.ledger, goal)
        return goals_domain.update_goal(self.ledger, goal, "meta editada")


class GoalsPage(Page):
    title = "Metas"
    section = "Acompanhamento"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        from opesvault.ui.chart_panel import ChartPanel

        self.header.add(
            menu_button(
                "Mais",
                [("Editar meta…", self.edit_goal), ("Arquivar ou reativar…", self.toggle_archived)],
            ),
            button("Nova meta…", self.add_goal, role="primary"),
        )
        self.table = summary_table(
            ["Meta", "Atual", "Alvo", "Progresso", "Falta", "Prazo", "Por mês", "Ritmo recente", "Alcança em"],
            max_rows=8,
        )
        self.table.setAccessibleName("Metas")
        stretch_column(self.table)
        self.table.itemSelectionChanged.connect(self._show_selected)
        self.table.doubleClicked.connect(lambda _: self.edit_goal())
        self.caption = text(
            "Por mês: quanto falta dividido pelos meses até o prazo. Ritmo recente: quanto o valor mudou por mês, "
            "em média, nos últimos meses com registros. “—” quando não há prazo ou dados.",
            "caption",
            wrap=True,
        )
        self.panel = ChartPanel(
            "metas/grafico", chart_title="Evolução da meta", table_title="Valores mês a mês", chart_height=260
        )
        self.empty = EmptyState(
            "Nenhuma meta",
            "Crie uma meta de patrimônio ou de saldo (reserva de emergência, entrada de um imóvel, viagem) para "
            "acompanhar quanto falta e em que ritmo a família chega lá.",
            [button("Nova meta…", self.add_goal)],
        )
        scroll, content = scroll_body()
        content.setSpacing(SPACE_L)
        content.addWidget(self.table)
        content.addWidget(self.caption)
        content.addWidget(self.panel)
        content.addStretch(1)
        self.views = QStackedWidget()
        self.views.addWidget(scroll)
        self.views.addWidget(self.empty)
        layout = self.page_layout()
        layout.addWidget(self.views, 1)

    def refresh(self) -> None:
        if self.session is None:
            self.table.setRowCount(0)
            self.panel.clear()
            return
        ledger = self.session.ledger
        selected = selected_id(self.table)
        rows: list[tuple[list[Any], Any]] = []
        found = goals_domain.goals(ledger)
        for goal in found:
            p = goals_domain.progress(ledger, goal)
            share = f"{(p.share * 100).quantize(Decimal('1'))}%" + (" · alcançada" if p.reached else "")
            rows.append(
                (
                    [
                        goal.name + (" (arquivada)" if goal.archived else ""),
                        fmt(p.current),
                        fmt(goal.target),
                        share,
                        fmt(p.missing),
                        fmt_date(goal.target_date),
                        fmt(p.needed_per_month),
                        fmt(p.pace),
                        month_label(p.reached_on_pace) if p.reached_on_pace else "—",
                    ],
                    goal.id,
                )
            )
        set_rows(self.table, rows)
        fit_to_rows(self.table)
        self.views.setCurrentIndex(0 if rows else 1)
        active = sum(1 for g in found if not g.archived)
        self.header.set_subtitle(f"{active} meta(s) ativa(s)" if found else "")
        for row in range(self.table.rowCount()):
            item = self.table.item(row, 0)
            if item is not None and item.data(Qt.ItemDataRole.UserRole) == selected:
                self.table.selectRow(row)
        if rows and selected_id(self.table) is None:
            self.table.selectRow(0)
        self._show_selected()

    def _show_selected(self) -> None:
        goal_id = selected_id(self.table)
        self.panel.setVisible(goal_id is not None)
        if self.session is None or goal_id is None:
            self.panel.clear()
            return
        from opesvault.charts.data import goal_chart

        self.panel.show_chart(goal_chart(self.session.ledger, goal_id, YearMonth.of(date.today())))

    def add_goal(self) -> None:
        if self.session is None:
            return
        dialog = GoalDialog(self, self.session.ledger)
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.notify("Meta criada.")
            self.changed()

    def edit_goal(self) -> None:
        goal_id = selected_id(self.table)
        if self.session is None or goal_id is None:
            return
        ledger = self.session.ledger
        dialog = GoalDialog(self, ledger, ledger.entities("goal")[goal_id])
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.changed()

    def toggle_archived(self) -> None:
        goal_id = selected_id(self.table)
        if self.session is None or goal_id is None:
            return
        ledger = self.session.ledger
        goal = ledger.entities("goal")[goal_id]
        reason = ask_reason(self, "Reativar meta" if goal.archived else "Arquivar meta")
        if reason and run_guarded(
            self,
            lambda: goals_domain.update_goal(ledger, goal.model_copy(update={"archived": not goal.archived}), reason),
        ):
            self.changed()
