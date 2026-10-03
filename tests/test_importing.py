from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from opesvault.domain import queries
from opesvault.domain.ledger import DomainError
from opesvault.domain.model import AccountSubtype, AccountType, Card, LedgerAccount, OperationKind
from opesvault.importing import pipeline
from opesvault.importing.model import BatchStatus, DocType, ItemKind, ItemStatus
from opesvault.importing.parsers import PARSERS
from opesvault.importing.pipeline import ImportRefused, ImportRequest, import_document
from opesvault.importing.source import SourceError, SourceProblem, load_source
from opesvault.session import Session

from . import synthetic_docs as docs

D = Decimal


def detect(name: str, data: bytes) -> str:
    source = load_source(name, data)
    best = max(PARSERS, key=lambda p: p.detect(source))
    return best.id


@pytest.mark.parametrize(
    ("builder", "name", "parser_id"),
    [
        (docs.nubank_card_pdf, "nu.pdf", "nubank-cartao-pdf"),
        (docs.itau_card_pdf, "itau.pdf", "itau-cartao-pdf"),
        (docs.bradesco_card_pdf, "brad.pdf", "bradesco-cartao-pdf"),
        (docs.itau_bank_pdf, "extrato.pdf", "itau-extrato-pdf"),
        (docs.nubank_account_csv, "nu.csv", "nubank-conta-csv"),
        (docs.nubank_card_csv, "nucard.csv", "nubank-cartao-csv"),
        (docs.ofx_bank, "x.ofx", "ofx-generico"),
        (docs.sinacor_note_pdf, "nota.pdf", "sinacor-nota-pdf"),
    ],
)
def test_layout_detection(builder, name: str, parser_id: str) -> None:  # type: ignore[no-untyped-def]
    assert detect(name, builder()) == parser_id


def _parse(parser_id: str, data: bytes, name: str = "doc.pdf"):  # type: ignore[no-untyped-def]
    from opesvault.importing.parsers import parser_by_id

    return parser_by_id(parser_id).parse(load_source(name, data))


def test_nubank_card_quirks() -> None:
    result = _parse("nubank-cartao-pdf", docs.nubank_card_pdf())
    assert result.header.due_on == date(2026, 1, 10)
    assert result.header.closing_on == date(2026, 1, 3)
    kinds = [(i.kind, i.description, i.amount, i.occurred_on) for i in result.items]
    # Year comes from the header, never from the clock; December belongs to 2025.
    assert (ItemKind.PURCHASE, "Mercado Bom Preço", D("100.00"), date(2025, 12, 5)) in kinds
    assert sum(1 for k in kinds if k[1] == "Mercado Bom Preço") == 2  # equal purchases are both kept
    amazon = next(i for i in result.items if i.description == "Amazon.com")
    assert amazon.amount == D("104.00") and amazon.foreign_amount == D("20.00") and amazon.foreign_currency == "USD"
    assert len(amazon.lines) == 3
    iof = next(i for i in result.items if i.description.startswith("IOF"))
    assert iof.kind is ItemKind.CARD_CHARGE
    installment = next(i for i in result.items if i.installment)
    assert installment.installment == (1, 3) and installment.description == "Loja Eletro"
    assert next(i for i in result.items if i.description == "Pagamento recebido").kind is ItemKind.CARD_PAYMENT
    assert next(i for i in result.items if i.description.startswith("Estorno")).kind is ItemKind.CARD_CREDIT
    assert all(i.description != "Saldo restante" for i in result.items)


def test_itau_card_skips_future_installments_and_reads_iof() -> None:
    result = _parse("itau-cartao-pdf", docs.itau_card_pdf())
    descriptions = [i.description for i in result.items]
    assert descriptions.count("PROQUALITY") == 1
    assert descriptions.count("LOJAS RENNER") == 1
    renner = next(i for i in result.items if i.description == "LOJAS RENNER")
    assert renner.occurred_on == date(2025, 12, 28) and renner.installment == (2, 3)
    assert renner.amount == D("171.70")  # installment number is never part of the value
    assert {i.card_last4 for i in result.items if i.description == "POSTO SHELL"} == {"5678"}
    iof = next(i for i in result.items if i.kind is ItemKind.CARD_CHARGE)
    assert iof.amount == D("30.00") and iof.warnings


def test_bradesco_suffix_sign_and_holders() -> None:
    result = _parse("bradesco-cartao-pdf", docs.bradesco_card_pdf())
    payment = next(i for i in result.items if i.kind is ItemKind.CARD_PAYMENT)
    assert payment.amount == D("500.00")
    assert {i.card_last4 for i in result.items} == {"4321", "8765"}
    assert not any("Total para" in i.description for i in result.items)


def test_itau_bank_statement_balances() -> None:
    result = _parse("itau-extrato-pdf", docs.itau_bank_pdf())
    assert result.header.opening_balance == D("1000.00")
    assert result.header.closing_balance == D("1320.00")
    assert result.header.period_start == date(2026, 1, 1)
    assert [i.kind for i in result.items].count(ItemKind.DEBIT) == 3


def test_ofx_reader() -> None:
    result = _parse("ofx-generico", docs.ofx_bank(), "x.ofx")
    assert [i.bank_id for i in result.items] == ["F001", "F002"]
    assert result.items[0].occurred_on == date(2026, 1, 5)
    assert result.header.closing_balance == D("3500.00")


def test_sinacor_note() -> None:
    from opesvault.importing.parsers.brokerage import note_computed_net

    result = _parse("sinacor-nota-pdf", docs.sinacor_note_pdf())
    trades = [i for i in result.items if i.kind is ItemKind.TRADE]
    assert [t.ticker for t in trades] == ["PETR4", "ITSA4", "VALE3"]
    assert trades[0].quantity == D("100") and trades[0].unit_price == D("30.00")
    assert result.header.net_amount == D("-106.95")
    assert result.header.note_number == "123456"
    assert note_computed_net(result.items) == D("-106.95")


def test_scanned_pdf_is_unsupported() -> None:
    from opesvault.devtools.synthetic_pdf import make_pdf

    with pytest.raises(SourceError) as exc:
        load_source("scan.pdf", make_pdf([]))
    assert exc.value.problem is SourceProblem.NO_TEXT


def test_unknown_format() -> None:
    with pytest.raises(SourceError):
        load_source("x.bin", bytes(range(256)) * 10)


# ── pipeline ─────────────────────────────────────────


@pytest.fixture
def session(tmp_path: Path) -> Session:
    s = Session.new(tmp_path / "f.opesvault", "Teste")
    ledger = s.ledger
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
    return s


def _bank(session: Session):  # type: ignore[no-untyped-def]
    return next(a for a in session.ledger.accounts.values() if a.name == "Itaú CC")


def test_card_import_review_and_approve(session: Session) -> None:
    batch = import_document(session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    assert batch.status is BatchStatus.IN_REVIEW and batch.doc_type is DocType.CARD_STATEMENT
    assert batch.card_id is not None  # the only card was chosen automatically
    assert batch.reconciliations[0].ok is True
    items = pipeline.items_of(session.ledger, batch.id)
    iof = next(i for i in items if i.description.startswith("IOF"))
    assert iof.suggestion_source == "rule"  # never documentary
    result = pipeline.approve(session.ledger, batch.id)
    assert result.created == len(items)
    assert pipeline.batches(session.ledger)[batch.id].status is BatchStatus.APPROVED
    card = next(iter(session.ledger.cards.values()))
    # Card debt: purchases + IOF − refund − payment (previous balance was not in the ledger).
    assert queries.balance(session.ledger, card.liability_account_id) == D("550.30")
    op = next(o for o in session.ledger.operations.values() if o.description == "Amazon.com")
    assert op.origin.evidence_ids and op.notes and "USD 20.00" in op.notes


def test_reimport_same_file_is_refused_ta12(session: Session) -> None:
    import_document(session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    with pytest.raises(ImportRefused):
        import_document(session, ImportRequest("copia.pdf", docs.nubank_card_pdf()))


def test_pending_items_stay_out_of_results_rf07(session: Session) -> None:
    import_document(session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    assert not any(op.origin.kind.value == "import" for op in session.ledger.operations.values())


def test_divergent_total_blocks_approval(session: Session) -> None:
    batch = import_document(session, ImportRequest("nu.pdf", docs.nubank_card_pdf(total="999,99")))
    assert batch.reconciliations[0].ok is False
    with pytest.raises(DomainError):
        pipeline.approve(session.ledger, batch.id)
    pipeline.approve(session.ledger, batch.id, accept_divergence="fatura com encargo não listado")
    assert "Divergência aceita" in pipeline.batches(session.ledger)[batch.id].warnings[-1]


def test_partial_approval_requires_reason(session: Session) -> None:
    batch = import_document(session, ImportRequest("nu.csv", docs.nubank_account_csv(), account_id=_bank(session).id))
    first = pipeline.items_of(session.ledger, batch.id)[0]
    with pytest.raises(DomainError):
        pipeline.approve(session.ledger, batch.id, [first.id])
    pipeline.approve(session.ledger, batch.id, [first.id], partial_reason="restante amanhã")
    assert pipeline.batches(session.ledger)[batch.id].status is BatchStatus.PARTIAL


def test_two_equal_legit_purchases_are_kept_ta14(session: Session) -> None:
    batch = import_document(session, ImportRequest("nu.csv", docs.nubank_account_csv(), account_id=_bank(session).id))
    pipeline.approve(session.ledger, batch.id)
    pharmacy = [o for o in session.ledger.operations.values() if "FARMACIA" in o.description]
    assert len(pharmacy) == 2


def test_overlapping_statements_link_evidence_ta13(session: Session) -> None:
    bank = _bank(session)
    first = import_document(session, ImportRequest("jan.ofx", docs.ofx_bank("A"), account_id=bank.id))
    pipeline.approve(session.ledger, first.id)
    ops_before = len(session.ledger.operations)
    # Same transactions exported again as PDF (different file, no FITID): duplicates by content.
    second = import_document(session, ImportRequest("jan.pdf", docs.itau_bank_pdf(), account_id=bank.id))
    statuses = {i.description: i.status for i in pipeline.items_of(session.ledger, second.id)}
    assert statuses["SALARIO EMPRESA X"] is ItemStatus.DUPLICATE
    pipeline.approve(session.ledger, second.id, accept_divergence=None)
    salary_ops = [o for o in session.ledger.operations.values() if "SALARIO" in o.description]
    assert len(salary_ops) == 1 and len(salary_ops[0].origin.evidence_ids) == 2
    assert len(session.ledger.operations) == ops_before + 3  # aluguel PDF line differs, TED, fatura


def test_same_fitid_is_duplicate(session: Session) -> None:
    bank = _bank(session)
    first = import_document(session, ImportRequest("a.ofx", docs.ofx_bank("Z"), account_id=bank.id))
    pipeline.approve(session.ledger, first.id)
    data = docs.ofx_bank("Z").replace(b"PIX ALUGUEL", b"PIX ALUGUEL REF")
    second = import_document(session, ImportRequest("b.ofx", data, account_id=bank.id))
    assert all(i.status is ItemStatus.DUPLICATE for i in pipeline.items_of(session.ledger, second.id))


def test_bill_payment_seen_in_bank_and_card_is_one_settlement(session: Session) -> None:
    bank = _bank(session)
    card = next(iter(session.ledger.cards.values()))
    # Bank statement first: the user maps the payment line to the card.
    batch = import_document(session, ImportRequest("extrato.pdf", docs.itau_bank_pdf(), account_id=bank.id))
    payment = next(i for i in pipeline.items_of(session.ledger, batch.id) if "FATURA" in i.description)
    pipeline.correct_item(session.ledger, payment.id, "target_account_id", card.liability_account_id, "é a fatura")
    pipeline.approve(session.ledger, batch.id)
    op = session.ledger.operations[pipeline.items(session.ledger)[payment.id].operation_id]  # type: ignore[index]
    assert op.kind is OperationKind.CARD_PAYMENT
    # The card CSV later shows a payment of the same value: linked, not duplicated.
    csv = b"date,title,amount\n2026-01-20,Pagamento recebido,-1680.00\n2026-01-22,Uber *Trip,10.00\n"
    card_batch = import_document(session, ImportRequest("card.csv", csv, card_id=card.id))
    card_items = {i.description: i for i in pipeline.items_of(session.ledger, card_batch.id)}
    assert card_items["Pagamento recebido"].status is ItemStatus.DUPLICATE
    assert card_items["Pagamento recebido"].duplicate_of == op.id


def test_own_transfer_appears_in_both_statements(session: Session) -> None:
    bank = _bank(session)
    savings = next(a for a in session.ledger.accounts.values() if a.name == "Poupança")
    batch = import_document(session, ImportRequest("extrato.pdf", docs.itau_bank_pdf(), account_id=bank.id))
    ted = next(i for i in pipeline.items_of(session.ledger, batch.id) if "TED" in i.description)
    pipeline.correct_item(session.ledger, ted.id, "target_account_id", savings.id, "transferência própria")
    pipeline.approve(session.ledger, batch.id)
    csv = "Data,Valor,Identificador,Descrição\n15/01/2026,500.00,x1,TED recebida\n".encode()
    other = import_document(session, ImportRequest("poup.csv", csv, account_id=savings.id))
    item = pipeline.items_of(session.ledger, other.id)[0]
    assert item.status is ItemStatus.DUPLICATE
    pipeline.approve(session.ledger, other.id)
    assert queries.balance(session.ledger, savings.id) == D("500.00")
    assert queries.income_statement(
        session.ledger, __import__("opesvault.domain.model", fromlist=["YearMonth"]).YearMonth(year=2026, month=1)
    ).income == {next(a.id for a in session.ledger.categories(AccountType.INCOME) if a.name == "Salário"): D("5000.00")}


def test_correction_keeps_previous_value(session: Session) -> None:
    batch = import_document(session, ImportRequest("nu.csv", docs.nubank_account_csv(), account_id=_bank(session).id))
    item = pipeline.items_of(session.ledger, batch.id)[0]
    session.ledger.operator = "Ana"
    fixed = pipeline.correct_item(session.ledger, item.id, "amount", D("1500.01"), "valor no PDF difere")
    assert fixed.corrections[-1].before == "1500.00" and fixed.corrections[-1].after == "1500.01"
    assert fixed.corrections[-1].operator == "Ana"


def test_suggestion_learns_from_history(session: Session) -> None:
    bank = _bank(session)
    housing = next(a for a in session.ledger.categories(AccountType.EXPENSE) if a.name == "Moradia")
    batch = import_document(session, ImportRequest("a.ofx", docs.ofx_bank("H"), account_id=bank.id))
    rent = next(i for i in pipeline.items_of(session.ledger, batch.id) if "ALUGUEL" in i.description)
    pipeline.correct_item(session.ledger, rent.id, "target_account_id", housing.id)
    pipeline.approve(session.ledger, batch.id)
    data = docs.ofx_bank("J").replace(b"20260110", b"20260210").replace(b"20260105", b"20260205")
    again = import_document(session, ImportRequest("b.ofx", data, account_id=bank.id))
    rent2 = next(i for i in pipeline.items_of(session.ledger, again.id) if "ALUGUEL" in i.description)
    assert rent2.target_account_id == housing.id and rent2.suggestion_source == "learned:1/1"


def test_unknown_layout_and_scanned_are_kept_as_pending(session: Session) -> None:
    from opesvault.devtools.synthetic_pdf import make_pdf

    unknown = import_document(
        session, ImportRequest("x.pdf", make_pdf(["Documento qualquer sem layout conhecido 123"]))
    )
    assert unknown.status is BatchStatus.UNSUPPORTED
    scanned = import_document(session, ImportRequest("scan.pdf", make_pdf([])))
    assert scanned.status is BatchStatus.UNSUPPORTED and "OCR" in scanned.warnings[0]
    assert len(session.documents) == 2  # originals are preserved


def test_failure_of_one_file_does_not_affect_others_rf05(session: Session) -> None:
    from opesvault.devtools.synthetic_pdf import make_pdf

    good = import_document(session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    import_document(session, ImportRequest("scan.pdf", make_pdf([])))
    assert pipeline.batches(session.ledger)[good.id].status is BatchStatus.IN_REVIEW


def test_brokerage_note_is_not_approved_as_bank_items(session: Session) -> None:
    batch = import_document(session, ImportRequest("nota.pdf", docs.sinacor_note_pdf()))
    assert batch.doc_type is DocType.BROKERAGE_NOTE and batch.reconciliations[0].ok is True
    with pytest.raises(DomainError):
        pipeline.approve(session.ledger, batch.id)


def test_import_state_survives_save(session: Session, tmp_path: Path) -> None:
    from opesvault.vault import sqlcipher_store as store

    batch = import_document(session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    pipeline.approve(session.ledger, batch.id)
    info = store.save(session.path, "pw", session.full_snapshot(), None)
    _, snapshot = store.load(session.path, "pw")
    reopened = Session.from_snapshot(session.path, info, snapshot)
    assert pipeline.batches(reopened.ledger)[batch.id].status is BatchStatus.APPROVED
    assert len(pipeline.evidence(reopened.ledger)) == len(pipeline.evidence(session.ledger))
    assert reopened.documents[0].data == docs.nubank_card_pdf()
