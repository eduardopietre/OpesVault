"""The local AI in the Livro: a second opinion on categories and readable merchant names.

Both commands look at the selected operations (two or more) or, otherwise, at every operation
the filters show. The model is asked in the background with descriptions only; what it proposes
comes back as a review where each change is checked, unchecked or edited. Only then the ledger
changes: a reclassification with its reason in the history, or an approved merchant name, as
one undo step.
"""

import threading
from collections.abc import Callable
from typing import TYPE_CHECKING
from uuid import UUID

from PySide6.QtWidgets import QMessageBox

from opesvault.domain.edits import reclassify
from opesvault.importing import learning
from opesvault.ui.common import run_guarded
from opesvault.ui.local_ai import OFF, AiReviewDialog, client_for, failure_text, label, plural

if TYPE_CHECKING:
    from opesvault.domain.model import Operation
    from opesvault.importing.ai_merchants import NameOutcome
    from opesvault.importing.ai_suggestions import AiOutcome
    from opesvault.ui.local_ai import AiRunRow
    from opesvault.ui.pages.base import Page
    from opesvault.ui.pages.ledger.model import OperationsModel

    class _Parts(Page):
        ai_row: AiRunRow
        model: OperationsModel

        def selected_ids(self) -> list[UUID]: ...

else:
    _Parts = object

REVIEW_LIMIT = 2000  # operations per run: a whole year of a busy family, minutes on a GPU


class LedgerAi(_Parts):
    def _ai_scope(self) -> tuple[list[UUID], str]:
        """The operations a command looks at, and how to say it."""
        selected = self.selected_ids()
        if len(selected) >= 2:
            return selected, plural(len(selected), "lançamento selecionado", "lançamentos selecionados")
        shown = [op.id for op in self.model.ops]
        return shown, plural(len(shown), "lançamento exibido", "lançamentos exibidos")

    def _ai_ready(self) -> bool:
        if self.session is None:
            return False
        if self.ai_row.running:
            self.notify("A IA local ainda está respondendo; aguarde ou cancele.")
            return False
        if client_for(self.session.ledger) is None:
            self.notify(OFF)
            return False
        return True

    def suggest_categories_ai(self) -> None:
        """Asks the model which category each description belongs to and lists the differences."""
        from opesvault.importing.ai_suggestions import AiOutcome, ask, plan_operations

        if not self._ai_ready() or self.session is None:
            return
        session = self.session
        ledger = session.ledger
        client = client_for(ledger)
        ids, scope = self._ai_scope()
        if len(ids) > REVIEW_LIMIT:
            self.notify(f"São {len(ids)} lançamentos; filtre até {REVIEW_LIMIT} (um período ou uma conta).")
            return
        requests = plan_operations(ledger, ids)
        if client is None or not requests:
            self.notify(f"IA local: nada a classificar em {scope} (só receitas e despesas de uma categoria).")
            return

        def work(report: Callable[[int, int], None], cancel: threading.Event) -> object:
            return ask(client, requests, on_progress=report, cancel=cancel)

        def done(result: object) -> None:
            if self.session is not session:
                return
            if not isinstance(result, AiOutcome):
                QMessageBox.information(self, "IA local", failure_text(result))
                return
            self._review_categories(result, scope)

        total = sum(len(r.descriptions) for r in requests)
        self.ai_row.start(client, work, total, "descrição(ões)", done)

    def _review_categories(self, outcome: "AiOutcome", scope: str) -> None:
        from opesvault.importing.ai_suggestions import category_names, question_key

        if self.session is None:
            return
        ledger = self.session.ledger
        names: dict[UUID, str] = {}
        for kind in learning.KINDS:
            names |= {v: k for k, v in category_names(ledger, kind).items()}
        # One line per description and suggested category, only where something would change.
        lines: dict[tuple[str, UUID], list[Operation]] = {}
        sources: dict[tuple[str, UUID], str] = {}
        for plan in outcome.planned:
            op = ledger.operations.get(plan.item_id)
            found = learning.category_of(ledger, op) if op is not None and op.active else None
            if op is None or found is None or found[0] == plan.category_id:
                continue
            key = (question_key(op.description), plan.category_id)
            lines.setdefault(key, []).append(op)
            sources[key] = plan.source
        notes = self._outcome_notes(outcome.failed, outcome.cancelled)
        if not lines:
            self.notify(f"IA local: concorda com as categorias de {scope}{notes}.")
            return
        entries = sorted(lines.items(), key=lambda e: (-len(e[1]), e[1][0].description))
        rows = []
        for (_, target), ops in entries:
            current = {names.get(c[0], "?") for op in ops if (c := learning.category_of(ledger, op)) is not None}
            rows.append([ops[0].description, str(len(ops)), ", ".join(sorted(current)), names.get(target, "?")])
        model = label(next(iter(sources.values())))
        dialog = AiReviewDialog(
            self,
            "Sugestões de categoria",
            f"A IA local ({model}) sugere outra categoria para {plural(len(rows), 'descrição', 'descrições')} "
            f"de {scope}{notes}. Desmarque o que não for; as marcadas serão reclassificadas, "
            "com o motivo no histórico de cada lançamento.",
            ["Descrição", "Lançamentos", "Categoria atual", "Sugerida"],
            rows,
            confirm="Reclassificar marcadas",
        )
        if not dialog.exec():
            return
        changed = skipped = 0
        errors: list[str] = []
        for row, _ in dialog.chosen():
            (_, target), ops = entries[row]
            reason = f"Sugestão da IA local conferida na revisão ({sources[entries[row][0]]})"
            result = run_guarded(self, lambda o=ops, t=target, r=reason: reclassify(ledger, [op.id for op in o], t, r))
            if result is None:
                continue
            changed += result.changed
            skipped += result.skipped
            errors += result.errors
        message = f"IA local: {changed} reclassificado(s), {skipped} mantido(s)."
        if errors:
            QMessageBox.information(self, "Reclassificação", message + "\n\n" + "\n".join(errors[:10]))
        else:
            self.notify(message)
        if changed:
            self.changed()

    def suggest_names_ai(self) -> None:
        """Asks the model for readable merchant names ("IFD*IFOOD.COM AGENCIA" → "iFood")."""
        from opesvault.importing.ai_merchants import NameOutcome, ask_names, plan_names

        if not self._ai_ready() or self.session is None:
            return
        session = self.session
        ledger = session.ledger
        client = client_for(ledger)
        ids, scope = self._ai_scope()
        if len(ids) > REVIEW_LIMIT:
            self.notify(f"São {len(ids)} lançamentos; filtre até {REVIEW_LIMIT} (um período ou uma conta).")
            return
        request = plan_names(ledger, ids)
        if client is None or not request.descriptions:
            self.notify(f"IA local: todos os estabelecimentos de {scope} já têm nome aprovado.")
            return

        def work(report: Callable[[int, int], None], cancel: threading.Event) -> object:
            return ask_names(client, request, on_progress=report, cancel=cancel)

        def done(result: object) -> None:
            if self.session is not session:
                return
            if not isinstance(result, NameOutcome):
                QMessageBox.information(self, "IA local", failure_text(result))
                return
            self._review_names(result, scope)

        self.ai_row.start(client, work, len(request.descriptions), "estabelecimento(s)", done)

    def _review_names(self, outcome: "NameOutcome", scope: str) -> None:
        from opesvault.importing.ai_merchants import apply_names

        if self.session is None:
            return
        ledger = self.session.ledger
        notes = self._outcome_notes(outcome.failed, outcome.cancelled)
        proposals = sorted(outcome.proposals, key=lambda p: (-p.count, p.description))
        if not proposals:
            self.notify(f"IA local: nenhum nome novo para os estabelecimentos de {scope}{notes}.")
            return
        model = label(proposals[0].source)
        dialog = AiReviewDialog(
            self,
            "Nomes de estabelecimentos",
            f"A IA local ({model}) sugere nomes para {plural(len(proposals), 'estabelecimento', 'estabelecimentos')} "
            f"de {scope}{notes}. Ajuste um nome com dois cliques ou desmarque-o; os marcados passam a valer em "
            "busca, relatórios e regras. As descrições do banco não mudam.",
            ["Descrição do banco", "Lançamentos", "Nome atual", "Nome sugerido"],
            [[p.description, str(p.count), p.current, p.name] for p in proposals],
            editable=3,
            confirm="Aprovar marcados",
        )
        if not dialog.exec():
            return
        chosen = [(proposals[row], name) for row, name in dialog.chosen()]
        count, refused = apply_names(ledger, chosen)
        message = f"IA local: {plural(count, 'nome aprovado', 'nomes aprovados')}."
        if refused:
            QMessageBox.information(self, "Nomes de estabelecimentos", message + "\n\n" + "\n".join(refused[:10]))
        else:
            self.notify(message)
        if count:
            self.changed()

    @staticmethod
    def _outcome_notes(failed: int, cancelled: bool) -> str:
        if cancelled:
            return " (consulta cancelada antes do fim)"
        if failed:
            return f" ({failed} sem resposta válida)"
        return ""
