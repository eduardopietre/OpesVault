"""Pickers over the embedded lists (catalogs): banks by COMPE code and IRPF Bens e Direitos codes."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QComboBox, QCompleter

from opesvault.catalogs import banks
from opesvault.catalogs.irpf import ASSET_CODES, investment_codes
from opesvault.ui.common import fill_combo, select_combo

OTHER_BANK = "__outra__"


def asset_code_combo(value: tuple[str, str] | None, groups: tuple[str, ...] | None = None) -> QComboBox:
    """Every "GG.CC — description" of the Bens e Direitos table (or of `groups`); value (group, code)."""
    combo = QComboBox()
    combo.setAccessibleName("Grupo e código do IRPF")
    items = []
    for group, (name, codes) in ASSET_CODES.items():
        if groups is not None and group not in groups:
            continue
        items += [(f"{group}.{code} — {description} ({name})", (group, code)) for code, description in codes.items()]
    fill_combo(combo, items, empty="Escolha na tabela do IRPF…")
    combo.setMaxVisibleItems(18)
    _searchable(combo)
    select_combo(combo, value)
    return combo


def investment_code_combo(value: tuple[str, str] | None) -> QComboBox:
    combo = QComboBox()
    combo.setAccessibleName("Tipo do investimento (IRPF)")
    fill_combo(
        combo,
        [(f"{group}.{code} — {description}", (group, code)) for group, code, description in investment_codes()],
        empty="Escolha o tipo…",
    )
    combo.setMaxVisibleItems(18)
    _searchable(combo)
    select_combo(combo, value)
    return combo


def bank_combo(code: str | None) -> QComboBox:
    """All banks with a COMPE code; type part of the name or the code to find one."""
    combo = QComboBox()
    combo.setAccessibleName("Banco")
    fill_combo(combo, [(b.label, b.code) for b in banks()], empty="Escolha o banco…")
    combo.addItem("Outra instituição (sem código COMPE)", OTHER_BANK)
    combo.setMaxVisibleItems(18)
    _searchable(combo)
    select_combo(combo, code)
    return combo


def _searchable(combo: QComboBox) -> None:
    """Typing filters the list by any part of the text (code or name)."""
    combo.setEditable(True)
    combo.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
    completer = combo.completer()
    if completer is not None:
        completer.setFilterMode(Qt.MatchFlag.MatchContains)
        completer.setCompletionMode(QCompleter.CompletionMode.PopupCompletion)
        completer.setCaseSensitivity(Qt.CaseSensitivity.CaseInsensitive)
