"""Imports every module that registers persisted entity kinds on the Ledger.

Opening a vault must know all kinds; importing this module guarantees that.
"""

import opesvault.domain.settings
import opesvault.importing.model  # noqa: F401
