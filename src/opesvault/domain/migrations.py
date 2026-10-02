"""Domain schema migrations (RNF-07, docs/04 §7).

Each step takes the meta payload and all rows of version N and returns version
N+1. Migrations run in memory after a successful open; the migrated data is only
persisted by an explicit, password-confirmed save, so the previous revision
stays on disk as the backup until then.
"""

from collections.abc import Callable
from typing import Any
from uuid import UUID

from opesvault.domain.ledger import SCHEMA_VERSION, DomainError

Row = tuple[UUID, str, dict[str, Any]]
Step = Callable[[dict[str, Any], list[Row]], tuple[dict[str, Any], list[Row]]]

STEPS: dict[int, Step] = {}


def migrate(meta: dict[str, Any], rows: list[Row]) -> tuple[dict[str, Any], list[Row]]:
    version = int(meta.get("schema_version", 0))
    if version > SCHEMA_VERSION:
        raise DomainError("Cofre criado por uma versão mais nova do OpesVault.")
    while version < SCHEMA_VERSION:
        step = STEPS.get(version)
        if step is None:
            raise DomainError("Não há migração disponível para este cofre.")
        meta, rows = step(meta, rows)
        version += 1
        meta = {**meta, "schema_version": version}
    return meta, rows
