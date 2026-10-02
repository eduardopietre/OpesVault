"""Configurações do cofre: assistência por IA local e preferências (no secrets here)."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QFormLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QSpinBox,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from opesvault.domain.settings import get_settings, update_settings
from opesvault.ui.common import frameless, make_table, run_guarded, set_rows
from opesvault.ui.components import button, hbox_widget, text
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_L, SPACE_M, SPACE_S


class SettingsPage(Page):
    title = "Configurações"
    footer = True

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.apply_button = button("Aplicar", self.apply, role="primary", tip="Grava as configurações no cofre")
        self.apply_button.setEnabled(False)
        self.header.add(self.apply_button)

        # Backup and saving (stored in the vault)
        self.backup_dir = QLineEdit()
        self.backup_dir.setAccessibleName("Pasta de backups")
        choose = button("Escolher…", self._choose_dir)
        self.backup_keep = QSpinBox()
        self.backup_keep.setMaximumWidth(180)
        self.backup_keep.setRange(1, 500)
        self.backup_keep.setSuffix(" revisões")
        self.auto_backup = QCheckBox("Copiar cada revisão salva para a pasta de backups")
        self.reminder = QSpinBox()
        self.reminder.setMaximumWidth(180)
        self.reminder.setRange(0, 600)
        self.reminder.setSuffix(" min")
        self.reminder.setSpecialValueText("Desligado")
        backup = QWidget()
        backup_form = _form(backup)
        backup_form.addRow("Pasta de backups:", hbox_widget(self.backup_dir, choose))
        backup_form.addRow("", self.auto_backup)
        backup_form.addRow("Manter as últimas:", self.backup_keep)
        backup_form.addRow("Lembrar de salvar após:", self.reminder)
        backup_form.addRow(
            "",
            _note(
                text(
                    "Backups copiam a última revisão salva, cifrada, nunca o trabalho em memória. "
                    "Cópias para pendrive são manuais. Trocar a senha não altera backups antigos.",
                    "caption",
                    wrap=True,
                )
            ),
        )

        # Privacy on this computer (outside the vault)
        self.recents = QCheckBox("Lembrar caminhos de cofres recentes")
        self.recents.toggled.connect(self._toggle_recents)
        self.lock_minutes = QSpinBox()
        self.lock_minutes.setMaximumWidth(180)
        self.lock_minutes.setRange(0, 240)
        self.lock_minutes.setSuffix(" min")
        self.lock_minutes.setSpecialValueText("Desligado")
        self.lock_minutes.valueChanged.connect(self._lock_changed)
        privacy = QWidget()
        privacy_form = _form(privacy)
        privacy_form.addRow("", self.recents)
        privacy_form.addRow("Ocultar o conteúdo após:", self.lock_minutes)
        privacy_form.addRow(
            "",
            _note(
                text(
                    "Estas opções valem para este computador e ficam fora do cofre. Caminhos recentes não guardam "
                    "saldos nem nomes. O bloqueio oculta a tela; para mostrar de novo, a senha do cofre é pedida.",
                    "caption",
                    wrap=True,
                )
            ),
        )

        # Local AI (stored in the vault)
        self.ai_enabled = QCheckBox("Usar Ollama local para sugerir categorias")
        self.ai_model = QLineEdit()
        self.ai_model.setPlaceholderText("ex.: qwen2.5:7b")
        self.ai_model.setAccessibleName("Modelo")
        ai = QWidget()
        ai_form = _form(ai)
        ai_form.addRow("", self.ai_enabled)
        ai_form.addRow("Modelo instalado:", hbox_widget(self.ai_model, button("Testar conexão", self.test_ai)))
        ai_form.addRow(
            "",
            _note(
                text(
                    "Somente o Ollama em 127.0.0.1 é usado; modelos em nuvem são recusados. Apenas descrições e "
                    "nomes de categorias são enviados. Sugestões nunca aprovam lançamentos. O aplicativo funciona "
                    "por completo sem IA.",
                    "caption",
                    wrap=True,
                )
            ),
        )

        # Import coverage (read-only)
        self.coverage = make_table(
            ["Instituição", "Produto", "Formato", "Layout", "Versão", "Validado com documentos reais", "Limitações"]
        )
        coverage = QWidget()
        cl = QVBoxLayout(coverage)
        cl.setContentsMargins(0, SPACE_M, 0, 0)
        cl.addWidget(
            text(
                "Layouts sem validação com documentos reais mostram um aviso a cada importação; confira os itens.",
                "secondary",
                wrap=True,
            )
        )
        cl.addWidget(frameless(self.coverage), 1)

        self.tabs = QTabWidget()
        self.tabs.addTab(backup, "Backup e salvamento")
        self.tabs.addTab(privacy, "Privacidade")
        self.tabs.addTab(ai, "IA local")
        self.tabs.addTab(coverage, "Cobertura de importação")
        self.extra = QVBoxLayout()
        layout = self.page_layout()
        layout.addWidget(self.tabs, 1)
        layout.addLayout(self.extra)
        for widget in (self.backup_dir, self.ai_model):
            widget.textEdited.connect(self._mark_edited)
        for box in (self.auto_backup, self.ai_enabled):
            box.toggled.connect(self._mark_edited)
        for spin in (self.backup_keep, self.reminder):
            spin.valueChanged.connect(self._mark_edited)
        self._vault_forms = (backup, ai)
        self._fill_coverage()

    def _mark_edited(self, *_: object) -> None:
        self.apply_button.setEnabled(self.session is not None)
        self.header.set_subtitle("Alterações ainda não aplicadas" if self.session is not None else "")

    def _lock_changed(self, minutes: int) -> None:
        from opesvault.ui.idle_lock import set_lock_minutes

        set_lock_minutes(minutes)
        window = self.window()
        idle = getattr(window, "idle", None)
        if idle is not None:
            idle.minutes = minutes

    def refresh(self) -> None:
        for form in self._vault_forms:
            form.setEnabled(self.session is not None)
        from opesvault.ui.idle_lock import lock_minutes

        self.lock_minutes.blockSignals(True)
        self.lock_minutes.setValue(lock_minutes())
        self.lock_minutes.blockSignals(False)
        if self.session is None:
            return
        settings = get_settings(self.session.ledger)
        widgets = (self.ai_enabled, self.ai_model, self.backup_dir, self.backup_keep, self.auto_backup, self.reminder)
        for widget in widgets:
            widget.blockSignals(True)
        self.ai_enabled.setChecked(settings.ai_enabled)
        self.ai_model.setText(settings.ai_model or "")
        self.backup_dir.setText(settings.backup_dir or "")
        self.backup_keep.setValue(settings.backup_keep)
        self.auto_backup.setChecked(settings.auto_backup)
        self.reminder.setValue(settings.save_reminder_minutes)
        for widget in widgets:
            widget.blockSignals(False)
        self.apply_button.setEnabled(False)
        self.header.set_subtitle("Backup e IA ficam no cofre; privacidade vale para este computador")
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
            self.notify("Configurações aplicadas ao cofre.")
            self.changed()

    def _choose_dir(self) -> None:
        from PySide6.QtWidgets import QFileDialog

        folder = QFileDialog.getExistingDirectory(self, "Pasta de backups")
        if folder:
            self.backup_dir.setText(folder)
            self._mark_edited()

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


def _note(label: QLabel) -> QLabel:
    """A form's explanatory caption, kept right under the fields it explains."""
    label.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
    label.setMinimumWidth(240)
    return label


def _form(host: QWidget) -> QFormLayout:
    form = QFormLayout(host)
    form.setContentsMargins(0, SPACE_L, 0, 0)
    form.setHorizontalSpacing(SPACE_M)
    form.setVerticalSpacing(SPACE_S)
    form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)
    form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    form.setRowWrapPolicy(QFormLayout.RowWrapPolicy.DontWrapRows)
    return form
