"""Lists controls a screen reader could not name, on every page and in the main dialogs.

    uv run python scripts/auditar_acessibilidade.py

A control is nameable when it has an accessible name, its own visible text (buttons,
check boxes), or a label pointing to it (`QLabel.setBuddy`, which QFormLayout rows set).
The real check with NVDA or Narrator is still manual (docs/16 §7); this catches the gaps
before that. Synthetic demo data only.
"""

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))
os.environ.setdefault("QT_QPA_PLATFORM", "minimal:enable_fonts" if sys.platform == "win32" else "offscreen")

from PySide6.QtCore import Qt  # noqa: E402
from PySide6.QtWidgets import (  # noqa: E402
    QAbstractButton,
    QAbstractItemView,
    QAbstractSpinBox,
    QApplication,
    QComboBox,
    QHeaderView,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QTabBar,
    QWidget,
)

INPUTS = (QLineEdit, QComboBox, QAbstractSpinBox, QAbstractItemView, QPlainTextEdit)


def unnamed(root: QWidget) -> list[str]:
    buddies = {id(label.buddy()) for label in root.findChildren(QLabel) if label.buddy() is not None}
    problems = []
    for widget in root.findChildren(QWidget):
        if isinstance(widget, QTabBar) or widget.objectName().startswith("qt_"):
            continue
        if isinstance(widget, QLineEdit) and isinstance(widget.parent(), (QComboBox, QAbstractSpinBox)):
            continue  # the editor inside a combo or spin box is named through its owner
        if isinstance(widget, QAbstractButton) and (widget.isHidden() or isinstance(widget.parent(), QLineEdit)):
            continue  # buttons Qt keeps hidden (wizard Help/Commit), or a line edit's own clear button
        if isinstance(widget, QHeaderView) or _inside_combo(widget):
            continue  # headers are read with their table; a combo's popup list with the combo
        if widget.accessibleName().strip() or id(widget) in buddies:
            continue
        if isinstance(widget, QAbstractButton):
            if widget.text().replace("&", "").strip():
                continue
            problems.append(_where(widget, f"{type(widget).__name__} sem texto{_clue(widget)}"))
        elif isinstance(widget, INPUTS):
            problems.append(_where(widget, f"{type(widget).__name__} sem nome{_clue(widget)}"))
    return problems


def _clue(widget: QWidget) -> str:
    """What helps a person find the control: tooltip, placeholder, column titles or first item."""
    from PySide6.QtWidgets import QTableView

    if isinstance(widget, QAbstractButton):
        chain, node = [], widget.parentWidget()
        while node is not None and len(chain) < 3:
            chain.append(type(node).__name__)
            node = node.parentWidget()
        return f" [dentro de: {' < '.join(chain)}]"
    if widget.toolTip():
        return f" [dica: {widget.toolTip()[:50]}]"
    if isinstance(widget, QLineEdit) and widget.placeholderText():
        return f" [dica: {widget.placeholderText()[:50]}]"
    if isinstance(widget, QTableView) and widget.model() is not None:
        model = widget.model()
        titles = [str(model.headerData(c, Qt.Orientation.Horizontal)) for c in range(min(3, model.columnCount()))]
        return f" [colunas: {', '.join(titles)}]"
    if isinstance(widget, QComboBox) and widget.count():
        return f" [itens: {widget.itemText(0)[:30]}…]"
    return ""


def _inside_combo(widget: QWidget) -> bool:
    node = widget.parentWidget()
    while node is not None:
        if isinstance(node, QComboBox) or type(node).__name__ == "QComboBoxPrivateContainer":
            return True
        node = node.parentWidget()
    return False


def _where(widget: QWidget, problem: str) -> str:
    path = []
    node: QWidget | None = widget
    while node is not None and len(path) < 4:
        title = getattr(node, "title", None)
        if isinstance(title, str) and title:
            path.append(title)
            break
        node = node.parentWidget()
    return f"{' › '.join(reversed(path)) or '?'}: {problem}"


def main() -> None:
    import capturar_telas as screens

    from opesvault.ui.main_window import MainWindow
    from opesvault.ui.theme import apply_theme

    app = QApplication(sys.argv)
    apply_theme(app, dark=False)
    with tempfile.TemporaryDirectory() as tmp:
        print("auditando telas…", flush=True)
        window = MainWindow()
        problems = [f"Sem cofre › {p.split(': ', 1)[-1]}" for p in unnamed(window.welcome)]
        window.session = screens.demo_session(Path(tmp) / "demo.opesvault")
        window._refresh()
        for page in window.pages:
            problems += [f"{page.title} › {p}" for p in unnamed(page)]
        problems += [f"Janela › {p}" for p in unnamed(window.toolbar)]
        print("auditando diálogos…", flush=True)
        problems += _dialogs(window)
        # No window.close(): the demo vault is unsaved and closing would ask to save (a modal dialog).
    for line in sorted(set(problems)):
        print(line)
    print(f"\n{len(set(problems))} controle(s) sem nome acessível", flush=True)
    # Tearing down many Qt widgets can hang on some platforms; the report is already out.
    os._exit(1 if problems else 0)


def _dialogs(window: QWidget) -> list[str]:
    from opesvault.domain.model import YearMonth
    from opesvault.ui.dialogs import AccountDialog, CardDialog, CategoryDialog, MemberDialog, OperationDialog
    from opesvault.ui.pages.budget_page import BudgetGridDialog
    from opesvault.ui.setup_wizard import SetupWizard

    session = getattr(window, "session", None)
    if session is None:
        return []
    ledger = session.ledger
    dialogs = {
        **{f"Novo lançamento ({kind})": OperationDialog(window, ledger, kind) for kind in OperationDialog.KINDS},
        "Conta": AccountDialog(window, ledger),
        "Cartão": CardDialog(window, ledger),
        "Categoria": CategoryDialog(window, ledger),
        "Integrante": MemberDialog(window, ledger),
        "Orçamento do mês": BudgetGridDialog(window, ledger, YearMonth(year=2026, month=10)),
        "Assistente": SetupWizard(window, ledger),
    }
    out = []
    for name, dialog in dialogs.items():
        out += [f"Diálogo {name} › {p.split(': ', 1)[-1]}" for p in unnamed(dialog)]
        dialog.deleteLater()
    return out


if __name__ == "__main__":
    main()
