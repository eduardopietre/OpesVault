"""Imports every module that registers persisted entity kinds or ledger guards.

Opening a vault must know all kinds; importing this module guarantees that.
"""

import opesvault.domain.cards
import opesvault.domain.periods
import opesvault.domain.recurrence
import opesvault.domain.settings
import opesvault.importing.model  # noqa: F401
