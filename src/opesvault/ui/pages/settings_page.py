"""Configurações do cofre: assistência por IA local e preferências (no secrets here)."""

from PySide6.QtWidgets import (
    QCheckBox,
    QFormLayout,
    QGroupBox,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
)

from opesvault.domain.settings import get_settings, update_settings
from opesvault.ui.common import run_guarded
from opesvault.ui.pages.base import Page


class SettingsPage(Page):
    title = "Configurações"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.ai_enabled = QCheckBox("Usar Ollama local para sugerir categorias")
        self.ai_model = QLineEdit()
        self.ai_model.setPlaceholderText("nome do modelo instalado, ex.: qwen2.5:7b")
        test = QPushButton("Testar conexão local")
        test.clicked.connect(self.test_ai)
        save = QPushButton("Aplicar")
        save.clicked.connect(self.apply)
        ai_box = QGroupBox("Assistência por IA (opcional)")
        form = QFormLayout(ai_box)
        form.addRow(self.ai_enabled)
        form.addRow("Modelo:", self.ai_model)
        form.addRow(test)
        notice = QLabel(
            "Somente o Ollama em 127.0.0.1 é usado; modelos em nuvem são recusados. Apenas descrições e "
            "nomes de categorias são enviados. Sugestões nunca aprovam lançamentos. O aplicativo funciona "
            "por completo sem IA."
        )
        notice.setWordWrap(True)
        form.addRow(notice)
        self.extra = QVBoxLayout()
        layout = QVBoxLayout(self)
        layout.addWidget(ai_box)
        layout.addLayout(self.extra)
        layout.addWidget(save)
        layout.addStretch()

    def refresh(self) -> None:
        self.setEnabled(self.session is not None)
        if self.session is None:
            return
        settings = get_settings(self.session.ledger)
        self.ai_enabled.setChecked(settings.ai_enabled)
        self.ai_model.setText(settings.ai_model or "")

    def apply(self) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        if run_guarded(
            self,
            lambda: update_settings(
                ledger, ai_enabled=self.ai_enabled.isChecked(), ai_model=self.ai_model.text().strip() or None
            ),
        ):
            self.changed()

    def test_ai(self) -> None:
        from opesvault.ai.ollama import AiUnavailable, OllamaClient

        try:
            client = OllamaClient(self.ai_model.text().strip() or "teste")
            client.suggest_categories(["teste de conexão"], ["Outras despesas"])
        except AiUnavailable as exc:
            QMessageBox.information(self, "IA local", str(exc))
            return
        QMessageBox.information(self, "IA local", "Ollama local respondeu.")
