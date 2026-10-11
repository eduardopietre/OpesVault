"""The "Regras" tab: the user's categorization rules and the ones their own choices suggest.

Three sources of a category, from most to least trusted: a choice made by hand, a rule of the
user, what the app learned from the family's choices, the built-in keyword rules. This tab
shows the rules, warns when the family keeps choosing something else for one of them, and
offers as rules the descriptions categorized the same way several times (docs/05 §6).
"""

from collections.abc import Callable
from typing import TYPE_CHECKING, Any
from uuid import UUID

from opesvault.importing import learning, pipeline, rules
from opesvault.ui.common import (
    fit_to_rows,
    frameless,
    make_table,
    run_guarded,
    selected_id,
    set_rows,
    stretch_column,
    summary_table,
)
from opesvault.ui.components import Collapsible, button, flow_row, text
from opesvault.ui.pages.accounts.tab import PageTab

SHOWN_PROPOSALS = 12


if TYPE_CHECKING:
    from opesvault.ui.pages.base import Page


class RulesTab(PageTab):
    def __init__(self, page: "Page") -> None:
        super().__init__(page)
        self.table = make_table(["A descrição contém", "Categoria", "Vale para", "Usos", "Situação"])
        self.table.setAccessibleName("Regras de categoria")
        stretch_column(self.table)
        self.table.doubleClicked.connect(lambda _: self.edit())

        self.proposals = summary_table(["A descrição contém", "Categoria", "Vezes"], max_rows=SHOWN_PROPOSALS)
        self.proposals.setAccessibleName("Regras sugeridas pelo uso")
        stretch_column(self.proposals, 0)
        self.proposals.doubleClicked.connect(lambda _: self.create_from_proposal())
        self.learned = Collapsible(
            "Sugeridas pelo uso",
            "contas/regras_sugeridas",
            caption="Descrições que vocês categorizaram do mesmo jeito várias vezes. Virar regra é decisão sua: "
            "sem regra, o OpesVault continua sugerindo pelo que aprendeu.",
        )
        self.learned.add_actions(button("Criar regra…", self.create_from_proposal))
        self.learned.add(self.proposals)

        layout = self.column()
        layout.addWidget(
            text(
                "Regras sugerem a categoria de itens importados; nada é aprovado sozinho. A escolha feita à mão "
                "vale mais que tudo; depois vêm as suas regras, o que o OpesVault aprendeu com as escolhas de "
                "vocês e, por último, as regras padrão.",
                "caption",
                wrap=True,
            )
        )
        layout.addWidget(
            flow_row(
                button("Nova regra…", self.add),
                button("Editar…", self.edit),
                button("Ativar ou desativar…", self.toggle),
            )
        )
        layout.addWidget(frameless(self.table), 1)
        layout.addWidget(self.learned)

    # ── data ────────────────────────────────────────

    def refresh(self) -> None:
        if self.session is None:
            self.table.setRowCount(0)
            self.proposals.setRowCount(0)
            self.learned.hide()
            return
        ledger = self.session.ledger
        contradicted = learning.contradictions(ledger)
        rows = []
        for rule in sorted(rules.rules(ledger).values(), key=lambda r: (not r.active, r.pattern)):
            target = ledger.accounts.get(rule.target_account_id)
            scope = ledger.accounts.get(rule.account_id) if rule.account_id else None
            state = "Ativa" if rule.active else "Desativada"
            found = contradicted.get(rule.id)
            if found is not None:
                usual = ledger.accounts.get(found.usual_category_id)
                state += f" · contrariada {found.contrary} de {found.matched} vezes"
                if usual is not None:
                    state += f" (vocês escolhem {usual.name})"
            rows.append(
                (
                    [
                        rule.pattern,
                        target.name if target else "?",
                        scope.name if scope else "Qualquer conta",
                        str(rules.usage(ledger, rule.id)),
                        state,
                    ],
                    rule.id,
                )
            )
        set_rows(self.table, rows)
        offered = learning.proposals(ledger)[:SHOWN_PROPOSALS]
        set_rows(
            self.proposals,
            [
                (
                    [p.pattern, ledger.accounts[p.category_id].name, str(p.count)],
                    (p.pattern, p.category_id),
                )
                for p in offered
                if p.category_id in ledger.accounts
            ],
        )
        fit_to_rows(self.proposals)
        self.learned.setVisible(bool(offered))

    def _selected(self) -> rules.CategoryRule | None:
        rule_id = selected_id(self.table)
        if self.session is None or rule_id is None:
            return None
        return rules.rules(self.session.ledger).get(rule_id)

    # ── commands ────────────────────────────────────

    def _run(self, dialog: Any, message: Callable[[Any], str]) -> None:
        if dialog.exec():
            result = run_guarded(self, dialog.apply)
            if result:
                self.notify(message(result))
                self.changed()

    def add(self) -> None:
        if self.session is None:
            return
        from opesvault.ui.rule_dialog import RuleDialog

        self._run(
            RuleDialog(self, self.session.ledger),
            lambda result: f"Regra criada. {result[1]} item(ns) pendente(s) recategorizado(s).",
        )

    def create_from_proposal(self) -> None:
        """The learned description and category, ready to become a rule the user can still edit."""
        chosen = selected_id(self.proposals)
        if self.session is None or not isinstance(chosen, tuple):
            self.notify("Escolha uma das regras sugeridas.")
            return
        from opesvault.ui.rule_dialog import RuleDialog

        pattern, category_id = chosen
        self._run(
            RuleDialog(self, self.session.ledger, description=pattern, target_id=category_id),
            lambda result: f"Regra “{result[0].pattern}” criada. {result[1]} item(ns) pendente(s) recategorizado(s).",
        )

    def edit(self) -> None:
        rule = self._selected()
        if rule is None or self.session is None:
            self.notify("Escolha uma regra.")
            return
        from opesvault.ui.rule_dialog import RuleDialog

        self._run(RuleDialog(self, self.session.ledger, rule=rule), lambda _result: "Regra alterada.")

    def toggle(self) -> None:
        rule = self._selected()
        if rule is None or self.session is None:
            self.notify("Escolha uma regra.")
            return
        from opesvault.ui.dialogs import ask_reason

        verb = "Desativar" if rule.active else "Ativar"
        reason = ask_reason(self, f"{verb} regra")
        ledger = self.session.ledger
        rule_id: UUID = rule.id
        if reason and run_guarded(self, lambda: rules.set_active(ledger, rule_id, not rule.active, reason)):
            changed = pipeline.apply_rules(ledger)
            done = "desativada" if rule.active else "ativada"
            self.notify(f"Regra {done}. {changed} item(ns) pendente(s) revisto(s).")
            self.changed()
