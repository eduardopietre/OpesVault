"""What the investment commands share: the selected position and running a form."""

from typing import TYPE_CHECKING, Any
from uuid import UUID

from opesvault.ui.common import run_guarded
from opesvault.ui.pages.investments.forms import Form

if TYPE_CHECKING:
    from PySide6.QtWidgets import QTableWidget

    from opesvault.ui.pages.base import Page
    from opesvault.ui.pages.investments.detail import InvestmentDetail

    class _Parts(Page):
        positions: QTableWidget
        detail: InvestmentDetail

        def _position_id(self) -> UUID | None: ...

else:
    _Parts = object


class CommandBase(_Parts):
    def _run_form(self, form: Form, apply: Any) -> bool:
        """Runs `apply(form)` when the form is confirmed; one undo step when it succeeds."""
        if form.exec() and run_guarded(self, lambda: apply(form) or True):
            self.changed()
            return True
        return False

    def _need_position(self) -> UUID | None:
        pos_id = self._position_id()
        if pos_id is None:
            self.notify("Selecione um investimento.")
        return pos_id
