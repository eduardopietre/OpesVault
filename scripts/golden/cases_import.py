"""importing/pipeline.py, checks.py, suggestions.py, approval.py and rules over whole review flows.

Each scenario starts from the session of tests/test_importing.py, runs a list of steps (import a
document, correct, reject, keep apart, approve…) and records, after every step, its outcome and
a snapshot of the import state and the ledger. Ids are random on both sides, so the snapshot
names things instead: accounts by name, items by batch and position, operations by description.
The TS side replays the same steps and must produce the same snapshots.
"""

import base64
import random
from decimal import Decimal
from pathlib import Path
from typing import Any

from opesvault.domain import queries
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountSubtype, AccountType, Card, LedgerAccount, Operation
from opesvault.importing import pipeline, rules
from opesvault.importing.model import ImportBatch
from opesvault.importing.pipeline import ImportRequest
from opesvault.session import Session
from scripts.golden.cases_parsers import DOCUMENTS
from scripts.golden.common import j
from tests.test_fuzz import _mutate_text

DOCS = {name: build() for name, build in DOCUMENTS}


def ofx(prefix: str, *replacements: tuple[str, str]) -> bytes:
    data = DOCS["bank.ofx"].replace(b"<FITID>F", f"<FITID>{prefix}".encode())
    for old, new in replacements:
        data = data.replace(old.encode(), new.encode())
    return data


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def new_session() -> Session:
    session = Session.new(Path("golden.opesvault"), "Teste")
    ledger = session.ledger
    ana = ledger.add_member("Ana").id
    bank = ledger.add_account(
        LedgerAccount(
            name="Itaú CC",
            type=AccountType.ASSET,
            subtype=AccountSubtype.CHECKING,
            masked_number="56789-0",
            holders=(ana,),
        )
    )
    ledger.add_account(LedgerAccount(name="Poupança", type=AccountType.ASSET, subtype=AccountSubtype.SAVINGS))
    liability = ledger.add_account(
        LedgerAccount(name="Nubank", type=AccountType.LIABILITY, subtype=AccountSubtype.CREDIT_CARD)
    )
    ledger.add_card(
        Card(
            name="Nubank",
            liability_account_id=liability.id,
            holder_id=ana,
            last4="0001",
            closing_day=3,
            due_day=10,
            settlement_account_id=bank.id,
        )
    )
    return session


# ── naming ──────────────────────────────────────────


def account_name(ledger: Ledger, account_id: Any) -> str | None:
    return None if account_id is None else ledger.accounts[account_id].name


def account_id(ledger: Ledger, name: str | None) -> Any:
    if name is None:
        return None
    return next(a.id for a in ledger.accounts.values() if a.name == name)


def op_label(ledger: Ledger, op_id: Any) -> str | None:
    if op_id is None:
        return None
    op = ledger.operations[op_id]
    return f"{op.description}|{op.occurred_on}|{list(ledger.operations).index(op_id)}"


def source_label(ledger: Ledger, source: str | None) -> str | None:
    if source is not None and source.startswith("user_rule:"):
        from uuid import UUID

        return "user_rule:" + rules.rules(ledger)[UUID(source.removeprefix("user_rule:"))].pattern
    return source


def box(bbox: Any) -> Any:
    return None if bbox is None else [round(v, 6) for v in bbox]


def snapshot(session: Session) -> dict[str, Any]:
    ledger = session.ledger
    evidence = pipeline.evidence(ledger)
    batches = []
    for batch in pipeline.batches(ledger).values():
        items = []
        for item in pipeline.items_of(ledger, batch.id):
            items.append(
                {
                    "kind": item.kind.value,
                    "occurred_on": j(item.occurred_on),
                    "description": item.description,
                    "amount": j(item.amount),
                    "installment": list(item.installment) if item.installment else None,
                    "card_last4": item.card_last4,
                    "bank_id": item.bank_id,
                    "foreign": [j(item.foreign_amount), item.foreign_currency],
                    "trade": [j(item.quantity), j(item.unit_price), item.ticker],
                    "credit": item.credit,
                    "status": item.status.value,
                    "warnings": list(item.warnings),
                    "target": account_name(ledger, item.target_account_id),
                    "member": item.member_id is not None,
                    "duplicate_of": op_label(ledger, item.duplicate_of),
                    "operation": op_label(ledger, item.operation_id),
                    "corrections": [[c.field, c.before if c.field != "target_account_id" else None, c.after if c.field != "target_account_id" else None, c.operator, c.reason] for c in item.corrections],
                    "suggestion_source": source_label(ledger, item.suggestion_source),
                    "evidence": [
                        [evidence[e].page, box(evidence[e].bbox), evidence[e].line, evidence[e].text]
                        for e in item.evidence_ids
                    ],
                }
            )
        batches.append(
            {
                "parser_id": batch.parser_id,
                "parser_version": batch.parser_version,
                "doc_format": batch.doc_format.value,
                "doc_type": j(batch.doc_type),
                "status": batch.status.value,
                "account": account_name(ledger, batch.account_id),
                "card": None if batch.card_id is None else ledger.cards[batch.card_id].name,
                "header": {name: j(getattr(batch.header, name)) for name in type(batch.header).model_fields},
                "reconciliations": [[r.label, j(r.expected), j(r.computed), r.ok] for r in batch.reconciliations],
                "warnings": list(batch.warnings),
                "candidates": list(batch.candidates),
                "unmapped_lines": batch.unmapped_lines,
                "partial_reason": batch.partial_reason,
                "document": [d.meta.original_name for d in session.documents if d.meta.id == batch.document_id],
                "items": items,
            }
        )
    operations = [operation_json(ledger, op) for op in ledger.operations.values()]
    return {
        "batches": batches,
        "operations": operations,
        "balances": {a.name: j(queries.balance(ledger, a.id)) for a in ledger.accounts.values()},
        "accounts": [a.name for a in ledger.accounts.values()],
        "documents": [d.meta.original_name for d in session.documents],
        "history": len(ledger.history),
        "evidence": len(pipeline.evidence(ledger)),
    }


def operation_json(ledger: Ledger, op: Operation) -> dict[str, Any]:
    return {
        "kind": op.kind.value,
        "description": op.description,
        "occurred_on": j(op.occurred_on),
        "settled_on": j(op.settled_on),
        "postings": [[account_name(ledger, p.account_id), j(p.amount)] for p in op.postings],
        "notes": op.notes,
        "origin": [op.origin.kind.value, len(op.origin.evidence_ids), op.origin.import_id is not None],
        "card": None if op.card_id is None else ledger.cards[op.card_id].name,
        "status": op.status.value,
        "version": op.version,
    }


# ── steps ───────────────────────────────────────────


def item_at(session: Session, ref: list[int]) -> Any:
    batch = list(pipeline.batches(session.ledger).values())[ref[0]]
    return pipeline.items_of(session.ledger, batch.id)[ref[1]]


def batch_at(session: Session, index: int) -> ImportBatch:
    return list(pipeline.batches(session.ledger).values())[index]


def value_of(session: Session, field: str, value: Any) -> Any:
    if field == "target_account_id":
        return account_id(session.ledger, value)
    if field == "amount" and value is not None:
        return Decimal(value)
    if field == "occurred_on" and value is not None:
        from datetime import date

        return date.fromisoformat(value)
    if field == "kind":
        from opesvault.importing.model import ItemKind

        return ItemKind(value)
    return value


def run_step(session: Session, step: dict[str, Any]) -> Any:
    ledger = session.ledger
    match step["op"]:
        case "import":
            card = step.get("card")
            card_id = next((c.id for c in ledger.cards.values() if c.name == card), None) if card else None
            batch = pipeline.import_document(
                session,
                ImportRequest(
                    step["name"],
                    base64.b64decode(step["bytes"]),
                    parser_id=step.get("parser_id"),
                    account_id=account_id(ledger, step.get("account")),
                    card_id=card_id,
                ),
            )
            return list(pipeline.batches(ledger)).index(batch.id)
        case "approve":
            batch = batch_at(session, step["batch"])
            ids = None if step.get("items") is None else [item_at(session, [step["batch"], i]).id for i in step["items"]]
            result = pipeline.approve(
                ledger, batch.id, ids, accept_divergence=step.get("accept"), partial_reason=step.get("partial")
            )
            return [result.created, result.linked, result.skipped]
        case "correct":
            item = item_at(session, step["item"])
            pipeline.correct_item(
                ledger, item.id, step["field"], value_of(session, step["field"], step["value"]), step.get("reason")
            )
            return None
        case "keep_separate":
            pipeline.keep_separate(ledger, item_at(session, step["item"]).id, step["reason"])
            return None
        case "reject":
            ids = [item_at(session, ref).id for ref in step["items"]]
            pipeline.reject_items(ledger, ids, step["reason"])
            return None
        case "set_target":
            card = step.get("card")
            card_id = next((c.id for c in ledger.cards.values() if c.name == card), None) if card else None
            pipeline.set_batch_target(ledger, batch_at(session, step["batch"]).id, account_id(ledger, step.get("account")), card_id)
            return None
        case "add_rule":
            rules.add_rule(ledger, step["pattern"], account_id(ledger, step["category"]), account_id(ledger, step.get("account")))
            return None
        case "apply_rules":
            batch = None if step.get("batch") is None else batch_at(session, step["batch"]).id
            return pipeline.apply_rules(ledger, batch)
        case "reparse":
            batch = pipeline.reparse_with(session, batch_at(session, step["batch"]).id, step["parser"])
            return list(pipeline.batches(ledger)).index(batch.id)
        case "operator":
            ledger.operator = step["name"]
            return None
        case "expense":
            ledger.record_expense(
                account_id(ledger, step["account"]),
                account_id(ledger, step["category"]),
                step["amount"],
                __import__("datetime").date.fromisoformat(step["on"]),
                step["description"],
            )
            return None
    raise ValueError(step["op"])


def outcome(session: Session, step: dict[str, Any]) -> dict[str, Any]:
    try:
        result = run_step(session, step)
    except Exception as exc:
        return {"error": type(exc).__name__, "message": str(exc)}
    return {"ok": result}


def imp(doc: str | bytes, name: str | None = None, **extra: Any) -> dict[str, Any]:
    data = DOCS[doc] if isinstance(doc, str) else doc
    return {"op": "import", "name": name or (doc if isinstance(doc, str) else "file"), "bytes": b64(data), **extra}


SCENARIOS: dict[str, list[dict[str, Any]]] = {
    "card_review": [
        imp("nubank_card.pdf", "nu.pdf"),
        {"op": "approve", "batch": 0},
        imp("nubank_card.pdf", "copia.pdf"),
    ],
    "divergent": [
        imp("nubank_card_divergent.pdf", "nu.pdf"),
        {"op": "approve", "batch": 0},
        {"op": "approve", "batch": 0, "accept": " "},
        {"op": "approve", "batch": 0, "accept": "fatura com encargo não listado"},
    ],
    "partial": [
        imp("nubank_account.csv", "nu.csv", account="Itaú CC"),
        {"op": "approve", "batch": 0, "items": [0]},
        {"op": "approve", "batch": 0, "items": [0], "partial": "restante amanhã"},
        {"op": "set_target", "batch": 0, "account": "Poupança"},
        {"op": "reject", "items": [[0, 1]], "reason": "não é meu"},
        {"op": "approve", "batch": 0},
    ],
    "overlap": [
        imp(ofx("A"), "jan.ofx", account="Itaú CC"),
        {"op": "approve", "batch": 0},
        imp("itau_bank.pdf", "jan.pdf", account="Itaú CC"),
        {"op": "keep_separate", "item": [1, 1], "reason": "é outro"},
        {"op": "approve", "batch": 1},
        imp(ofx("A", ("PIX ALUGUEL", "PIX ALUGUEL REF")), "b.ofx", account="Itaú CC"),
    ],
    "bill_payment": [
        imp("itau_bank.pdf", "extrato.pdf", account="Itaú CC"),
        {"op": "correct", "item": [0, 4], "field": "target_account_id", "value": "Nubank", "reason": "não existe"},
        {"op": "correct", "item": [0, 3], "field": "target_account_id", "value": "Nubank", "reason": "é a fatura"},
        {"op": "correct", "item": [0, 2], "field": "target_account_id", "value": "Poupança", "reason": "própria"},
        {"op": "approve", "batch": 0},
        imp("card_payment.csv", "card.csv", card="Nubank"),
        imp("savings.csv", "poup.csv", account="Poupança"),
        {"op": "approve", "batch": 1},
        {"op": "approve", "batch": 2},
    ],
    "corrections": [
        {"op": "operator", "name": "Ana"},
        imp("nubank_account.csv", "nu.csv", account="Itaú CC"),
        {"op": "correct", "item": [0, 0], "field": "amount", "value": "1500.01", "reason": "valor no PDF difere"},
        {"op": "correct", "item": [0, 1], "field": "occurred_on", "value": None},
        {"op": "approve", "batch": 0},
        {"op": "correct", "item": [0, 1], "field": "occurred_on", "value": "2026-02-04"},
        {"op": "correct", "item": [0, 2], "field": "description", "value": "Farmácia de novo"},
        {"op": "correct", "item": [0, 2], "field": "kind", "value": "credit"},
        {"op": "correct", "item": [0, 2], "field": "bank_id", "value": "x"},
        {"op": "approve", "batch": 0},
    ],
    "learning": [
        imp(ofx("H"), "a.ofx", account="Itaú CC"),
        {"op": "correct", "item": [0, 1], "field": "target_account_id", "value": "Moradia"},
        {"op": "approve", "batch": 0},
        imp(ofx("J", ("20260110", "20260210"), ("20260105", "20260205")), "b.ofx", account="Itaú CC"),
        {"op": "add_rule", "pattern": "pix aluguel", "category": "Lazer"},
        {"op": "apply_rules", "batch": 1},
        {"op": "add_rule", "pattern": "salario", "category": "Outras receitas", "account": "Itaú CC"},
        {"op": "apply_rules"},
    ],
    "rules_and_keywords": [
        {"op": "expense", "account": "Itaú CC", "category": "Lazer", "amount": "30.00", "on": "2025-12-01", "description": "MERCADO BOM PRECO"},
        {"op": "expense", "account": "Itaú CC", "category": "Lazer", "amount": "30.00", "on": "2025-12-02", "description": "MERCADO BOM PRECO"},
        imp("nubank_card.pdf", "nu.pdf"),
        {"op": "add_rule", "pattern": "mercado bom", "category": "Saúde"},
        {"op": "apply_rules", "batch": 0},
        {"op": "correct", "item": [0, 7], "field": "target_account_id", "value": "Saúde"},
        {"op": "add_rule", "pattern": "padaria", "category": "Lazer"},
        {"op": "apply_rules", "batch": 0},
        {"op": "approve", "batch": 0},
    ],
    "unsupported": [
        imp("unknown_layout.pdf", "x.pdf"),
        imp("scanned.pdf", "scan.pdf"),
        imp("sinacor_note.pdf", "nota.pdf"),
        {"op": "approve", "batch": 2},
        {"op": "approve", "batch": 0},
        {"op": "reparse", "batch": 0, "parser": "itau-extrato-pdf"},
        {"op": "reparse", "batch": 1, "parser": "nubank-cartao-pdf"},
        imp(b"\x81\x8d\x8f", "lixo.bin"),
        imp("itau_card.pdf", "itau.pdf", parser_id="nubank-cartao-pdf"),
        imp("nubank_card.csv", "c.csv", parser_id="nubank-conta-csv"),
        imp("quoted.csv", "q.csv"),
        imp("card.ofx", "card.ofx"),
        imp("itau_bank.pdf", "itau2.pdf", parser_id="não-existe"),
    ],
    "cards": [
        imp("itau_card.pdf", "itau.pdf"),
        imp("bradesco_card.pdf", "brad.pdf", card="Nubank"),
        {"op": "approve", "batch": 0, "accept": "conferido"},
        {"op": "approve", "batch": 1, "accept": "conferido"},
        imp("nubank_card.csv", "nucard.csv", card="Nubank"),
        {"op": "approve", "batch": 2},
    ],
}


def fuzz_scenarios() -> dict[str, list[dict[str, Any]]]:
    """Mutated CSV and OFX files through the whole pipeline, like test_pipeline_survives_mutated_csv_and_ofx."""
    out: dict[str, list[dict[str, Any]]] = {}
    for name in ("nubank_account.csv", "nubank_card.csv", "bank.ofx"):
        rng = random.Random(f"golden-import-{name}")  # noqa: S311 - reproducible fuzzing
        original = DOCS[name].decode("utf-8")
        steps = []
        for i in range(25):
            mutated = _mutate_text(rng, original)
            data = mutated.encode("utf-8" if i % 3 else "cp1252", errors="replace")
            steps.append(imp(data, f"{i}-{name}", account="Itaú CC"))
        steps.append({"op": "approve", "batch": 0, "accept": "fuzz"})
        out[f"fuzz_{name}"] = steps
    return out


def generate() -> dict[str, Any]:
    out = {}
    for name, steps in {**SCENARIOS, **fuzz_scenarios()}.items():
        session = new_session()
        results = []
        for n, step in enumerate(steps):
            # Fuzzed flows keep only the final state: the outcome of each step is enough on the way.
            last = n == len(steps) - 1
            keep = last or not name.startswith("fuzz_")
            results.append({"outcome": outcome(session, step), "snapshot": snapshot(session) if keep else None})
        out[name] = {"steps": steps, "results": results}
    return {"scenarios": out}
