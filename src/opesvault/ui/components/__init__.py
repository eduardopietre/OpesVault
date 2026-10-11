"""Shared UI primitives built on the design tokens (ui/theme.py).

Pages compose these instead of styling widgets one by one, so equivalent things look
and behave the same everywhere. One module per kind of piece; import them from here.
"""

from opesvault.ui.components.basics import (
    ElidedLabel,
    MenuEntry,
    button,
    fill_menu,
    hbox,
    hbox_widget,
    menu_button,
    separator,
    set_tone,
    text,
    vseparator,
)
from opesvault.ui.components.decisions import Choice, Decision, confirm, decide
from opesvault.ui.components.header import PageHeader
from opesvault.ui.components.layout import Adaptive, FlowHost, FlowLayout, adaptive, flow_row, page_margins, scroll_body
from opesvault.ui.components.month import MonthPicker
from opesvault.ui.components.sections import FIGURE_GAP, Collapsible, EmptyState, Figures, Section

__all__ = [
    "FIGURE_GAP",
    "Adaptive",
    "Choice",
    "Collapsible",
    "Decision",
    "ElidedLabel",
    "EmptyState",
    "Figures",
    "FlowHost",
    "FlowLayout",
    "MenuEntry",
    "MonthPicker",
    "PageHeader",
    "Section",
    "adaptive",
    "button",
    "confirm",
    "decide",
    "fill_menu",
    "flow_row",
    "hbox",
    "hbox_widget",
    "menu_button",
    "page_margins",
    "scroll_body",
    "separator",
    "set_tone",
    "text",
    "vseparator",
]
