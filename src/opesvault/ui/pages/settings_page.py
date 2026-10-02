"""Configurações do cofre: assistência por IA local e preferências (no secrets here)."""

from PySide6.QtWidgets import (
    QCheckBox,
    QFormLayout,
    QGroupBox,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
)

from opesvault.domain.settings import get_settings, update_settings
from opesvault.ui.common import make_table, run_guarded, set_rows
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
        backup_box = QGroupBox("Backup e salvamento")
        backup_form = QFormLayout(backup_box)
        self.backup_dir = QLineEdit()
        choose = QPushButton("Escolher pasta…")
        choose.clicked.connect(self._choose_dir)
        self.backup_keep = QSpinBox()
        self.backup_keep.setRange(1, 500)
        self.auto_backup = QCheckBox("Copiar cada revisão salva para a pasta de backups")
        self.reminder = QSpinBox()
        self.reminder.setRange(0, 600)
        self.reminder.setSuffix(" min (0 = sem lembrete)")
        backup_form.addRow("Pasta de backups:", self.backup_dir)
        backup_form.addRow(choose)
        backup_form.addRow("Manter as últimas:", self.backup_keep)
        backup_form.addRow(self.auto_backup)
        backup_form.addRow("Lembrete de alterações não salvas:", self.reminder)
        backup_note = QLabel(
            "Backups copiam a última revisão salva (cifrada) e nunca o trabalho em memória. "
            "Cópias para pendrive são manuais. Trocar a senha não altera backups antigos."
        )
        backup_note.setWordWrap(True)
        backup_form.addRow(backup_note)
        self.recents = QCheckBox("Lembrar caminhos de cofres recentes neste computador (sem saldos ou nomes)")
        self.recents.toggled.connect(self._toggle_recents)
        coverage_box = QGroupBox("Cobertura de importação (por layout)")
        coverage_layout = QVBoxLayout(coverage_box)
        self.coverage = make_table(
            ["Instituição", "Produto", "Formato", "Layout", "Versão", "Validado com documentos reais", "Limitações"]
        )
        coverage_layout.addWidget(self.coverage)
        self.extra = QVBoxLayout()
        layout = QVBoxLayout(self)
        layout.addWidget(ai_box)
        layout.addWidget(backup_box)
        layout.addWidget(self.recents)
        layout.addLayout(self.extra)
        layout.addWidget(save)
        layout.addWidget(coverage_box)
        self._fill_coverage()

    def refresh(self) -> None:
        for box in self.findChildren(QGroupBox)[:2]:
            box.setEnabled(self.session is not None)
        if self.session is None:
            return
        settings = get_settings(self.session.ledger)
        self.ai_enabled.setChecked(settings.ai_enabled)
        self.ai_model.setText(settings.ai_model or "")
        self.backup_dir.setText(settings.backup_dir or "")
        self.backup_keep.setValue(settings.backup_keep)
        self.auto_backup.setChecked(settings.auto_backup)
        self.reminder.setValue(settings.save_reminder_minutes)
        from opesvault.ui.main_window import MainWindow

        self.recents.blockSignals(True)
        self.recents.setChecked(bool(MainWindow.app_settings().value("recentes/ativo", False, type=bool)))
        self.recents.blockSignals(False)

    def apply(self) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        if run_guarded(
            self,
            lambda: update_settings(
                ledger,
                ai_enabled=self.ai_enabled.isChecked(),
                ai_model=self.ai_model.text().strip() or None,
                backup_dir=self.backup_dir.text().strip() or None,
                backup_keep=self.backup_keep.value(),
                auto_backup=self.auto_backup.isChecked(),
                save_reminder_minutes=self.reminder.value(),
            ),
        ):
            self.changed()

    def _choose_dir(self) -> None:
        from PySide6.QtWidgets import QFileDialog

        folder = QFileDialog.getExistingDirectory(self, "Pasta de backups")
        if folder:
            self.backup_dir.setText(folder)

    def _toggle_recents(self, enabled: bool) -> None:
        from opesvault.ui.main_window import MainWindow

        settings = MainWindow.app_settings()
        settings.setValue("recentes/ativo", enabled)
        if not enabled:
            settings.remove("recentes/lista")

    def _fill_coverage(self) -> None:
        from opesvault.importing.parsers import PARSERS

        set_rows(
            self.coverage,
            [
                (
                    [
                        p.institution,
                        p.product,
                        p.doc_format.value.upper(),
                        p.id,
                        p.version,
                        "sim" if p.validated_with_real_documents else "não (layout sintético)",
                        p.limitations,
                    ],
                    p.id,
                )
                for p in PARSERS
            ],
        )

    def test_ai(self) -> None:
        from opesvault.ai.ollama import AiUnavailable, OllamaClient

        try:
            client = OllamaClient(self.ai_model.text().strip() or "teste")
            client.suggest_categories(["teste de conexão"], ["Outras despesas"])
        except AiUnavailable as exc:
            QMessageBox.information(self, "IA local", str(exc))
            return
        QMessageBox.information(self, "IA local", "Ollama local respondeu.")
