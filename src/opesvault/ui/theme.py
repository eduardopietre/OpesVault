"""Design system: semantic color tokens, spacing and text styles, applied once to the app.

Widgets never hard-code colors. They opt into semantic styles through dynamic
properties that the stylesheet below understands:

    label.setProperty("textStyle", "title" | "headline" | "strong" | "secondary" | "caption" | "figure")
    button.setProperty("role", "primary" | "destructive" | "plain")
    label.setProperty("tone", "positive" | "negative" | "warning")

Light and dark follow the operating system unless forced (tests, screenshots).
"""

from dataclasses import dataclass

from PySide6.QtCore import QLibraryInfo, QLocale, Qt, QTranslator
from PySide6.QtGui import QColor, QFont, QPalette
from PySide6.QtWidgets import QApplication, QWidget

# Spacing scale (px): inside a control, between related items, within a group, between groups,
# between sections of a page.
SPACE_XS = 4
SPACE_S = 8
SPACE_M = 12
SPACE_L = 16
SPACE_XL = 24
SPACE_XXL = 32
RADIUS = 6
ROW_HEIGHT = 26
NAV_ROW_HEIGHT = 28

# Type scale (px). One family (the system UI font: Segoe UI on Windows), two weights.
FONT_BODY_PT = 10.0  # ~13 px at 100%: navigation, tables, forms
TITLE_PX = 22
HEADLINE_PX = 15
CAPTION_PX = 12
FIGURE_PX = 26


@dataclass(frozen=True)
class Tokens:
    window: str  # chrome: sidebar, toolbar
    content: str  # main working surface
    raised: str  # inputs, tables
    alternate: str  # zebra rows
    separator: str
    text: str
    secondary: str  # still AA on `content`
    tertiary: str
    accent: str
    accent_text: str
    selection: str  # selected row background (focused)
    selection_inactive: str
    hover: str
    positive: str
    negative: str
    warning: str


LIGHT = Tokens(
    window="#f2f2f4",
    content="#ffffff",
    raised="#ffffff",
    alternate="#f7f7f9",
    separator="#dcdce0",
    text="#1d1d1f",
    secondary="#5b5b61",
    tertiary="#8a8a90",
    accent="#0a64c8",
    accent_text="#ffffff",
    selection="#0a64c8",
    selection_inactive="#dcdce2",
    hover="#ececf0",
    positive="#2a7a46",
    negative="#a63830",  # muted: a loss is information, not an alarm
    warning="#9a6400",
)

DARK = Tokens(
    window="#232326",
    content="#1b1b1d",
    raised="#2a2a2d",
    alternate="#212124",
    separator="#3a3a3e",
    text="#f2f2f4",
    secondary="#b0b0b6",
    tertiary="#86868c",
    accent="#3b8ef0",
    accent_text="#ffffff",
    selection="#2f6fc0",
    selection_inactive="#3a3a40",
    hover="#2e2e32",
    positive="#5cbf7d",
    negative="#e8867c",
    warning="#e0a43a",
)

_current = LIGHT


def tokens() -> Tokens:
    return _current


def is_dark_system(app: QApplication) -> bool:
    return app.styleHints().colorScheme() == Qt.ColorScheme.Dark


def _palette(t: Tokens) -> QPalette:
    palette = QPalette()
    roles = {
        QPalette.ColorRole.Window: t.window,
        QPalette.ColorRole.WindowText: t.text,
        QPalette.ColorRole.Base: t.raised,
        QPalette.ColorRole.AlternateBase: t.alternate,
        QPalette.ColorRole.Text: t.text,
        QPalette.ColorRole.Button: t.raised,
        QPalette.ColorRole.ButtonText: t.text,
        QPalette.ColorRole.Highlight: t.selection,
        QPalette.ColorRole.HighlightedText: t.accent_text,
        QPalette.ColorRole.ToolTipBase: t.raised,
        QPalette.ColorRole.ToolTipText: t.text,
        QPalette.ColorRole.PlaceholderText: t.tertiary,
        QPalette.ColorRole.Link: t.accent,
        QPalette.ColorRole.Mid: t.separator,
        QPalette.ColorRole.Midlight: t.hover,
        QPalette.ColorRole.Accent: t.accent,
    }
    for role, color in roles.items():
        palette.setColor(role, QColor(color))
    for role in (QPalette.ColorRole.Text, QPalette.ColorRole.WindowText, QPalette.ColorRole.ButtonText):
        palette.setColor(QPalette.ColorGroup.Disabled, role, QColor(t.tertiary))
    palette.setColor(QPalette.ColorGroup.Inactive, QPalette.ColorRole.Highlight, QColor(t.selection_inactive))
    palette.setColor(QPalette.ColorGroup.Inactive, QPalette.ColorRole.HighlightedText, QColor(t.text))
    return palette


def stylesheet(t: Tokens) -> str:
    return f"""
QWidget#Content, QStackedWidget#Pages, QWidget#Page, QWidget#Surface {{ background: {t.content}; }}
QScrollArea {{ background: transparent; border: none; }}
QWidget#Sidebar, QListWidget#Sidebar {{ background: {t.window}; border: none; }}
QToolBar#MainToolbar {{
    background: {t.window}; border: none; border-bottom: 1px solid {t.separator};
    padding: {SPACE_XS}px {SPACE_S}px; spacing: {SPACE_S}px;
}}
QStatusBar {{ background: {t.window}; border-top: 1px solid {t.separator}; color: {t.secondary}; }}
QSplitter::handle {{ background: {t.separator}; }}
QSplitter::handle:horizontal {{ width: 1px; }}
QSplitter::handle:vertical {{ height: 1px; }}

QListWidget#Sidebar {{ padding: {SPACE_S}px {SPACE_S}px 0 {SPACE_S}px; outline: 0; border-radius: 0; }}
QListWidget#SidebarFooter {{
    background: {t.window}; padding: {SPACE_S}px; border: none; border-top: 1px solid {t.separator};
    border-radius: 0; outline: 0;
}}
QListWidget#Sidebar::item, QListWidget#SidebarFooter::item {{
    min-height: {NAV_ROW_HEIGHT}px; padding: 0 {SPACE_S}px; border-radius: {RADIUS}px; color: {t.text};
}}
QListWidget#Sidebar::item:hover, QListWidget#SidebarFooter::item:hover {{ background: {t.hover}; }}
/* Selection is a quiet fill and a stronger weight; accent stays reserved for actions and focus. */
QListWidget#Sidebar::item:selected, QListWidget#SidebarFooter::item:selected {{
    background: {t.selection_inactive}; color: {t.text}; font-weight: 600;
}}
QListWidget#Sidebar::item:disabled {{
    color: {t.secondary}; font-size: {CAPTION_PX}px; font-weight: 600; background: transparent;
    min-height: {ROW_HEIGHT}px; padding-top: {SPACE_M}px;
}}

QLabel[textStyle="title"] {{ font-size: {TITLE_PX}px; font-weight: 600; color: {t.text}; }}
QLabel[textStyle="headline"] {{ font-size: {HEADLINE_PX}px; font-weight: 600; color: {t.text}; }}
QLabel[textStyle="strong"] {{ font-weight: 600; color: {t.text}; }}
QLabel[textStyle="secondary"] {{ color: {t.secondary}; }}
QLabel[textStyle="caption"] {{ color: {t.secondary}; font-size: {CAPTION_PX}px; }}
QLabel[textStyle="figure"] {{ font-size: {FIGURE_PX}px; font-weight: 600; color: {t.text}; }}
QLabel[tone="positive"] {{ color: {t.positive}; }}
QLabel[tone="negative"] {{ color: {t.negative}; }}
QLabel[tone="warning"] {{ color: {t.warning}; }}

QPushButton, QToolButton#Action {{
    background: {t.raised}; color: {t.text}; border: 1px solid {t.separator};
    border-radius: {RADIUS}px; padding: {SPACE_XS}px {SPACE_M}px; min-height: 18px;
}}
QPushButton:hover, QToolButton#Action:hover {{ background: {t.hover}; }}
QPushButton:pressed, QToolButton#Action:pressed {{ background: {t.selection_inactive}; }}
QPushButton:focus, QToolButton#Action:focus {{ border: 2px solid {t.accent}; padding: 3px 11px; }}
QPushButton:disabled, QToolButton#Action:disabled {{ color: {t.tertiary}; background: {t.window}; }}
QPushButton[role="primary"] {{ background: {t.accent}; color: {t.accent_text}; border-color: {t.accent}; }}
QPushButton[role="primary"]:hover {{ background: {t.selection}; }}
QPushButton[role="primary"]:focus {{ border: 2px solid {t.text}; }}
QPushButton[role="primary"]:disabled {{ background: {t.selection_inactive}; border-color: {t.separator}; }}
QToolButton#Action[role="primary"] {{ background: {t.accent}; color: {t.accent_text}; border-color: {t.accent}; }}
QToolButton#Action[role="primary"]:hover {{ background: {t.selection}; }}
QPushButton[role="destructive"] {{ color: {t.negative}; }}
QPushButton[role="plain"], QToolButton#Plain {{ background: transparent; border: 1px solid transparent; }}
QPushButton[role="plain"]:hover, QToolButton#Plain:hover {{ background: {t.hover}; }}
QToolButton#Action::menu-indicator {{ subcontrol-position: right center; right: {SPACE_XS}px; }}
QToolButton#Action[popupMode="2"] {{ padding-right: {SPACE_XL}px; }}

QLineEdit, QPlainTextEdit, QTextEdit {{
    background: {t.raised}; color: {t.text}; border: 1px solid {t.separator};
    border-radius: {RADIUS}px; padding: 3px {SPACE_S}px; selection-background-color: {t.accent};
}}
QLineEdit:focus, QPlainTextEdit:focus, QTextEdit:focus {{
    border: 2px solid {t.accent}; padding: 2px 7px;
}}
QLineEdit:disabled {{
    color: {t.tertiary}; background: {t.window};
}}
QLineEdit[invalid="true"] {{ border: 2px solid {t.negative}; }}
QComboBox QAbstractItemView {{
    background: {t.raised}; border: 1px solid {t.separator}; selection-background-color: {t.selection};
}}

QTableView, QTableWidget, QTreeView, QListView, QListWidget {{
    background: {t.raised}; alternate-background-color: {t.alternate}; color: {t.text};
    border: 1px solid {t.separator}; border-radius: {RADIUS}px; gridline-color: transparent;
    selection-background-color: {t.selection_inactive}; selection-color: {t.text};
}}
QTableView:focus, QTableWidget:focus {{ selection-background-color: {t.selection}; selection-color: {t.accent_text}; }}
QTableView::item, QTableWidget::item {{ padding: 0 {SPACE_S}px; border: none; }}
QTableView::item:hover, QTableWidget::item:hover {{ background: {t.hover}; }}
QTableView::item:selected, QTableWidget::item:selected {{ background: {t.selection_inactive}; color: {t.text}; }}
QTableView::item:selected:active, QTableWidget::item:selected:active {{
    background: {t.selection}; color: {t.accent_text};
}}
QListWidget::item {{ min-height: {ROW_HEIGHT}px; padding: 0 {SPACE_S}px; }}
QListWidget::item:hover {{ background: {t.hover}; }}
QListWidget::item:selected {{ background: {t.selection_inactive}; color: {t.text}; }}
QListWidget::item:selected:active {{ background: {t.selection}; color: {t.accent_text}; }}
/* Selection already shows where focus is; the dotted current-cell box only adds noise. */
QTableView, QTableWidget {{ outline: 0; }}
/* A quiet source list (Relatórios): like the sidebar, neutral selection and stronger text. */
QListWidget[variant="plain"] {{ border: none; background: transparent; outline: 0; }}
QListWidget[variant="plain"]::item {{ min-height: {NAV_ROW_HEIGHT}px; border-radius: {RADIUS}px; }}
QListWidget[variant="plain"]::item:selected, QListWidget[variant="plain"]::item:selected:active {{
    background: {t.selection_inactive}; color: {t.text}; font-weight: 600;
}}
/* Summary tables: no outer frame, no zebra; a header rule and row dividers organize the lines. */
QTableWidget[variant="plain"] {{ border: none; border-radius: 0; background: transparent; }}
QTableWidget[variant="plain"]::item {{ border-bottom: 1px solid {t.separator}; }}
QTableWidget[variant="plain"] QHeaderView::section {{ background: {t.content}; }}
QHeaderView::section {{
    background: {t.raised}; color: {t.secondary}; border: none; border-bottom: 1px solid {t.separator};
    padding: {SPACE_XS}px {SPACE_S}px; font-weight: 600;
}}
QTableCornerButton::section {{ background: {t.raised}; border: none; }}

QTabWidget::pane {{ border: none; border-top: 1px solid {t.separator}; top: -1px; }}
/* The pane's rule is the only line under the tabs (Fusion's own base line ignores the palette). */
QTabBar {{ qproperty-drawBase: 0; }}
QTabBar::tab {{
    background: transparent; color: {t.secondary}; padding: {SPACE_XS + 2}px {SPACE_M}px;
    border: none; border-bottom: 2px solid transparent; margin-right: {SPACE_XS}px;
}}
QTabBar::tab:hover {{ color: {t.text}; }}
QTabBar::tab:selected {{ color: {t.text}; border-bottom: 2px solid {t.accent}; font-weight: 600; }}
QTabBar::tab:focus {{ color: {t.accent}; }}

QGroupBox {{
    border: none; border-top: 1px solid {t.separator}; margin-top: {SPACE_L}px;
    padding-top: {SPACE_M}px; font-weight: 600;
}}
QGroupBox::title {{ subcontrol-origin: margin; left: 0; padding: 0; color: {t.text}; }}

QMenu {{ background: {t.raised}; border: 1px solid {t.separator}; padding: {SPACE_XS}px; }}
QMenu::item {{ padding: {SPACE_XS}px {SPACE_XL}px {SPACE_XS}px {SPACE_M}px; border-radius: 4px; }}
QMenu::item:selected {{ background: {t.selection}; color: {t.accent_text}; }}
QMenu::item:disabled {{ color: {t.tertiary}; }}
QMenu::separator {{ height: 1px; background: {t.separator}; margin: {SPACE_XS}px {SPACE_S}px; }}
QToolTip {{ background: {t.raised}; color: {t.text}; border: 1px solid {t.separator}; padding: {SPACE_XS}px; }}

QFrame#Separator {{ background: {t.separator}; max-height: 1px; min-height: 1px; border: none; }}
QFrame#VSeparator {{ background: {t.separator}; max-width: 1px; min-width: 1px; border: none; }}
QToolButton#Stepper {{
    background: {t.raised}; color: {t.text}; border: 1px solid {t.separator}; border-radius: {RADIUS}px;
    min-width: 26px; min-height: 22px; font-size: 16px; padding: 0;
}}
QToolButton#Stepper:hover {{ background: {t.hover}; }}
QToolButton#Stepper:pressed {{ background: {t.selection_inactive}; }}
QToolButton#Stepper:focus {{ border: 2px solid {t.accent}; }}
QToolButton#Stepper:disabled {{ color: {t.tertiary}; }}
QFrame#FilterChip {{ background: {t.hover}; border-radius: {RADIUS}px; }}
QLabel#SaveDot[state="dirty"] {{ color: {t.warning}; }}
QLabel#SaveDot[state="clean"] {{ color: {t.positive}; }}
"""


_translators: list[QTranslator] = []


def install_translations(app: QApplication) -> None:
    """Portuguese for Qt's own texts (standard buttons, file dialogs, context menus)."""
    if _translators:
        return
    directory = QLibraryInfo.path(QLibraryInfo.LibraryPath.TranslationsPath)
    translator = QTranslator(app)
    if translator.load(QLocale("pt_BR"), "qtbase", "_", directory):
        app.installTranslator(translator)
        _translators.append(translator)


def apply_theme(app: QApplication, dark: bool | None = None) -> Tokens:
    """Applies the palette and stylesheet. `dark=None` follows the system appearance."""
    global _current
    install_translations(app)
    use_dark = is_dark_system(app) if dark is None else dark
    _current = DARK if use_dark else LIGHT
    app.setStyle("Fusion")  # identical metrics on every platform; the palette carries the look
    app.setPalette(_palette(_current))
    font = QFont(app.font())
    if font.pointSizeF() < FONT_BODY_PT:
        font.setPointSizeF(FONT_BODY_PT)
    font.setFeature(QFont.Tag("tnum"), 1)  # tabular figures: amounts line up in columns
    app.setFont(font)
    app.setStyleSheet(stylesheet(_current))
    return _current


def follow_system(app: QApplication) -> None:
    """Re-applies the theme when the user switches light/dark while the app runs."""
    app.styleHints().colorSchemeChanged.connect(lambda _scheme: apply_theme(app))


def restyle(widget: QWidget) -> None:
    """Re-evaluates the stylesheet after a dynamic property changed."""
    style = widget.style()
    style.unpolish(widget)
    style.polish(widget)
    widget.update()
