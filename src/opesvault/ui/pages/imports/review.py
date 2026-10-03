"""Review commands: the document's account, its layout, approving, correcting and rejecting items,
and turning a category chosen by hand into a rule.

Each command that changes the ledger calls `changed()` once (one undo step); after acting on
one item the next is selected, so the review goes on from the keyboard.
"""

from typing import TYPE_CHECKING
from uuid import UUID

from PySide6.QtWidgets import QComboBox, QInputDialog, QLineEdit, QMessageBox, QWidget

from opesvault.domain.ledger import DomainError
from opesvault.domain.model import AccountSubtype
from opesvault.importing import pipeline, rules
from opesvault.importing.model import ExtractedItem, ImportBatch
from opesvault.importing.source import PROBLEM_MESSAGES, SourceError, SourceProblem
from opesvault.ui.common import fmt, read_money, run_guarded, selected_id
from opesvault.ui.dialogs import FormDialog, ask_reason

if TYPE_CHECKING:
    from PySide6.QtWidgets import QLabel, QTableWidget

    from opesvault.ui.pages.base import Page

    class _Parts(Page):
        batch_id: UUID | None
        items: QTableWidget
        target: QComboBox
        layout_choice: QComboBox
        rule_offer: QWidget
        rule_offer_text: QLabel
        _offered_item: UUID | None

        def _batch(self) -> ImportBatch | None: ...

else:
    _Parts = object


class ItemDialog(FormDialog):
    def __init__(self, parent: QWidget, item: ExtractedItem) -> None:
        super().__init__(parent, "Corrigir item", "Corrigir")
        from opesvault.ui.common import date_edit

        self.description = QLineEdit(item.description)
        self.amount = QLineEdit("" if item.amount is None else fmt(item.amount).replace("R$ ", ""))
        self.when = date_edit(item.occurred_on)
        self.reason = QLineEdit()
        self.form.addRow("Descrição:", self.description)
        self.form.addRow("Valor:", self.amount)
        self.form.addRow("Data:", self.when)
        self.form.addRow("Motivo:", self.reason)

    def validate(self) -> None:
        read_money(self.amount)
        if not self.reason.text().strip():
            raise DomainError("Informe o motivo da correção.")


class ReviewCommands(_Parts):
    def _set_target(self, item_id: UUID, target: UUID | None) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        if run_guarded(self, lambda: pipeline.correct_item(ledger, item_id, "target_account_id", target)):
            self.changed()
            self._offer_rule(item_id)

    # ── categorization rules ────────────────────────

    def _offer_rule(self, item_id: UUID) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        item = pipeline.items(ledger).get(item_id)
        target = ledger.accounts.get(item.target_account_id) if item and item.target_account_id else None
        if item is None or target is None or target.subtype is not AccountSubtype.CATEGORY:
            self._dismiss_rule_offer()
            return
        self._offered_item = item_id
        pattern = rules.suggest_pattern(item.description)
        self.rule_offer_text.setText(f"Usar sempre “{target.name}” para descrições com “{pattern}”?")
        self.rule_offer.show()

    def _accept_rule_offer(self) -> None:
        item_id = self._offered_item
        self._dismiss_rule_offer()
        if item_id is not None:
            self.create_rule(item_id)

    def _dismiss_rule_offer(self) -> None:
        self._offered_item = None
        self.rule_offer.hide()

    def create_rule(self, item_id: UUID | None = None) -> None:
        """Ctrl+R: a rule from the selected item (its description and chosen category)."""
        if self.session is None:
            return
        from opesvault.ui.rule_dialog import RuleDialog

        ledger = self.session.ledger
        item_id = item_id or selected_id(self.items)
        item = pipeline.items(ledger).get(item_id) if item_id else None
        if item is None:
            self.notify("Selecione um item para criar a regra a partir dele.")
            return
        batch = pipeline.batches(ledger).get(item.batch_id)
        dialog = RuleDialog(
            self,
            ledger,
            description=item.description,
            target_id=item.target_account_id,
            account_id=batch.account_id if batch else None,
        )
        if not dialog.exec():
            return
        result = run_guarded(self, lambda: dialog.apply(from_item=item.id))
        if result:
            _, changed = result
            self.notify(f"Regra criada. {changed} item(ns) pendente(s) recategorizado(s).")
            self.changed()

    def focus_target(self) -> None:
        """Ctrl+K: open the category selector of the current item."""
        row = self.items.currentRow()
        combo = self.items.cellWidget(row, 5) if row >= 0 else None
        if isinstance(combo, QComboBox):
            combo.setFocus()
            combo.showPopup()

    def _after_item_action(self, row: int) -> None:
        """Keep the keyboard flow: after acting on an item, select the next one."""
        self.changed()
        if self.items.rowCount():
            self.items.selectRow(min(row + 1, self.items.rowCount() - 1))
            self.items.setFocus()

    def _change_target(self) -> None:
        batch = self._batch()
        data = self.target.currentData()
        if batch is None or self.session is None or data is None:
            return
        kind, target_id = data
        ledger = self.session.ledger
        if run_guarded(
            self,
            lambda: pipeline.set_batch_target(
                ledger, batch.id, target_id if kind == "account" else None, target_id if kind == "card" else None
            ),
        ):
            self.changed()

    def _choose_layout(self) -> None:
        batch = self._batch()
        if batch is None or self.session is None:
            return
        session = self.session
        parser_id = self.layout_choice.currentData()
        password: str | None = None
        while True:
            try:
                result = run_guarded(self, lambda pw=password: pipeline.reparse_with(session, batch.id, parser_id, pw))
                break
            except SourceError as exc:  # protected PDF: the password was used once at import, never kept
                if exc.problem not in (SourceProblem.PASSWORD_REQUIRED, SourceProblem.WRONG_PASSWORD):
                    QMessageBox.information(self, "Importação", PROBLEM_MESSAGES.get(exc.problem, "Arquivo inválido."))
                    return
                label = PROBLEM_MESSAGES[exc.problem] + "\nSenha do PDF (não será guardada):"
                typed, ok = QInputDialog.getText(self, "PDF protegido", label, QLineEdit.EchoMode.Password)
                if not ok or not typed:
                    return
                password = typed
        if isinstance(result, ImportBatch):
            self.batch_id = result.id
            self.changed()

    def _approve(self, item_ids: list[UUID] | None) -> bool:
        batch = self._batch()
        if batch is None or self.session is None:
            return False
        ledger = self.session.ledger
        divergence = None
        if any(r.ok is False for r in batch.reconciliations):
            divergence = ask_reason(self, "Total divergente — aceitar como pendência documentada")
            if divergence is None:
                return False
        partial = None
        if item_ids is not None:
            partial = ask_reason(self, "Aprovação parcial")
            if partial is None:
                return False
        result = run_guarded(
            self,
            lambda: pipeline.approve(ledger, batch.id, item_ids, accept_divergence=divergence, partial_reason=partial),
        )
        if result is None:
            return False
        if item_ids is None:
            self.notify(f"{result.created} operação(ões) criada(s), {result.linked} evidência(s) vinculada(s).")
            self.changed()
        return True

    def approve_all(self) -> None:
        self._approve(None)

    def approve_selected(self) -> None:
        item_id = selected_id(self.items)
        if item_id is not None:
            row = self.items.currentRow()
            if self._approve([item_id]):
                self._after_item_action(row)

    def correct(self) -> None:
        item_id = selected_id(self.items)
        if self.session is None or item_id is None:
            return
        ledger = self.session.ledger
        item = pipeline.items(ledger)[item_id]
        dialog = ItemDialog(self, item)
        if not dialog.exec():
            return
        from opesvault.ui.common import from_qdate

        reason = dialog.reason.text().strip()

        def apply() -> bool:
            new_amount = read_money(dialog.amount)
            if new_amount is not None and new_amount < 0:
                raise DomainError("Informe o valor sem sinal; o tipo indica a direção.")
            for field, value in (
                ("description", dialog.description.text().strip()),
                ("amount", new_amount),
                ("occurred_on", from_qdate(dialog.when.date())),
            ):
                if getattr(pipeline.items(ledger)[item_id], field) != value:
                    pipeline.correct_item(ledger, item_id, field, value, reason)
            return True

        if run_guarded(self, apply):
            self.changed()

    def keep_separate(self) -> None:
        item_id = selected_id(self.items)
        if self.session is None or item_id is None:
            return
        row = self.items.currentRow()
        reason = ask_reason(self, "Manter como lançamento separado")
        ledger = self.session.ledger
        if reason and run_guarded(self, lambda: pipeline.keep_separate(ledger, item_id, reason) or True):
            self._after_item_action(row)

    def reject(self) -> None:
        item_id = selected_id(self.items)
        if self.session is None or item_id is None:
            return
        row = self.items.currentRow()
        reason = ask_reason(self, "Rejeitar item")
        ledger = self.session.ledger
        if reason and run_guarded(self, lambda: pipeline.reject_items(ledger, [item_id], reason) or True):
            self._after_item_action(row)
