"""Loads every module that registers persisted entity kinds or ledger guards.

Opening a vault must know all kinds; the list is explicit so no tool can drop an
import that only exists for its side effects.
"""

import importlib

MODULES = (
    "opesvault.domain.cards",
    "opesvault.domain.periods",
    "opesvault.domain.recurrence",
    "opesvault.domain.settings",
    "opesvault.importing.model",
    "opesvault.investments.model",
    "opesvault.investments.trades",
    "opesvault.investments.benchmarks",
)

for _module in MODULES:
    importlib.import_module(_module)
