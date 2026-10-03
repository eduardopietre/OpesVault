"""Configurações: what belongs to the vault and what belongs to this computer (no secrets here).

One contract per kind, so nothing looks pending when it is not:
- vault settings (backup, reminder, local AI) change the open vault at once, like any other
  edit, and are written by the toolbar's Salvar;
- computer preferences (recent vaults, idle lock) are written immediately, outside the vault.
"""

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFormLayout,
    QLabel,
    QLineEdit,
    QSpinBox,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from opesvault.ai.ollama import RECOMMENDED_MODELS
from opesvault.domain.settings import get_settings, update_settings
from opesvault.ui.common import run_guarded
from opesvault.ui.components import button, hbox_widget, text
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_L, SPACE_M, SPACE_S

VAULT_NOTE = "Fica no cofre: vale depois de Salvar (Ctrl+S), como as outras alterações."
COMPUTER_NOTE = "Vale só para este computador e é gravado na hora, fora do cofre."


class SettingsPage(Page):
    title = "Configurações"
    footer = True

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        # Vault edits are gathered for a moment, so typing a path is one undo step, not one per key.
        self._pending = QTimer(self)
        self._pending.setSingleShot(True)
        self._pending.setInterval(600)
        self._pending.timeout.connect(self.flush)

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
        backup, backup_form, backup_after = _tab(VAULT_NOTE)
        backup_form.addRow("Pasta de backups:", hbox_widget(self.backup_dir, choose))
        backup_form.addRow("", self.auto_backup)
        backup_form.addRow("Manter as últimas:", self.backup_keep)
        backup_form.addRow("Lembrar de salvar após:", self.reminder)
        backup_after.addWidget(
            _note(
                "Backups copiam a última revisão salva, cifrada, nunca o trabalho em memória. "
                "Cópias para pendrive são manuais. Trocar a senha não altera backups antigos."
            )
        )
        backup_after.addWidget(
            hbox_widget(
                button("Fazer backup agora", lambda: self._window_command("backup_now")),
                button("Restaurar backup…", lambda: self._window_command("restore_backup")),
                button("Trocar senha…", lambda: self._window_command("change_password")),
                None,
            )
        )

        # Privacy on this computer (outside the vault)
        self.recents = QCheckBox("Lembrar caminhos de cofres abertos neste computador")
        self.recents.toggled.connect(self._toggle_recents)
        self.lock_minutes = QSpinBox()
        self.lock_minutes.setMaximumWidth(180)
        self.lock_minutes.setRange(0, 240)
        self.lock_minutes.setSuffix(" min")
        self.lock_minutes.setSpecialValueText("Desligado")
        self.lock_minutes.valueChanged.connect(self._lock_changed)
        privacy, privacy_form, privacy_after = _tab(COMPUTER_NOTE)
        privacy_form.addRow("", self.recents)
        privacy_form.addRow("Ocultar o conteúdo após:", self.lock_minutes)
        privacy_after.addWidget(
            _note(
                "Caminhos recentes não guardam saldos nem nomes. O bloqueio oculta a tela após o tempo sem uso; "
                "para mostrar de novo, a senha do cofre é pedida."
            )
        )

        # Local AI (stored in the vault). Off by default; the model only matters once it is on.
        self.ai_enabled = QCheckBox("Usar Ollama local para sugerir categorias")
        # The installed models, as Ollama lists them; still editable for one not pulled yet.
        self.ai_model = QComboBox()
        self.ai_model.setEditable(True)
        self.ai_model.setMinimumContentsLength(18)
        self.ai_model.setAccessibleName("Modelo")
        model_edit = self.ai_model.lineEdit()
        if model_edit is not None:
            model_edit.setPlaceholderText(f"ex.: {RECOMMENDED_MODELS[0]}")
        self.ai_status = text("", "caption", wrap=True)
        self.ai_check = button("Verificar Ollama", self.test_ai)
        self._ai_job: object = None  # the check in progress (kept alive until it answers)
        self.ai_model_row = hbox_widget(self.ai_model, self.ai_check, None)
        ai, ai_form, _ = _tab(
            VAULT_NOTE,
            "Sem IA, o aplicativo já sugere categorias pelas suas regras e pelo histórico. A IA local é opcional: "
            "só o Ollama em 127.0.0.1 é usado; são enviados apenas descrições (as novas e, como exemplo, algumas que "
            "você já classificou) e nomes de categorias; sugestões nunca aprovam lançamentos. Ao importar, a IA "
            "sugere sozinha as categorias que faltarem, sem impedir a revisão.",
        )
        ai_form.addRow("", self.ai_enabled)
        self.ai_model_label = QLabel("Modelo instalado:")
        ai_form.addRow(self.ai_model_label, self.ai_model_row)
        self.ai_hint = text(
            "Indicado: "
            + ", ".join(RECOMMENDED_MODELS)
            + " (melhor resultado na avaliação de scripts/avaliar_modelos.py). Instale com “ollama pull <modelo>”; "
            "o aplicativo não baixa nada sozinho.",
            "caption",
            wrap=True,
        )
        ai_form.addRow("", self.ai_status)
        ai_form.addRow("", self.ai_hint)
        self.ai_enabled.toggled.connect(self._show_ai_model)

        self.tabs = QTabWidget()
        self.tabs.addTab(_readable(backup), "Backup e salvamento")
        self.privacy_tab = self.tabs.addTab(_readable(privacy), "Privacidade deste computador")
        self.tabs.addTab(_readable(ai), "IA local")
        layout = self.page_layout()
        layout.addWidget(self.tabs, 1)
        self.header.set_subtitle("Backup e IA ficam no cofre; privacidade vale para este computador")
        self.backup_dir.textEdited.connect(self._edited)
        self.backup_dir.editingFinished.connect(self.flush)
        self.ai_model.currentTextChanged.connect(self._edited)
        if model_edit is not None:
            model_edit.editingFinished.connect(self.flush)
        for box in (self.auto_backup, self.ai_enabled):
            box.toggled.connect(self._edited)
        for spin in (self.backup_keep, self.reminder):
            spin.valueChanged.connect(self._edited)
        self._vault_forms = (backup, ai)
        self._show_ai_model(False)

    # ── vault settings: applied to the open vault, written by Salvar ──

    def _edited(self, *_: object) -> None:
        if self.session is not None:
            self._pending.start()

    def flush(self) -> None:
        """Applies pending vault settings now (also called before saving or closing)."""
        self._pending.stop()
        if self.session is None:
            return
        ledger = self.session.ledger
        wanted = {
            "ai_enabled": self.ai_enabled.isChecked(),
            "ai_model": self.ai_model.currentText().strip() or None,
            "backup_dir": self.backup_dir.text().strip() or None,
            "backup_keep": self.backup_keep.value(),
            "auto_backup": self.auto_backup.isChecked(),
            "save_reminder_minutes": self.reminder.value(),
        }
        current = get_settings(ledger)
        if all(getattr(current, key) == value for key, value in wanted.items()):
            return
        if run_guarded(self, lambda: update_settings(ledger, **wanted)):
            self.notify("Configuração alterada no cofre. Salve (Ctrl+S) para gravar.")
            self.changed()

    def _show_ai_model(self, enabled: bool) -> None:
        for widget in (self.ai_model_label, self.ai_model_row, self.ai_status, self.ai_hint):
            widget.setVisible(enabled)

    # ── computer preferences: written at once ──

    def _lock_changed(self, minutes: int) -> None:
        from opesvault.ui.idle_lock import set_lock_minutes

        set_lock_minutes(minutes)
        window = self.window()
        idle = getattr(window, "idle", None)
        if idle is not None:
            idle.minutes = minutes

    def _toggle_recents(self, enabled: bool) -> None:
        from opesvault.ui import preferences

        preferences.set_recents_enabled(enabled)

    def show_privacy(self) -> None:
        self.tabs.setCurrentIndex(self.privacy_tab)

    # ── data ──

    def refresh(self) -> None:
        for form in self._vault_forms:
            form.setEnabled(self.session is not None)
        from opesvault.ui import preferences
        from opesvault.ui.idle_lock import lock_minutes

        self.lock_minutes.blockSignals(True)
        self.lock_minutes.setValue(lock_minutes())
        self.lock_minutes.blockSignals(False)
        self.recents.blockSignals(True)
        self.recents.setChecked(preferences.recents_enabled())
        self.recents.blockSignals(False)
        if self.session is None:
            return
        self._pending.stop()
        settings = get_settings(self.session.ledger)
        widgets = (self.ai_enabled, self.ai_model, self.backup_dir, self.backup_keep, self.auto_backup, self.reminder)
        for widget in widgets:
            widget.blockSignals(True)
        self.ai_enabled.setChecked(settings.ai_enabled)
        self.ai_model.setCurrentText(settings.ai_model or "")
        self.backup_dir.setText(settings.backup_dir or "")
        self.backup_keep.setValue(settings.backup_keep)
        self.auto_backup.setChecked(settings.auto_backup)
        self.reminder.setValue(settings.save_reminder_minutes)
        for widget in widgets:
            widget.blockSignals(False)
        self._show_ai_model(settings.ai_enabled)

    def _choose_dir(self) -> None:
        from PySide6.QtWidgets import QFileDialog

        folder = QFileDialog.getExistingDirectory(self, "Pasta de backups")
        if folder:
            self.backup_dir.setText(folder)
            self.flush()

    def _window_command(self, name: str) -> None:
        """Vault commands that live in the Cofre menu, reachable from here too."""
        command = getattr(self.window(), name, None)
        if callable(command):
            command()

    def test_ai(self) -> None:
        """Lists the installed models (off the UI thread) and says whether the chosen one is among them."""
        from opesvault.ai.ollama import AiUnavailable, OllamaClient
        from opesvault.ui.background import BackgroundJob

        if self._ai_job is not None:
            return
        chosen = self.ai_model.currentText().strip()
        try:
            client = OllamaClient(chosen or RECOMMENDED_MODELS[0])
        except AiUnavailable as exc:
            self.ai_status.setText(str(exc))
            return

        def work(_report: object) -> object:
            try:
                return client.server_info()
            except AiUnavailable as exc:
                return exc

        job = BackgroundJob(work)
        self._ai_job = job
        self.ai_check.setEnabled(False)
        self.ai_status.setText("Verificando o Ollama local…")
        job.signals.done.connect(lambda result: self._ai_checked(chosen, result))
        job.start()

    def _ai_checked(self, chosen: str, info: object) -> None:
        from opesvault.ai.ollama import ServerInfo

        self._ai_job = None
        self.ai_check.setEnabled(True)
        if not isinstance(info, ServerInfo):
            self.ai_status.setText(f"{info} Abra o Ollama e tente de novo.")
            return
        self.ai_model.blockSignals(True)
        self.ai_model.clear()
        self.ai_model.addItems(list(info.models))
        self.ai_model.setCurrentText(chosen or (info.models[0] if info.models else ""))
        self.ai_model.blockSignals(False)
        recommended = [m for m in RECOMMENDED_MODELS if info.installed(m)]
        if not info.models:
            state = f"nenhum modelo instalado ainda. Instale o indicado com “ollama pull {RECOMMENDED_MODELS[0]}”."
        elif chosen and not info.installed(chosen):
            state = f"o modelo {chosen} não está instalado. Instale com “ollama pull {chosen}”."
        elif not recommended:
            state = (
                f"{len(info.models)} modelo(s) instalado(s); o indicado ({RECOMMENDED_MODELS[0]}) não está entre eles."
            )
        else:
            state = f"{len(info.models)} modelo(s) instalado(s)."
        self.ai_status.setText(f"Ollama {info.version} respondeu: {state}")
        self.flush()


def _note(value: str, *, strong: bool = False) -> QLabel:
    """A form's explanatory caption, kept right under (or above) the fields it explains."""
    label = text(value, "secondary" if strong else "caption", wrap=True)
    label.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
    label.setMinimumWidth(240)
    return label


def _tab(*notes: str) -> tuple[QWidget, QFormLayout, QVBoxLayout]:
    """A settings tab: what kind of setting it is (and why), the fields, then what follows them."""
    host = QWidget()
    column = QVBoxLayout(host)
    column.setContentsMargins(0, SPACE_L, 0, 0)
    column.setSpacing(SPACE_M)
    for index, note in enumerate(notes):
        column.addWidget(_note(note, strong=index == 0))
    form = _form()
    column.addLayout(form)
    after = QVBoxLayout()
    after.setSpacing(SPACE_M)
    column.addLayout(after)
    column.addStretch(1)
    return host, form, after


def _form() -> QFormLayout:
    form = QFormLayout()
    form.setContentsMargins(0, SPACE_S, 0, 0)
    form.setHorizontalSpacing(SPACE_M)
    form.setVerticalSpacing(SPACE_S)
    form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)
    form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    form.setRowWrapPolicy(QFormLayout.RowWrapPolicy.DontWrapRows)
    return form


READABLE_WIDTH = 880  # px: forms and their notes keep a line length that reads well on 1920x1080


def _readable(widget: QWidget) -> QWidget:
    """The form at a comfortable width, aligned left, instead of fields as long as the screen."""
    from PySide6.QtWidgets import QHBoxLayout

    widget.setMaximumWidth(READABLE_WIDTH)
    holder = QWidget()
    row = QHBoxLayout(holder)
    row.setContentsMargins(0, 0, 0, 0)
    row.addWidget(widget, 1)
    row.addStretch(0)
    return holder
