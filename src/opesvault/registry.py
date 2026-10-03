"""Loads every module that registers persisted entity kinds or ledger guards.

Opening a vault must know all kinds; the list is explicit so no tool can drop an
import that only exists for its side effects.
"""

import importlib

MODULES = (
    "opesvault.domain.anomalies",
    "opesvault.domain.attachments",
    "opesvault.domain.balance_checks",
    "opesvault.domain.budget",
    "opesvault.domain.cards",
    "opesvault.domain.deductibles",
    "opesvault.domain.goals",
    "opesvault.domain.loans",
    "opesvault.domain.merchants",
    "opesvault.domain.saved_filters",
    "opesvault.domain.sharing",
    "opesvault.domain.tags",
    "opesvault.domain.periods",
    "opesvault.domain.recurrence",
    "opesvault.domain.settings",
    "opesvault.importing.model",
    "opesvault.importing.rules",
    "opesvault.investments.model",
    "opesvault.investments.trades",
    "opesvault.investments.benchmarks",
)

for _module in MODULES:
    importlib.import_module(_module)
