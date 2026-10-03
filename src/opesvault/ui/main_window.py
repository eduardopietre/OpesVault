"""Application shell: sidebar navigation, toolbar, menus and save state (docs/07 §1, §7).

The window assembles parts kept in `opesvault.ui.shell`: the sidebar and the welcome screen
are widgets it holds; vault, backup, lock and recent-vault commands are mixins.
"""

from collections.abc import Callable
from typing import Any, ClassVar

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QCloseEvent, QKeySequence
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QSizePolicy,
    QSplitter,
    QStackedWidget,
    QToolBar,
    QToolButton,
    QWidget,
)

from opesvault.session import Session
from opesvault.ui import preferences
from opesvault.ui.components import ElidedLabel
from opesvault.ui.idle_lock import IdleWatcher, LockPanel, lock_minutes
from opesvault.ui.pages.accounts_page import AccountsPage
from opesvault.ui.pages.agenda_page import AgendaPage
from opesvault.ui.pages.base import Page
from opesvault.ui.pages.budget_page import BudgetPage
from opesvault.ui.pages.documents_page import DocumentsPage
from opesvault.ui.pages.goals_page import GoalsPage
from opesvault.ui.pages.import_page import ImportPage
from opesvault.ui.pages.investments_page import InvestmentsPage
from opesvault.ui.pages.ledger_page import LedgerPage
from opesvault.ui.pages.overview_page import OverviewPage
from opesvault.ui.pages.recurrences_page import RecurrencesPage
from opesvault.ui.pages.reports_page import ReportsPage
from opesvault.ui.pages.settings_page import SettingsPage
from opesvault.ui.pages.sharing_page import SharingPage
from opesvault.ui.pages.tax_page import TaxPage
from opesvault.ui.shell.backups import BackupCommands
from opesvault.ui.shell.jobs import VaultJob
from opesvault.ui.shell.recents import RecentVaults
from opesvault.ui.shell.screen_lock import ScreenLock
from opesvault.ui.shell.sidebar import Sidebar
from opesvault.ui.shell.vault import VaultCommands
from opesvault.ui.shell.welcome import WelcomePanel
from opesvault.ui.theme import SPACE_M, SPACE_S, SPACE_XS, restyle
from opesvault.vault.client import VaultClient
from opesvault.vault.lock import VaultLock


class MainWindow(VaultCommands, BackupCommands, ScreenLock, RecentVaults, QMainWindow):
    # Keys pages use with `Page.navigate` → the page class that answers them.
    TARGETS: ClassVar[dict[str, type[Page]]] = {
        "overview": OverviewPage,
        "budget": BudgetPage,
        "ledger": LedgerPage,
        "import": ImportPage,
        "accounts": AccountsPage,
        "recurrences": RecurrencesPage,
        "reports": ReportsPage,
        "investments": InvestmentsPage,
        "agenda": AgendaPage,
        "sharing": SharingPage,
        "goals": GoalsPage,
        "settings": SettingsPage,
        "documents": DocumentsPage,
        "tax": TaxPage,
    }
    # Pages whose sidebar row shows a count of what needs attention.
    COUNTED: ClassVar[tuple[type[Page], ...]] = (OverviewPage, ImportPage)

    def __init__(self) -> None:
        super().__init__()
        self.client = VaultClient()
        self.session: Session | None = None
        self.lock: VaultLock | None = None
        self.locked = False
        self._vault_busy = False
        self._page_busy_flag = False
        self._over_budget: set[tuple[int, int, object]] = set()
        self._budget_owner: Session | None = None
        self._jobs: set[VaultJob] = set()
        self._disabled_actions: list[QAction] = []
        self._dirty_since: float | None = None

        self.pages: list[Page] = self.build_pages()
        self.stack = QStackedWidget()
        self.stack.setObjectName("Pages")
        for page in self.pages:
            page.set_busy_hook(self._page_busy)
            page.set_notify_hook(self.notify)
            page.set_navigate_hook(self.navigate)
            page.set_month_hook(self._month_chosen)
            self.stack.addWidget(page)
        counted = {i for i, page in enumerate(self.pages) if isinstance(page, self.COUNTED)}
        self.sidebar = Sidebar(self.pages, counted)
        self.sidebar.page_chosen.connect(self._show_page)
        self.nav = self.sidebar.nav

        self.splitter = QSplitter(Qt.Orientation.Horizontal)
        self.splitter.setChildrenCollapsible(False)
        self.splitter.addWidget(self.sidebar)
        self.splitter.addWidget(self.stack)
        self.splitter.setStretchFactor(1, 1)
        self.splitter.setSizes([self.sidebar.preferred_width(), 1080])
        self.content = QWidget()
        self.content.setObjectName("Content")
        layout = QHBoxLayout(self.content)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.splitter)

        self.lock_panel = LockPanel()
        self.lock_panel.unlock_requested.connect(self.unlock_screen)
        self.welcome = WelcomePanel()
        self.welcome.new_requested.connect(self.new_vault)
        self.welcome.open_requested.connect(self.open_vault)
        self.welcome.restore_requested.connect(self.restore_backup)
        self.welcome.recent_chosen.connect(self._open_recent)
        self.welcome.recents_consented.connect(self._consent_recents)
        self.shell = QStackedWidget()
        for widget in (self.content, self.lock_panel, self.welcome):
            self.shell.addWidget(widget)
        self.setCentralWidget(self.shell)

        self._build_menus()
        self.operator = QComboBox()
        self.operator.setToolTip("Quem está operando: fica registrado no histórico de cada alteração")
        self.operator.setAccessibleName("Operador")
        self.operator.currentIndexChanged.connect(self._set_operator)
        self.status = QLabel()
        self.status.setObjectName("SaveState")
        self.status.setAccessibleName("Estado do salvamento")
        self._build_toolbar()
        self.statusBar().setSizeGripEnabled(True)
        self._restore_geometry()
        self.show_page(0)
        self.idle = IdleWatcher(self, lock_minutes())
        self.idle.idle.connect(self._on_idle)
        self.setAcceptDrops(True)  # files dropped anywhere go to "Importar e revisar"
        overview = self._page(OverviewPage)
        if overview is not None:
            overview.extra_alerts = self.backup_alerts
        app = QApplication.instance()
        if app is not None:
            app.installEventFilter(self.idle)
        self.reminder = QTimer(self)
        self.reminder.timeout.connect(self._remind)
        self.reminder.start(60_000)
        self._refresh()

    def build_pages(self) -> list[Page]:
        """Pages in sidebar order."""
        return [
            OverviewPage(self.on_changed),
            BudgetPage(self.on_changed),
            AgendaPage(self.on_changed),
            LedgerPage(self.on_changed),
            ImportPage(self.on_changed),
            AccountsPage(self.on_changed),
            RecurrencesPage(self.on_changed),
            InvestmentsPage(self.on_changed),
            ReportsPage(self.on_changed),
            GoalsPage(self.on_changed),
            SharingPage(self.on_changed),
            TaxPage(self.on_changed),
            DocumentsPage(self.on_changed),
            SettingsPage(self.on_changed),
        ]

    def _page[P: Page](self, kind: type[P]) -> P | None:
        return next((p for p in self.pages if isinstance(p, kind)), None)

    # ── menus and toolbar ───────────────────────────

    def _action(self, menu: Any, text: str, shortcut: Any, slot: Callable[[], None]) -> QAction:
        action = QAction(text, self)
        if shortcut is not None:
            action.setShortcut(shortcut)
        action.triggered.connect(lambda _=False: slot())  # never forward `checked` as an argument
        menu.addAction(action)
        return action

    def _build_menus(self) -> None:
        bar = self.menuBar()
        vault = bar.addMenu("&Cofre")
        self.vault_menu = vault
        self._action(vault, "&Novo cofre…", QKeySequence.StandardKey.New, self.new_vault)
        self._action(vault, "&Abrir cofre…", QKeySequence.StandardKey.Open, self.open_vault)
        self.save_action = self._action(vault, "&Salvar", QKeySequence.StandardKey.Save, self.save_vault)
        self._action(vault, "&Fechar cofre", QKeySequence("Ctrl+W"), self.close_vault)
        vault.addSeparator()
        self._action(vault, "Assistente de configuração…", None, self.run_setup_wizard)
        self._action(vault, "Trocar senha…", None, self.change_password)
        self._action(vault, "Fazer backup agora", None, self.backup_now)
        self._action(vault, "Verificar backup…", None, self.verify_backup)
        self._action(vault, "Restaurar backup…", None, self.restore_backup)
        vault.addSeparator()
        self._action(vault, "Exportar livro financeiro (CSV)…", None, lambda: self.export("csv"))
        self._action(vault, "Exportar dados para intercâmbio (JSON)…", None, lambda: self.export("json"))
        self._action(vault, "Relatório do mês (PDF)…", None, self.export_month_report)
        self._action(vault, "Fechamento do ano (PDF)…", None, self.export_year_report)
        vault.addSeparator()
        self.recent_menu = vault.addMenu("Recentes")
        self.recent_menu.aboutToShow.connect(self._fill_recents)

        edit = bar.addMenu("&Editar")
        self.edit_menu = edit
        self.undo_action = self._action(edit, "Desfazer", QKeySequence.StandardKey.Undo, self.undo)
        self.redo_action = self._action(edit, "Refazer", QKeySequence.StandardKey.Redo, self.redo)
        self.redo_action.setShortcuts([QKeySequence(QKeySequence.StandardKey.Redo), QKeySequence("Ctrl+Shift+Z")])
        for action in (self.undo_action, self.redo_action):
            action.setEnabled(False)

        view = bar.addMenu("E&xibir")
        self.view_menu = view
        self.toggle_sidebar_action = self._action(
            view, "Barra lateral", QKeySequence("Ctrl+Shift+B"), self.toggle_sidebar
        )
        self.toggle_sidebar_action.setCheckable(True)
        self.toggle_sidebar_action.setChecked(True)
        self._action(view, "Buscar nesta tela", QKeySequence.StandardKey.Find, self.focus_search)
        view.addSeparator()
        self._action(view, "Ocultar conteúdo agora", QKeySequence("Ctrl+L"), self.lock_screen)

        go = bar.addMenu("&Ir")
        self.go_menu = go
        for index, page in enumerate(self.pages):
            shortcut = QKeySequence(f"Ctrl+{index + 1}") if index < 9 else None
            self._action(go, page.title, shortcut, lambda _=False, i=index: self.show_page(i))

        help_menu = bar.addMenu("A&juda")
        self.help_menu = help_menu
        self._action(help_menu, "Ajuda desta tela", QKeySequence.StandardKey.HelpContents, self.show_help)
        self._action(help_menu, "Sobre o OpesVault", None, self.show_about)

    def _build_toolbar(self) -> None:
        from opesvault.ui.components import button, hbox_widget, text, vseparator
        from opesvault.ui.icons import sidebar_icon

        bar = QToolBar("Barra de ferramentas")
        bar.setObjectName("MainToolbar")
        bar.setMovable(False)
        bar.setFloatable(False)
        bar.toggleViewAction().setEnabled(False)
        self.toggle_sidebar_action.setIcon(sidebar_icon(self.palette().windowText().color()))
        self.toggle_sidebar_action.setToolTip("Mostrar ou ocultar a barra lateral (Ctrl+Shift+B)")
        self.sidebar_button = QToolButton()
        self.sidebar_button.setObjectName("Plain")
        self.sidebar_button.setDefaultAction(self.toggle_sidebar_action)
        self.sidebar_button.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonIconOnly)
        self.sidebar_button.setAccessibleName("Barra lateral")
        bar.addWidget(self.sidebar_button)
        # The vault's name leads; the file name is secondary context (full path in the tooltip).
        self.context_label = ElidedLabel("", "strong")
        self.context_label.setAccessibleName("Cofre aberto")
        self.file_label = ElidedLabel("", "secondary")
        self.file_label.setAccessibleName("Arquivo do cofre")
        bar.addWidget(hbox_widget(self.context_label, self.file_label, spacing=SPACE_S))
        spacer = QWidget()
        spacer.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        bar.addWidget(spacer)
        self.save_dot = QLabel("●")
        self.save_dot.setObjectName("SaveDot")
        self.save_dot.setAccessibleName("Indicador de salvamento")
        self.status.setProperty("textStyle", "secondary")
        self.save_button = button(
            "Salvar", self.save_vault, tip="Salvar o cofre (Ctrl+S). A senha é pedida a cada vez."
        )
        self.operator_label = text("Operador", "secondary")
        # Two groups: save state with its action, then who is operating.
        save_group = hbox_widget(self.save_dot, self.status, SPACE_M, self.save_button, spacing=SPACE_XS)
        operator_group = hbox_widget(self.operator_label, self.operator, spacing=SPACE_S)
        divider = hbox_widget(SPACE_M, vseparator(), SPACE_M)
        # Toolbar visibility is controlled through the actions addWidget returns.
        self._session_actions = [bar.addWidget(widget) for widget in (save_group, divider, operator_group)]
        self.addToolBar(Qt.ToolBarArea.TopToolBarArea, bar)
        self.toolbar = bar

    # ── navigation ──────────────────────────────────

    def show_page(self, index: int) -> None:
        """Selects a section by page index (the sidebar shows it and the stack follows)."""
        self.sidebar.select(index)

    def _show_page(self, index: int) -> None:
        if 0 <= index < len(self.pages):
            self.stack.setCurrentIndex(index)
            self.pages[index].refresh()

    def navigate(self, target: str, ref: object = None, *, act: bool = False) -> None:
        """Opens the page answering `target` and shows `ref` there (`act` also starts its action)."""
        kind = self.TARGETS.get(target)
        page = self._page(kind) if kind is not None else None
        if page is None:
            return
        self.show_page(self.pages.index(page))
        if ref is not None or act:
            page.reveal(ref, act=act)

    def _month_chosen(self, source: Page, month: object) -> None:
        """Overview, Budget and Ledger look at the same month: a choice in one moves the others."""
        for page in self.pages:
            if page is not source:
                page.follow_month(month)

    def toggle_sidebar(self) -> None:
        self.sidebar.setVisible(not self.sidebar.isVisible())
        self.toggle_sidebar_action.setChecked(self.sidebar.isVisible())

    def focus_search(self) -> None:
        page = self.stack.currentWidget()
        if isinstance(page, Page) and not page.focus_search():
            self.notify("Esta tela não tem busca.")

    def notify(self, message: str) -> None:
        self.statusBar().showMessage(message, 5000)

    def show_alerts_on_open(self) -> None:
        """Offline app, no background notifications: opening is when it says what is due."""
        if self.session is None:
            return
        from opesvault.domain.alerts import Severity, alerts

        found = alerts(self.session.ledger)
        if not found:
            return
        self.navigate("overview")
        overview = self._page(OverviewPage)
        if overview is not None:
            overview.show_alerts()
        urgent = sum(1 for a in found if a.severity is Severity.URGENT)
        lead = f"{urgent} atrasado(s) ou estourado(s) · " if urgent else ""
        self.notify(f"{lead}{len(found)} aviso(s) em Visão geral.")

    def show_help(self) -> None:
        from opesvault.ui.help import help_for

        page = self.stack.currentWidget()
        title = page.title if isinstance(page, Page) and not self.locked else ""
        box = QMessageBox(self)
        box.setWindowTitle("Ajuda")
        box.setTextFormat(Qt.TextFormat.RichText)
        box.setText(help_for(title))
        box.exec()

    def show_about(self) -> None:
        from opesvault import __version__

        QMessageBox.about(
            self,
            "Sobre o OpesVault",
            f"OpesVault {__version__}\nFinanças de projetos offline, com cofre cifrado.\n"
            "Licenças de terceiros: arquivo THIRD_PARTY_LICENSES na pasta de instalação.",
        )

    # Files dropped anywhere: the import queue (the Import page also accepts them directly).
    def dragEnterEvent(self, event: Any) -> None:  # noqa: N802 - Qt override
        if self.session is not None and not self.locked and ImportPage._dropped_paths(event.mimeData()):
            event.acceptProposedAction()

    def dropEvent(self, event: Any) -> None:  # noqa: N802 - Qt override
        paths = ImportPage._dropped_paths(event.mimeData())
        page = self._page(ImportPage)
        if self.session is None or self.locked or not paths or page is None:
            return
        event.acceptProposedAction()
        self.navigate("import")
        page.import_paths(paths)
        self.notify(f"{len(paths)} arquivo(s) na fila de importação.")

    # ── window geometry (preferences of this computer) ──

    def _restore_geometry(self) -> None:
        settings = preferences.app_settings()
        geometry = settings.value("janela/geometria")
        if geometry is not None:
            self.restoreGeometry(geometry)  # type: ignore[arg-type]
        else:
            self.resize(1280, 800)
        sizes = settings.value("janela/lateral")
        if sizes is not None:
            self.splitter.restoreState(sizes)  # type: ignore[arg-type]
        self.sidebar.setVisible(bool(settings.value("janela/lateral_visivel", True, type=bool)))
        self.toggle_sidebar_action.setChecked(not self.sidebar.isHidden())

    def _save_geometry(self) -> None:
        settings = preferences.app_settings()
        settings.setValue("janela/geometria", self.saveGeometry())
        settings.setValue("janela/lateral", self.splitter.saveState())
        settings.setValue("janela/lateral_visivel", not self.sidebar.isHidden())

    # ── state ───────────────────────────────────────

    @property
    def busy(self) -> bool:
        """A vault operation (open/save/backup) or a page job (import) is running."""
        return self._vault_busy or self._page_busy_flag

    def _page_busy(self, busy: bool) -> None:
        """A page is mutating the session off the UI thread (import): no save, no edits."""
        self._page_busy_flag = busy
        self.content.setEnabled(not busy)
        if busy:
            self.status.setText("Processando documento…")
        else:
            self._refresh()

    def on_changed(self) -> None:
        if self.session is not None:
            self.session.undo_stack().seal()  # one user action = one undo step
        current = self.stack.currentWidget()
        if isinstance(current, Page):
            current.refresh()
        self._refresh()
        self._check_budget()

    def undo(self) -> None:
        """Undo and redo cover only edits not yet saved."""
        if self.session is None or self.busy or self.locked:
            return
        step = self.session.undo_stack().undo()
        if step is None:
            self.notify("Nada a desfazer desde o último salvamento.")
            return
        self._after_history_move(f"Desfeito: {step.label}. Ctrl+Shift+Z refaz.")

    def redo(self) -> None:
        if self.session is None or self.busy or self.locked:
            return
        step = self.session.undo_stack().redo()
        if step is not None:
            self._after_history_move(f"Refeito: {step.label}.")

    def _after_history_move(self, message: str) -> None:
        current = self.stack.currentWidget()
        if isinstance(current, Page):
            current.refresh()
        self._refresh()
        self.notify(message)

    def _update_undo_actions(self) -> None:
        stack = self.session.undo_stack() if self.session is not None else None
        undo_label = stack.undo_label() if stack else None
        redo_label = stack.redo_label() if stack else None
        enabled = not self.busy
        self.undo_action.setEnabled(bool(undo_label) and enabled)
        self.redo_action.setEnabled(bool(redo_label) and enabled)
        self.undo_action.setText(f"Desfazer {undo_label}" if undo_label else "Desfazer")
        self.redo_action.setText(f"Refazer {redo_label}" if redo_label else "Refazer")

    def _check_budget(self) -> None:
        """Says so the moment an edit pushes a category over its plan (alert on overspend)."""
        if self.session is None:
            return
        from opesvault.domain import budget

        ledger = self.session.ledger
        baseline = self._budget_owner is not self.session  # a vault just opened: no news yet
        self._budget_owner = self.session
        over: set[tuple[int, int, object]] = set()
        months = {(line.month.year, line.month.month): line.month for line in budget.lines(ledger).values()}
        for key, month in months.items():
            over |= {(*key, row.category_id) for row in budget.status(ledger, month).over}
        new = over - self._over_budget
        self._over_budget = over
        if new and not baseline:
            from opesvault.ui.common import month_label

            year, number, category_id = sorted(new, key=str)[0]
            account = ledger.accounts.get(category_id)  # type: ignore[arg-type]
            extra = f" e mais {len(new) - 1}" if len(new) > 1 else ""
            label = month_label(months[(year, number)])
            self.notify(f"Orçamento estourado: {account.name if account else '?'} em {label}{extra}.")

    def _set_operator(self) -> None:
        if self.session is not None:
            self.session.ledger.operator = self.operator.currentText() or None

    def _update_badges(self) -> None:
        """Counts that need attention, next to the section name."""
        if self.session is None:
            return
        from opesvault.domain.alerts import Severity, alerts
        from opesvault.importing import pipeline
        from opesvault.importing.model import ItemStatus

        pending = sum(
            1
            for item in pipeline.items(self.session.ledger).values()
            if item.status in (ItemStatus.READY, ItemStatus.NEEDS_REVIEW)
        )
        attention = sum(1 for a in alerts(self.session.ledger) if a.severity is not Severity.INFO)
        counts = {}
        for index, page in enumerate(self.pages):
            if isinstance(page, ImportPage):
                counts[index] = pending
            elif isinstance(page, OverviewPage):
                counts[index] = attention
        self.sidebar.set_counts(counts)

    def _refresh(self) -> None:
        if self.locked:
            return
        for page in self.pages:
            if page.session is not self.session:
                page.set_session(self.session)
        has_session = self.session is not None
        self.shell.setCurrentWidget(self.content if has_session else self.welcome)
        for action in self._session_actions:
            action.setVisible(has_session)
        self.save_action.setEnabled(has_session)
        self.go_menu.setEnabled(has_session)
        if self.session is None:
            self._refresh_welcome()
            self.setWindowTitle("OpesVault")
            self.context_label.setText("OpesVault")
            self.file_label.clear()
            self.operator.clear()
            self._update_undo_actions()
            return
        names = [m.name for m in self.session.ledger.members.values() if m.active]
        # "Who is operating" only means something when more than one person uses the vault.
        for action in self._session_actions[1:]:
            action.setVisible(len(names) > 1)
        if [self.operator.itemText(i) for i in range(self.operator.count())] != names:
            current = self.session.ledger.operator
            self.operator.blockSignals(True)
            self.operator.clear()
            self.operator.addItems(names)
            if current in names:
                self.operator.setCurrentText(current)
            self.operator.blockSignals(False)
            self._set_operator()
        self._update_badges()
        self._update_undo_actions()
        family = self.session.ledger.meta.family_name
        # The toolbar already shows unsaved changes; the title does not repeat it with "*".
        self.setWindowTitle(f"{family} — OpesVault")
        self.context_label.setText(family)
        self.file_label.setText(self.session.path.name)
        self.file_label.setToolTip(str(self.session.path))
        if not self._vault_busy:
            self._show_save_state()

    def _show_save_state(self) -> None:
        assert self.session is not None
        dirty = self.session.dirty
        if dirty:
            self.status.setText("Alterações não salvas")
        elif self.session.revision is not None:
            self.status.setText(f"Salvo · revisão {self.session.revision.revision}")
        else:
            self.status.setText("Novo cofre")
        self.save_dot.setProperty("state", "dirty" if dirty else "clean")
        self.save_dot.setToolTip("Há alterações só na memória" if dirty else "Tudo gravado no cofre")
        self.save_button.setProperty("role", "primary" if dirty else "")
        for widget in (self.save_dot, self.save_button):
            restyle(widget)

    def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802 - Qt override
        if self.busy or not self._confirm_discard("sair", self.close):
            event.ignore()
            return
        self._save_geometry()
        self._drop_session(exiting=True)
        event.accept()
