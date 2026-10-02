"""Create or edit a categorization rule ("descrição contém X → categoria Y")."""

from uuid import UUID

from PySide6.QtWidgets import QCheckBox, QComboBox, QLineEdit, QWidget

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountType
from opesvault.importing import pipeline, rules
from opesvault.importing.model import ItemStatus
from opesvault.importing.rules import CategoryRule
from opesvault.ui.common import fill_combo, select_combo
from opesvault.ui.components import text
from opesvault.ui.dialogs import FormDialog, category_items


class RuleDialog(FormDialog):
    def __init__(
        self,
        parent: QWidget | None,
        ledger: Ledger,
        *,
        rule: CategoryRule | None = None,
        description: str = "",
        target_id: UUID | None = None,
        account_id: UUID | None = None,
    ) -> None:
        super().__init__(parent, "Regra de categoria", "Salvar regra" if rule else "Criar regra")
        self.ledger = ledger
        self.original = rule
        self.pattern = QLineEdit(rule.pattern if rule else rules.suggest_pattern(description))
        self.pattern.setAccessibleName("Texto contido na descrição")
        self.pattern.textChanged.connect(self._preview)
        self.target = QComboBox()
        self.target.setAccessibleName("Categoria")
        items = [(f"Despesa: {label}", i) for label, i in category_items(ledger, AccountType.EXPENSE)]
        items += [(f"Receita: {label}", i) for label, i in category_items(ledger, AccountType.INCOME)]
        fill_combo(self.target, items)
        select_combo(self.target, rule.target_account_id if rule else target_id)
        self.target.currentIndexChanged.connect(self._preview)
        self.scope = QComboBox()
        self.scope.setAccessibleName("Onde vale")
        scope_items: list[tuple[str, UUID | None]] = [("Qualquer conta ou cartão", None)]
        scoped = rule.account_id if rule else account_id
        if scoped is not None and scoped in ledger.accounts:
            scope_items.append((f"Só em {ledger.accounts[scoped].name}", scoped))
        fill_combo(self.scope, scope_items)
        select_combo(self.scope, rule.account_id if rule else None)
        self.scope.currentIndexChanged.connect(self._preview)
        self.apply_now = QCheckBox("Aplicar agora aos itens pendentes de revisão")
        self.apply_now.setChecked(True)
        self.preview = text("", "caption", wrap=True)
        self.form.addRow("A descrição contém:", self.pattern)
        self.form.addRow("", text("Maiúsculas e acentos não importam.", "caption"))
        self.form.addRow("Categoria:", self.target)
        self.form.addRow("Vale para:", self.scope)
        self.form.addRow("", self.apply_now)
        self.form.addRow("", self.preview)
        self.reason = QLineEdit()
        if rule is not None:
            self.reason.setPlaceholderText("obrigatório; fica no histórico")
            self.form.addRow("Motivo da alteração:", self.reason)
        self._preview()

    def _preview(self) -> None:
        """How many pending items the rule would categorize, before saving it."""
        needle = rules.normalize(self.pattern.text())
        if len(needle) < rules.MIN_PATTERN:
            self.preview.setText(f"Digite ao menos {rules.MIN_PATTERN} caracteres.")
            return
        scope = self.scope.currentData()
        batches = pipeline.batches(self.ledger)
        hits = [
            i
            for i in pipeline.items(self.ledger).values()
            if i.status in (ItemStatus.READY, ItemStatus.NEEDS_REVIEW)
            and needle in rules.normalize(i.description)
            and (scope is None or (i.batch_id in batches and batches[i.batch_id].account_id == scope))
        ]
        manual = sum(1 for i in hits if i.target_account_id is not None and i.suggestion_source is None)
        message = f"Pega {len(hits)} item(ns) pendente(s) agora."
        if manual:
            message += f" {manual} com categoria escolhida à mão continuam como estão."
        self.preview.setText(message)

    def validate(self) -> None:
        if self.target.currentData() is None:
            raise DomainError("Escolha a categoria.")
        if len(rules.normalize(self.pattern.text())) < rules.MIN_PATTERN:
            raise DomainError(f"O texto precisa ter ao menos {rules.MIN_PATTERN} caracteres.")
        if self.original is not None and not self.reason.text().strip():
            raise DomainError("Informe o motivo da alteração.")

    def apply(self, from_item: UUID | None = None) -> tuple[CategoryRule, int]:
        """Saves the rule; returns it and how many pending items it re-categorized."""
        if self.original is None:
            rule = rules.add_rule(
                self.ledger, self.pattern.text(), self.target.currentData(), self.scope.currentData(), from_item
            )
        else:
            rule = rules.update_rule(
                self.ledger,
                self.original.model_copy(
                    update={
                        "pattern": self.pattern.text(),
                        "target_account_id": self.target.currentData(),
                        "account_id": self.scope.currentData(),
                    }
                ),
                self.reason.text().strip(),
            )
        changed = pipeline.apply_rules(self.ledger) if self.apply_now.isChecked() else 0
        return rule, changed
