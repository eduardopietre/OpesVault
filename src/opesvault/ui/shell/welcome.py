"""No vault open: create, open or restore one, and the vaults this computer remembers."""

from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QCheckBox, QListWidget, QListWidgetItem, QVBoxLayout, QWidget

from opesvault.ui.components import EmptyState, button, text
from opesvault.ui.theme import NAV_ROW_HEIGHT, SPACE_M, SPACE_S

SHOWN_RECENTS = 6


class WelcomePanel(EmptyState):
    """The first screen. Recent vaults are only paths, and only with consent (docs/07 §1)."""

    new_requested = Signal()
    open_requested = Signal()
    restore_requested = Signal()
    recent_chosen = Signal(Path)
    recents_consented = Signal(bool)

    def __init__(self) -> None:
        new = button("Novo cofre…", role="primary")
        open_ = button("Abrir cofre…")
        restore = button("Restaurar backup…")
        super().__init__(
            "Nenhum cofre aberto",
            "Cada projeto tem um cofre: um arquivo .opesvault cifrado com a sua senha, com lançamentos e "
            "documentos. Nada sai deste computador.",
            [new, open_, restore],
        )
        self.new_button, self.open_button, self.restore_button = new, open_, restore
        for widget, signal in (
            (new, self.new_requested),
            (open_, self.open_requested),
            (restore, self.restore_requested),
        ):
            widget.clicked.connect(lambda _=False, s=signal: s.emit())
        self.recent_list = QListWidget()
        self.recent_list.setProperty("variant", "plain")
        self.recent_list.setFrameShape(QListWidget.Shape.NoFrame)
        self.recent_list.setAccessibleName("Cofres recentes")
        self.recent_list.itemActivated.connect(self._choose)
        self.recent_list.itemClicked.connect(self._choose)
        self.recent_list.viewport().setCursor(Qt.CursorShape.PointingHandCursor)
        self.recent_title = text("Abertos recentemente neste computador", "headline")
        self.remember_recents = QCheckBox("Lembrar os cofres abertos neste computador (só o caminho do arquivo)")
        self.remember_recents.toggled.connect(self.recents_consented.emit)
        recent = QWidget()
        recent.setMaximumWidth(560)
        column = QVBoxLayout(recent)
        column.setContentsMargins(0, 0, 0, 0)
        column.setSpacing(SPACE_S)
        column.addWidget(self.recent_title)
        column.addWidget(self.recent_list)
        column.addWidget(self.remember_recents)
        # Right under the actions, inside the empty state's own column (before its bottom stretch).
        column_layout = self.layout()
        assert isinstance(column_layout, QVBoxLayout)
        column_layout.insertSpacing(column_layout.count() - 1, SPACE_M * 2)
        column_layout.insertWidget(column_layout.count() - 1, recent, 0, Qt.AlignmentFlag.AlignHCenter)
        self.setObjectName("Content")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)  # custom widget: paint the surface

    def show_recents(self, paths: list[str], *, enabled: bool) -> None:
        """Lists `paths` (missing files greyed out); offers consent while the list is off."""
        shown = paths[:SHOWN_RECENTS] if enabled else []
        self.recent_list.clear()
        for path in shown:
            exists = Path(path).exists()
            item = QListWidgetItem(
                f"{Path(path).name}  ·  {Path(path).parent}" if exists else f"{path} (não encontrado)"
            )
            item.setData(Qt.ItemDataRole.UserRole, path)
            item.setToolTip(path)
            if not exists:
                item.setFlags(Qt.ItemFlag.NoItemFlags)
            self.recent_list.addItem(item)
        self.recent_list.setFixedHeight(len(shown) * (NAV_ROW_HEIGHT + 2) + 4)
        self.recent_title.setVisible(bool(shown))
        self.recent_list.setVisible(bool(shown))
        self.remember_recents.blockSignals(True)
        self.remember_recents.setChecked(enabled)
        self.remember_recents.blockSignals(False)
        self.remember_recents.setVisible(not enabled)  # once on, it is changed in Configurações

    def _choose(self, item: QListWidgetItem) -> None:
        path = item.data(Qt.ItemDataRole.UserRole)
        if isinstance(path, str) and Path(path).exists():
            self.recent_chosen.emit(Path(path))
