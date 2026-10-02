"""Deliberate exports (RF-20). Outputs are plain files outside the vault's protection.

Interchange format (version 1, docs/13 §5):
- UTF-8 JSON; decimals as strings with '.' separator and full precision;
- dates ISO 8601 (YYYY-MM-DD), instants with explicit offset;
- every entity keeps its stable UUID; documents' bytes are not included.
"""

import csv
import io
import json
from datetime import UTC, datetime
from typing import Any

from opesvault.domain.ledger import Ledger

INTERCHANGE_FORMAT = "opesvault-intercambio"
INTERCHANGE_VERSION = 1

LEDGER_COLUMNS = (
    "operacao_id",
    "versao",
    "situacao",
    "tipo",
    "descricao",
    "data_ocorrencia",
    "data_caixa",
    "competencia",
    "conta",
    "tipo_conta",
    "valor",
    "moeda",
    "integrante_rateio",
    "origem",
)


def ledger_csv(ledger: Ledger) -> bytes:
    """One row per posting (debit positive, credit negative), so totals re-balance in any spreadsheet."""
    out = io.StringIO()
    writer = csv.writer(out, delimiter=";", lineterminator="\n")
    writer.writerow(LEDGER_COLUMNS)
    members = {m.id: m.name for m in ledger.members.values()}
    for op in sorted(
        ledger.operations.values(), key=lambda o: (o.cash_date or o.occurred_on or datetime.min.date(), str(o.id))
    ):
        for posting in op.postings:
            account = ledger.account(posting.account_id)
            writer.writerow(
                (
                    str(op.id),
                    op.version,
                    op.status.value,
                    op.kind.value,
                    op.description,
                    op.occurred_on.isoformat() if op.occurred_on else "",
                    op.cash_date.isoformat() if op.cash_date else "",
                    str(op.competence) if op.competence else "",
                    account.name,
                    account.type.value,
                    format(posting.amount, "f"),
                    op.currency,
                    members.get(posting.member_id, "") if posting.member_id else "",
                    op.origin.kind.value,
                )
            )
    return ("﻿" + out.getvalue()).encode("utf-8")


def interchange_json(ledger: Ledger) -> bytes:
    rows = ledger.to_records()
    payload: dict[str, Any] = {
        "formato": INTERCHANGE_FORMAT,
        "versao_formato": INTERCHANGE_VERSION,
        "versao_esquema": ledger.meta.schema_version,
        "exportado_em": datetime.now(UTC).isoformat(),
        "aviso": "Arquivo sem criptografia; contém dados financeiros.",
        "entidades": [{"id": str(rid), "tipo": kind, "dados": data} for rid, kind, data in rows],
    }
    return json.dumps(payload, ensure_ascii=False, indent=1).encode("utf-8")
