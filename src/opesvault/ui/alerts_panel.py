"""'Atenção' panel: what is due, late or waiting, each with a way to act on it."""

from collections.abc import Callable

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QGridLayout, QHBoxLayout, QVBoxLayout, QWidget

from opesvault.domain.alerts import Alert, Severity
from opesvault.ui.components import button, text
from opesvault.ui.theme import SPACE_M, SPACE_S, SPACE_XS

MAX_VISIBLE = 6
SEVERITY_WORDS = {Severity.URGENT: "Atrasado", Severity.SOON: "Em breve", Severity.INFO: "Aguardando"}
SEVERITY_TONES = {Severity.URGENT: "negative", Severity.SOON: "warning", Severity.INFO: None}
ACTION_LABELS = {
    "accounts": "Ver fatura",
    "recurrences": "Ver previsão",
    "import": "Revisar",
    "budget": "Ver no orçamento",
    "reports": "Ver projeção",
    "ledger": "Ver lançamentos",
    "settings": "Abrir Configurações",
}
# Alerts whose fix is one command open it directly, with the object already chosen.
ACT_LABELS = {"accounts": "Pagar…", "recurrences": "Vincular…"}


class AlertsPanel(QWidget):
    """Shown above the month figures; hidden when nothing needs attention."""

    def __init__(self, navigate: Callable[..., None]) -> None:
        super().__init__()
        self._navigate = navigate
        self._expanded = False
        self.dismissed = False
        self.heading = text("Atenção", "headline")
        self.toggle = button("Mostrar todos", self._toggle_all, role="plain")
        self.hide_button = button("Ocultar", self.dismiss, role="plain", tip="Volta na próxima abertura do cofre")
        top = QHBoxLayout()
        top.setContentsMargins(0, 0, 0, 0)
        top.addWidget(self.heading)
        top.addStretch(1)
        top.addWidget(self.toggle)
        top.addWidget(self.hide_button)
        self.grid = QGridLayout()
        self.grid.setHorizontalSpacing(SPACE_M)
        self.grid.setVerticalSpacing(SPACE_XS)
        self.grid.setColumnStretch(1, 1)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, SPACE_S)
        layout.setSpacing(SPACE_S)
        layout.addLayout(top)
        layout.addLayout(self.grid)
        self._alerts: list[Alert] = []
        self.setAccessibleName("Avisos")

    def set_alerts(self, alerts: list[Alert]) -> None:
        self._alerts = alerts
        self._render()

    def dismiss(self) -> None:
        self.dismissed = True
        self.hide()

    def reveal(self) -> None:
        self.dismissed = False
        self._render()

    def _toggle_all(self) -> None:
        self._expanded = not self._expanded
        self._render()

    def _render(self) -> None:
        while self.grid.count():
            item = self.grid.takeAt(0)
            widget = item.widget() if item is not None else None
            if widget is not None:
                widget.deleteLater()
        visible = self._alerts if self._expanded else self._alerts[:MAX_VISIBLE]
        for row, alert in enumerate(visible):
            word = text(SEVERITY_WORDS[alert.severity], "caption")
            word.setProperty("tone", SEVERITY_TONES[alert.severity] or "")
            body = QWidget()
            lines = QVBoxLayout(body)
            lines.setContentsMargins(0, 0, 0, 0)
            lines.setSpacing(0)
            lines.addWidget(text(alert.title, wrap=True))
            lines.addWidget(text(alert.detail, "caption", wrap=True))
            target = alert.target.value
            # A bill or installment can be paid before or after it is due; a forecast is linked only once
            # it is late. A balance that differs from the bank opens the account, there is no one-step fix.
            check = isinstance(alert.ref, tuple) and bool(alert.ref) and alert.ref[0] == "check"
            direct = alert.ref is not None and (
                (target == "accounts" and not check) or (target == "recurrences" and alert.severity is Severity.URGENT)
            )
            label = ACT_LABELS[target] if direct else "Ver conta" if check else ACTION_LABELS.get(target, "Ver")
            act = button(label, lambda t=target, r=alert.ref, d=direct: self._navigate(t, r, act=d))
            act.setProperty("role", "plain")
            act.setAccessibleName(f"{label}: {alert.title}")
            self.grid.addWidget(word, row, 0, Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
            self.grid.addWidget(body, row, 1)
            self.grid.addWidget(act, row, 2, Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        hidden = len(self._alerts) - MAX_VISIBLE
        self.toggle.setVisible(hidden > 0)
        self.toggle.setText("Mostrar menos" if self._expanded else f"Mostrar todos ({len(self._alerts)})")
        self.heading.setText(f"Atenção · {len(self._alerts)}")
        self.setVisible(bool(self._alerts) and not self.dismissed)
