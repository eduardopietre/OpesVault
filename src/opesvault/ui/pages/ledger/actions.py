"""Commands on the selected operations: correct, reclassify, tag, attach, reverse, cancel…

Every command that changes the ledger calls `changed()` once, so it is one undo step.
"""

from datetime import date
from typing import TYPE_CHECKING
from uuid import UUID

from PySide6.QtWidgets import QComboBox, QLineEdit, QMessageBox, QWidget

from opesvault.domain.edits import reclassify
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountType, Operation
from opesvault.ui.common import combo_value, fill_combo, run_guarded
from opesvault.ui.components import text
from opesvault.ui.dialogs import FormDialog, OperationDialog, ask_reason, category_items
from opesvault.ui.operation_edit import OperationEditDialog, SimpleEditDialog, is_simple

if TYPE_CHECKING:
    from opesvault.ui.pages.base import Page

    class _Selection(Page):
        """What the commands need from the ledger page."""

        def selected_ids(self) -> list[UUID]: ...
        def _selected(self) -> Operation | None: ...

else:
    _Selection = object


class ReclassifyDialog(FormDialog):
    def __init__(self, parent: QWidget | None, ledger: Ledger, count: int) -> None:
        super().__init__(parent, "Reclassificar lançamentos", "Reclassificar")
        self.target = QComboBox()
        items = [(f"Despesa: {label}", i) for label, i in category_items(ledger, AccountType.EXPENSE)]
        items += [(f"Receita: {label}", i) for label, i in category_items(ledger, AccountType.INCOME)]
        fill_combo(self.target, items)
        self.reason = QLineEdit()
        self.reason.setPlaceholderText("obrigatório; fica no histórico")
        note = f"{count} lançamento(s) selecionado(s). Rateios com mais de uma categoria ficam como estão."
        self.form.addRow(text(note, "secondary", wrap=True))
        self.form.addRow("Nova categoria:", self.target)
        self.form.addRow("Motivo:", self.reason)

    def validate(self) -> None:
        if combo_value(self.target) is None:
            raise DomainError("Escolha a categoria de destino.")
        if not self.reason.text().strip():
            raise DomainError("O motivo é obrigatório.")


class OperationActions(_Selection):
    def new_operation(self, kind: str) -> None:
        if self.session is None:
            return
        dialog = OperationDialog(self, self.session.ledger, kind)
        if dialog.exec() and run_guarded(self, lambda: dialog.apply() or True):
            self.notify(f"{OperationDialog.KINDS[kind]}: lançamento registrado.")
            self.changed()

    def edit(self) -> None:
        """Enter / double click: the day-to-day form; the postings editor only when needed."""
        op = self._selected()
        if op is None or self.session is None:
            return
        if not op.active:
            self.notify("Lançamento cancelado não pode ser corrigido.")
            return
        ledger = self.session.ledger
        if is_simple(ledger, op):
            simple = SimpleEditDialog(self, ledger, op)
            if simple.exec():
                if run_guarded(self, simple.apply):
                    self.notify("Lançamento corrigido. A versão anterior ficou no histórico.")
                    self.changed()
                return
            if not simple.wants_full_editor:
                return
        self.edit_postings()

    def edit_postings(self) -> None:
        """The full editor: dates, competence and every posting (debits and credits)."""
        op = self._selected()
        if op is None or self.session is None:
            return
        if not op.active:
            self.notify("Lançamento cancelado não pode ser corrigido.")
            return
        dialog = OperationEditDialog(self, self.session.ledger, op)
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.notify("Lançamento corrigido. A versão anterior ficou no histórico.")
            self.changed()

    def reclassify_selected(self) -> None:
        ids = self.selected_ids()
        if not ids or self.session is None:
            return
        ledger = self.session.ledger
        dialog = ReclassifyDialog(self, ledger, len(ids))
        if not dialog.exec():
            return
        result = run_guarded(
            self, lambda: reclassify(ledger, ids, combo_value(dialog.target), dialog.reason.text().strip())
        )
        if result is None:
            return
        message = f"{result.changed} reclassificado(s), {result.skipped} mantido(s)."
        if result.errors:
            QMessageBox.information(self, "Reclassificação", message + "\n\n" + "\n".join(result.errors[:10]))
        else:
            self.notify(message)
        if result.changed:
            self.changed()

    def tag_selected(self) -> None:
        ids = self.selected_ids()
        if not ids or self.session is None:
            return
        from opesvault.ui.planning_dialogs import TagDialog

        ledger = self.session.ledger
        dialog = TagDialog(self, ledger, ids)
        if dialog.exec():
            changed = run_guarded(self, dialog.apply)
            if changed:
                self.notify(f"Marcadores alterados em {changed} lançamento(s).")
                self.changed()

    def attach_receipt(self) -> None:
        """A receipt (PDF or image) for the selected operation, kept encrypted in the vault."""
        op = self._selected()
        if op is None or self.session is None:
            return
        from PySide6.QtWidgets import QFileDialog

        from opesvault.domain.attachments import attach

        name, _ = QFileDialog.getOpenFileName(self, "Anexar comprovante", "", "Comprovantes (*.pdf *.png *.jpg *.jpeg)")
        if not name:
            return
        from pathlib import Path

        path = Path(name)
        try:
            data = path.read_bytes()
        except OSError:
            QMessageBox.warning(self, "Anexar comprovante", "Não foi possível ler o arquivo.")
            return
        session = self.session
        if run_guarded(self, lambda: attach(session, op.id, path.name, data)):
            self.notify("Comprovante anexado e guardado cifrado no cofre.")
            self.changed()

    def detail_income(self) -> None:
        """Gross, IRRF and INSS of a salary deposit, for the income tax return."""
        op = self._selected()
        if op is None or self.session is None:
            return
        from opesvault.tax.records import received_amount
        from opesvault.ui.tax_dialogs import IncomeDetailDialog

        if received_amount(self.session.ledger, op.id) <= 0:
            self.notify("Só receitas têm detalhamento de rendimento.")
            return
        dialog = IncomeDetailDialog(self, self.session.ledger, op.id)
        if dialog.exec() and run_guarded(self, lambda: dialog.apply() or True):
            self.notify("Rendimento detalhado: aparece em Imposto de renda.")
            self.changed()

    def open_attachment(self, document_id: UUID) -> None:
        self.navigate("documents", document_id)

    def name_merchant(self) -> None:
        op = self._selected()
        if op is None or self.session is None:
            return
        from PySide6.QtWidgets import QInputDialog

        from opesvault.domain.merchants import merchant_of, name_merchant

        ledger = self.session.ledger
        current = merchant_of(ledger, op.description)
        name, ok = QInputDialog.getText(
            self,
            "Nomear estabelecimento",
            f"Nome para “{op.description}” e descrições parecidas:",
            text=current,
        )
        if ok and run_guarded(self, lambda: name_merchant(ledger, op.description, name)):
            self.notify(f"Estabelecimento “{name.strip()}” definido; a descrição original continua guardada.")
            self.changed()

    def mark_reviewed(self) -> None:
        ids = self.selected_ids()
        if not ids or self.session is None:
            return
        from opesvault.domain.anomalies import mark_reviewed

        ledger = self.session.ledger
        silenced = sum(mark_reviewed(ledger, op_id) for op_id in ids)
        self.notify(f"{len(ids)} lançamento(s) conferido(s); avisos de duplicidade ou valor silenciados.")
        if silenced:
            self.changed()

    def request_reimbursement(self) -> None:
        op = self._selected()
        if op is None or self.session is None:
            return
        from opesvault.ui.planning_dialogs import ReimbursementDialog

        dialog = ReimbursementDialog(self, self.session.ledger, op)
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.notify("Reembolso registrado. Acompanhe em Reembolsos e acertos.")
            self.changed()

    def reverse(self) -> None:
        op = self._selected()
        if op is None or self.session is None:
            return
        reason = ask_reason(self, "Estornar lançamento")
        ledger = self.session.ledger
        if reason and run_guarded(self, lambda: ledger.reverse_operation(op.id, date.today(), reason)):
            self.notify("Estorno registrado como nova operação; o original foi mantido.")
            self.changed()

    def cancel(self) -> None:
        op = self._selected()
        if op is None or self.session is None:
            return
        reason = ask_reason(self, "Cancelar lançamento")
        ledger = self.session.ledger
        if reason and run_guarded(self, lambda: ledger.cancel_operation(op.id, reason)):
            self.notify("Lançamento cancelado. Ele continua visível em “Só cancelados”.")
            self.changed()

    def show_history(self) -> None:
        op = self._selected()
        if op is None or self.session is None:
            return
        lines = [
            f"{h.at:%d/%m/%Y %H:%M} · v{h.version} · {h.action.value} · {h.operator or 'operador não informado'}"
            + (f" · motivo: {h.reason}" if h.reason else "")
            for h in self.session.ledger.history_of(op.id)
        ]
        QMessageBox.information(self, "Histórico", "\n".join(lines) or "Sem histórico.")
