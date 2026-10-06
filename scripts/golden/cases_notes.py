"""investments/notes.py: approving brokerage notes (cost allocation, IRRF, positions, errors).

Each scenario is a list of steps over a session (accounts, positions, a note imported from a
synthetic PDF, approvals). After every step the golden records the outcome and a snapshot made of
names and numbers (ids are random on both sides): balances, operations, positions with their
holdings, events, extracted items and batches. The TS side replays the steps with pdf.js and must
give the same snapshots, including the state left behind by an approval that fails half way
(approve_note is not atomic on the desktop either).
"""

import base64
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

from opesvault.devtools.synthetic_pdf import make_pdf
from opesvault.domain import queries
from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount
from opesvault.importing import pipeline
from opesvault.importing.pipeline import ImportRequest
from opesvault.investments import notes, service, trades
from opesvault.investments.model import AssetClass, TrackingMode
from opesvault.session import Session
from scripts.golden.cases_investments import norm
from scripts.golden.common import j
from tests import synthetic_docs as docs


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _money(value: Decimal) -> str:
    text = f"{abs(value):,.2f}"
    return text.replace(",", "X").replace(".", ",").replace("X", ".")


def note_pdf(
    trade_lines: list[tuple[str, str, int, str]],
    *,
    number: str = "123456",
    day: str | None = "02/03/2026",
    settle: str = "04/03/2026",
    costs: list[tuple[str, str, str]] | None = None,
    irrf: str | None = None,
    deduct_irrf: bool = False,
    broker: str = "CORRETORA FICTICIA - CLEAR",
) -> bytes:
    """A SINACOR note: (side C/V, spec, quantity, price) lines, costs (label, value, D/C), optional IRRF."""
    lines = ["NOTA DE NEGOCIAÇÃO", "Nr. nota Folha Data pregão"]
    if day is not None:
        lines.append(f"{number} 1 {day}")
    else:
        lines.append(f"{number} 1")
    lines += [broker, "Negócios realizados"]
    net = Decimal(0)
    for side, spec, qty, price in trade_lines:
        value = (Decimal(qty) * Decimal(price)).quantize(Decimal("0.01"))
        marker = "C" if side == "V" else "D"
        lines.append(f"1-BOVESPA {side} VISTA {spec} {qty} {_money(Decimal(price))} {_money(value)} {marker}")
        net += value if side == "V" else -value
    lines += ["Resumo dos Negócios Resumo Financeiro"]
    for label, value, marker in costs or []:
        lines.append(f"{label} {value} {marker}")
        amount = Decimal(value.replace(".", "").replace(",", "."))
        net += amount if marker == "C" else -amount
    if irrf is not None:
        lines.append(f"I.R.R.F. s/ operações, base R$1.000,00 {irrf}")
        if deduct_irrf:
            net -= Decimal(irrf.replace(".", "").replace(",", "."))
    lines.append(f"Líquido para {settle} {_money(net)} {'C' if net >= 0 else 'D'}")
    return make_pdf(lines)


def _session() -> Session:
    return Session.new(Path("golden.opesvault"), "Teste")


def _account(session: Session, name: str, subtype: str) -> UUID:
    kind = AccountType.ASSET
    return session.ledger.add_account(LedgerAccount(name=name, type=kind, subtype=AccountSubtype(subtype))).id


def _by_name(session: Session, name: str) -> UUID:
    return next(a.id for a in session.ledger.accounts.values() if a.name == name)


def _position(session: Session, name: str) -> UUID:
    ledger = session.ledger
    return next(p.id for p in service.positions(ledger).values() if service.assets(ledger)[p.asset_id].name == name)


def _batch(session: Session, index: int) -> Any:
    return list(pipeline.batches(session.ledger).values())[index]


def run_step(session: Session, step: dict[str, Any]) -> Any:
    ledger = session.ledger
    match step["op"]:
        case "account":
            _account(session, step["name"], step["subtype"])
            return None
        case "opening":
            ledger.record_opening_balance(
                _by_name(session, step["account"]), step["amount"], date.fromisoformat(step["on"])
            )
            return None
        case "position":
            service.create_position(
                ledger,
                step["name"],
                AssetClass(step["class"]),
                date.fromisoformat(step["on"]),
                mode=TrackingMode.QUANTITY,
                ticker=step.get("ticker"),
            )
            return None
        case "lot":
            trades.opening_lot(
                ledger, _position(session, step["position"]), date.fromisoformat(step["on"]), step["qty"], step["cost"]
            )
            return None
        case "import":
            account = step.get("account")
            batch = pipeline.import_document(
                session,
                ImportRequest(
                    step["name"],
                    base64.b64decode(step["pdf"]),
                    account_id=_by_name(session, account) if account else None,
                ),
            )
            return list(pipeline.batches(ledger)).index(batch.id)
        case "set_target":
            pipeline.set_batch_target(
                ledger, _batch(session, step["batch"]).id, _by_name(session, step["account"]), None
            )
            return None
        case "approve":
            batch = _batch(session, step["batch"])
            items = pipeline.items_of(ledger, batch.id)
            ids = None if step.get("items") is None else [items[i].id for i in step["items"]]
            result = pipeline.approve(ledger, batch.id, ids, partial_reason=step.get("partial"))
            return [result.created, result.linked, result.skipped]
        case "direct":
            # notes.approve_note called straight on the batch's items, as the pipeline would
            batch = _batch(session, step["batch"])
            items = pipeline.items_of(ledger, batch.id)
            chosen = [items[i] for i in step["items"]] if step.get("items") is not None else items
            result = notes.approve_note(ledger, batch, chosen)
            return [result.created, result.linked, result.skipped]
    raise ValueError(step["op"])


def outcome(session: Session, step: dict[str, Any]) -> dict[str, Any]:
    try:
        return {"ok": run_step(session, step)}
    except Exception as exc:
        return {"error": type(exc).__name__, "message": str(exc)}


def snapshot(session: Session) -> dict[str, Any]:
    ledger = session.ledger
    names = {a.id: a.name for a in ledger.accounts.values()}
    positions = []
    for pos in service.positions(ledger).values():
        asset = service.assets(ledger)[pos.asset_id]
        h = trades.holding(ledger, pos.id)
        positions.append(
            {
                "name": asset.name,
                "ticker": asset.ticker,
                "class": asset.asset_class.value,
                "mode": pos.mode.value,
                "closed": pos.closed,
                "opened_on": j(pos.opened_on),
                "holder": pos.holder_id is not None,
                "quantity": j(h.quantity),
                "cost": j(h.cost),
                "average_price": j(h.average_price),
                "events": [norm(j(e), set()) for e in service.events_of(ledger, pos.id)],
                "lots": [norm(j(lot), set()) for lot in trades.lots_of(ledger, pos.id)],
            }
        )
    batches = []
    for batch in pipeline.batches(ledger).values():
        batches.append(
            {
                "status": batch.status.value,
                "account": names.get(batch.account_id) if batch.account_id else None,
                "header": {name: j(getattr(batch.header, name)) for name in type(batch.header).model_fields},
                "warnings": list(batch.warnings),
                "items": [
                    {
                        "kind": i.kind.value,
                        "description": i.description,
                        "amount": j(i.amount),
                        "quantity": j(i.quantity),
                        "unit_price": j(i.unit_price),
                        "ticker": i.ticker,
                        "credit": i.credit,
                        "status": i.status.value,
                        "operation": i.operation_id is not None,
                        "warnings": list(i.warnings),
                    }
                    for i in pipeline.items_of(ledger, batch.id)
                ],
            }
        )
    return {
        "balances": [[a.name, j(queries.balance(ledger, a.id))] for a in ledger.accounts.values()],
        "operations": [
            {
                "kind": op.kind.value,
                "description": op.description,
                "occurred_on": j(op.occurred_on),
                "settled_on": j(op.settled_on),
                "notes": op.notes,
                "postings": [[names[p.account_id], j(p.amount)] for p in op.postings],
                "status": op.status.value,
            }
            for op in ledger.operations.values()
        ],
        "positions": positions,
        "batches": batches,
        "history": [[h.action.value, h.reason] for h in ledger.history if h.action.value == "approve_import"],
    }


def _imp(name: str, pdf: bytes, account: str | None = "Corretora") -> dict[str, Any]:
    return {"op": "import", "name": name, "pdf": _b64(pdf), "account": account}


BASE: list[dict[str, Any]] = [
    {"op": "account", "name": "Corretora", "subtype": "brokerage_cash"},
    {"op": "opening", "account": "Corretora", "amount": "10000.00", "on": "2026-03-01"},
]
VALE = [
    {"op": "position", "name": "VALE3", "class": "stock", "on": "2026-01-01", "ticker": "VALE3"},
    {"op": "lot", "position": "VALE3", "on": "2026-01-01", "qty": "100", "cost": "5000.00"},
]
SPEC_PETR = "PETROBRAS PN N2 PETR4"
SPEC_VALE = "VALE ON NM VALE3"
SPEC_ITSA = "ITAUSA PN N1 ITSA4 #"
SPEC_FII = "FII KINEA RENDA CI KNCR11"
SPEC_ETF = "ETF ISHARES CI ER IVVB11"
SPEC_PLAIN = "ACOES SEM CODIGO"


def _scenarios() -> dict[str, list[dict[str, Any]]]:
    standard = docs.sinacor_note_pdf()
    costs = [("Taxa de liquidação", "1,65", "D"), ("Emolumentos", "0,30", "D"), ("Taxa Operacional", "3,10", "D")]
    sells = note_pdf(
        [("V", SPEC_VALE, 60, "60.00"), ("V", SPEC_PETR, 40, "31.25")],
        costs=costs,
        irrf="0,17",
        deduct_irrf=True,
        number="777",
    )
    classes = note_pdf(
        [("C", SPEC_FII, 7, "98.30"), ("C", SPEC_ETF, 3, "301.10"), ("C", SPEC_PLAIN, 11, "4.05")],
        costs=[("Taxa de liquidação", "0,97", "D"), ("Outros", "0,25", "C")],
        number="888",
    )
    mixed = note_pdf(
        [("C", SPEC_PETR, 100, "30.00"), ("V", SPEC_PETR, 100, "31.00"), ("C", SPEC_VALE, 10, "61.07")],
        costs=[("Emolumentos", "0,07", "D"), ("Taxa Operacional", "1,00", "D")],
        irrf="0,10",
        deduct_irrf=True,
        number="999",
    )
    irrf_only_info = note_pdf(
        [("V", SPEC_VALE, 10, "60.00")], costs=[("Emolumentos", "0,01", "D")], irrf="0,01", number="31"
    )
    no_day = note_pdf([("C", SPEC_PETR, 10, "30.00")], day=None, number="55")
    no_trades = note_pdf([], number="56")
    other_day = note_pdf([("V", SPEC_PETR, 100, "35.00")], day="09/03/2026", settle="11/03/2026", number="1001")
    rebuy = note_pdf([("C", SPEC_PETR, 20, "33.33")], day="16/03/2026", settle="18/03/2026", number="1002")
    return {
        "standard note with the lot held (TA / test_portfolio)": [
            *BASE,
            *VALE,
            _imp("nota.pdf", standard),
            {"op": "approve", "batch": 0},
            {"op": "approve", "batch": 0},
        ],
        "standard note without anything held is refused half way": [
            *BASE,
            _imp("nota.pdf", standard),
            {"op": "approve", "batch": 0},
        ],
        "note without an account": [
            *BASE,
            *VALE,
            _imp("nota.pdf", standard, account=None),
            {"op": "approve", "batch": 0},
            {"op": "direct", "batch": 0},
            {"op": "set_target", "batch": 0, "account": "Corretora"},
            {"op": "approve", "batch": 0},
        ],
        "sells with IRRF deducted from the net": [
            *BASE,
            *VALE,
            {"op": "position", "name": "PETR4", "class": "stock", "on": "2026-01-01", "ticker": "PETR4"},
            {"op": "lot", "position": "PETR4", "on": "2026-01-01", "qty": "100", "cost": "2500.00"},
            _imp("vendas.pdf", sells),
            {"op": "approve", "batch": 0},
        ],
        "asset classes guessed from the specification": [
            *BASE,
            _imp("classes.pdf", classes),
            {"op": "approve", "batch": 0},
        ],
        "buy and sell of the same ticker in one note": [
            *BASE,
            *VALE,
            _imp("misto.pdf", mixed),
            {"op": "approve", "batch": 0},
        ],
        "IRRF informed but not deducted": [
            *BASE,
            *VALE,
            _imp("irrf.pdf", irrf_only_info),
            {"op": "approve", "batch": 0},
        ],
        "partial approval needs a reason and leaves the costs out": [
            *BASE,
            *VALE,
            _imp("nota.pdf", standard),
            {"op": "approve", "batch": 0, "items": [0, 2]},
            {"op": "approve", "batch": 0, "items": [0, 2], "partial": "só estes"},
            {"op": "approve", "batch": 0},
        ],
        "direct approval with a subset": [
            *BASE,
            *VALE,
            _imp("nota.pdf", standard),
            {"op": "direct", "batch": 0, "items": [2]},
            {"op": "direct", "batch": 0, "items": []},
            {"op": "direct", "batch": 0},
        ],
        "note without the trading date": [
            *BASE,
            _imp("semdata.pdf", no_day),
            {"op": "approve", "batch": 0},
            {"op": "direct", "batch": 0},
        ],
        "note without trades": [*BASE, _imp("vazia.pdf", no_trades), {"op": "approve", "batch": 0}],
        "a position is reused, closed and reopened by later notes": [
            *BASE,
            {"op": "position", "name": "PETR4", "class": "stock", "on": "2026-01-01", "ticker": "PETR4"},
            {"op": "lot", "position": "PETR4", "on": "2026-01-01", "qty": "100", "cost": "2900.00"},
            _imp("venda.pdf", other_day),
            {"op": "approve", "batch": 0},
            _imp("recompra.pdf", rebuy),
            {"op": "approve", "batch": 1},
        ],
    }


def generate() -> dict[str, Any]:
    out = []
    for name, steps in _scenarios().items():
        session = _session()
        results = []
        for step in steps:
            results.append({"outcome": outcome(session, step), "snapshot": snapshot(session)})
        out.append({"name": name, "steps": steps, "results": results})
    cases = [
        ("FII CI", "KNCR11"),
        ("FII", None),
        ("ETF IVVB11", "IVVB11"),
        ("CI ER", None),
        ("XCI Y", "XCIY11"),
        ("ACAO ON", "ABCD3"),
        ("ACAO ON", None),
        ("fii ações", None),
        ("ÇFII", None),
        ("CI", None),
        ("FIIA", None),
        ("ABC_FII", "X"),
        ("CI  ER", None),
    ]
    return {
        "scenarios": out,
        "guess_class": [
            {"spec": spec, "ticker": ticker, "class": notes.guess_class(spec, ticker).value} for spec, ticker in cases
        ],
    }
