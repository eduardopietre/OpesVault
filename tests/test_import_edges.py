"""Edge cases of the import pipeline, the parsers and the local AI suggestions.

Complements test_importing.py and test_ai.py: refusals, partial results, review actions
and the paths a document takes when its layout, target or values are not clear.
"""

import csv
import json
import threading
from datetime import date
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import pytest

from opesvault.ai import ollama as ollama_module
from opesvault.ai.ollama import AiUnavailable, OllamaClient
from opesvault.devtools.synthetic_pdf import make_pdf
from opesvault.domain.ledger import DomainError
from opesvault.domain.model import AccountSubtype, AccountType, Card, LedgerAccount, YearMonth
from opesvault.domain.periods import close_month
from opesvault.domain.settings import update_settings
from opesvault.importing import parsers as parsers_module
from opesvault.importing import pipeline, rules
from opesvault.importing import source as source_module
from opesvault.importing.ai_suggestions import (
    PlannedSuggestion,
    apply_suggestions,
    ask,
    client_from_settings,
    plan_requests,
    release_models,
    remember_used,
    suggest_with_ai,
)
from opesvault.importing.model import BatchStatus, DocFormat, DocType, ExtractedItem, ImportBatch, ItemKind, ItemStatus
from opesvault.importing.parsers import parser_by_id
from opesvault.importing.parsers.base import ParsedItem, Parser, ParseResult, resolve_year, safe_date
from opesvault.importing.parsers.brokerage import note_computed_net
from opesvault.importing.parsers.structured import NubankAccountCsv, NubankCardCsv
from opesvault.importing.pipeline import ImportRequest, ParseFailed, import_document, run_parser
from opesvault.importing.source import Source, SourceError, SourceProblem, load_source
from opesvault.session import Session

from . import synthetic_docs as docs
from .fake_ollama import FakeOllama

D = Decimal


# ── fixtures ─────────────────────────────────────────


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
    liability = ledger.add_account(
        LedgerAccount(name="Cartão A", type=AccountType.LIABILITY, subtype=AccountSubtype.CREDIT_CARD)
    )
    ledger.add_card(
        Card(
            name="Cartão A",
            liability_account_id=liability.id,
            holder_id=ana,
            last4="0001",
            closing_day=3,
            due_day=10,
            settlement_account_id=bank.id,
        )
    )
    return s


def _bank(session: Session) -> LedgerAccount:
    return next(a for a in session.ledger.accounts.values() if a.name == "Itaú CC")


def _add_card(session: Session, name: str, last4: str, settlement: bool = True) -> Card:
    ledger = session.ledger
    liability = ledger.add_account(
        LedgerAccount(name=name, type=AccountType.LIABILITY, subtype=AccountSubtype.CREDIT_CARD)
    )
    return ledger.add_card(
        Card(
            name=name,
            liability_account_id=liability.id,
            holder_id=next(iter(ledger.members)),
            last4=last4,
            closing_day=3,
            due_day=10,
            settlement_account_id=_bank(session).id if settlement else None,
        )
    )


def _csv(*rows: str) -> bytes:
    """A Nubank account CSV with the given 'date,value,id,description' rows."""
    return ("Data,Valor,Identificador,Descrição\n" + "".join(f"{r}\n" for r in rows)).encode()


def _ofx(transactions: str, *, card: bool = False, currency: str = "BRL", balance: str = "-250.00") -> bytes:
    """A minimal OFX 1.x export; `transactions` are raw <STMTTRN> blocks."""
    wrapper = ("CREDITCARDMSGSRSV1", "CCSTMTRS") if card else ("BANKMSGSRSV1", "STMTRS")
    return (
        "OFXHEADER:100\nDATA:OFXSGML\n\n<OFX>\n"
        f"<{wrapper[0]}><{wrapper[1]}>\n<CURDEF>{currency}\n<CCACCTFROM><ACCTID>9999</CCACCTFROM>\n"
        f"<BANKTRANLIST>\n<DTSTART>20260101\n<DTEND>20260131\n{transactions}</BANKTRANLIST>\n"
        f"<LEDGERBAL><BALAMT>{balance}<DTASOF>20260131</LEDGERBAL>\n"
        f"</{wrapper[1]}></{wrapper[0]}>\n</OFX>\n"
    ).encode()


def _trn(amount: str | None, memo: str, posted: str = "20260110") -> str:
    value = f"<TRNAMT>{amount}\n" if amount is not None else ""
    return f"<STMTTRN>\n<DTPOSTED>{posted}\n{value}<FITID>{memo[:6]}\n<MEMO>{memo}\n</STMTTRN>\n"


def _imported_ops(session: Session, batch_id: object) -> list[object]:
    return [op for op in session.ledger.operations.values() if op.origin.import_id == batch_id]


# ── layout choice ────────────────────────────────────


class _EchoCsv(NubankAccountCsv):
    """Reads the Nubank account CSV, under another id, with a fixed confidence."""

    def detect(self, source: Source) -> float:
        return 0.8 if source.format is DocFormat.CSV else 0.0


class _EchoA(_EchoCsv):
    id = "echo-a"


class _EchoB(_EchoCsv):
    id = "echo-b"


def test_ambiguous_layout_waits_for_the_user_and_reparse_resolves_it(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    catalog = (_EchoA(), _EchoB())
    monkeypatch.setattr(pipeline, "PARSERS", catalog)
    monkeypatch.setattr(parsers_module, "PARSERS", catalog)
    batch = import_document(session, ImportRequest("x.csv", docs.nubank_account_csv(), account_id=_bank(session).id))
    assert batch.status is BatchStatus.AMBIGUOUS
    assert set(batch.candidates) == {"echo-a", "echo-b"}
    assert pipeline.items_of(session.ledger, batch.id) == []  # nothing invented before the choice

    resolved = pipeline.reparse_with(session, batch.id, "echo-b")
    assert resolved.status is BatchStatus.IN_REVIEW and resolved.parser_id == "echo-b"
    assert batch.id not in pipeline.batches(session.ledger)  # the ambiguous batch is replaced
    assert len(pipeline.items_of(session.ledger, resolved.id)) == 3
    assert len(session.documents) == 1  # the same original, not a second copy

    with pytest.raises(DomainError, match="Só lotes sem layout"):
        pipeline.reparse_with(session, resolved.id, "echo-a")


def test_a_failed_reparse_keeps_the_old_batch(session: Session) -> None:
    batch = import_document(session, ImportRequest("x.pdf", make_pdf(["Documento qualquer sem layout conhecido 123"])))
    assert batch.status is BatchStatus.UNSUPPORTED
    with pytest.raises(ParseFailed, match="não lê arquivos PDF"):
        pipeline.reparse_with(session, batch.id, "nubank-conta-csv")
    assert pipeline.batches(session.ledger)[batch.id].status is BatchStatus.UNSUPPORTED


def test_forced_layout_of_another_format_is_unsupported_without_items(session: Session) -> None:
    batch = import_document(session, ImportRequest("x.csv", docs.nubank_account_csv(), parser_id="nubank-cartao-pdf"))
    assert batch.status is BatchStatus.UNSUPPORTED
    assert "não lê arquivos CSV" in batch.warnings[0]
    assert batch.candidates == ("nubank-cartao-pdf",)
    assert pipeline.items_of(session.ledger, batch.id) == []
    with pytest.raises(DomainError, match="não pode ser aprovado"):
        pipeline.approve(session.ledger, batch.id)
    assert pipeline.batches(session.ledger)[batch.id].reconciliations == ()  # no document type to reconcile


def test_parser_crash_message_carries_no_document_text() -> None:
    secret = "CPF 123.456.789-00 SALDO 9.999,99"

    class Crashing(NubankAccountCsv):
        id = "crashing"

        def parse(self, source: Source) -> ParseResult:
            raise ValueError(secret)

    source = load_source("x.csv", docs.nubank_account_csv())
    with pytest.raises(ParseFailed) as exc:
        run_parser(Crashing(), source)
    assert "PARSE_FAILED" in str(exc.value) and secret not in str(exc.value)
    assert exc.value.__cause__ is None and exc.value.__suppress_context__  # no traceback chain to log


def test_unknown_parser_id_is_a_key_error() -> None:
    with pytest.raises(KeyError):
        parser_by_id("nao-existe")


def test_parser_contract_methods_must_be_implemented() -> None:
    source = load_source("x.csv", docs.nubank_account_csv())
    with pytest.raises(NotImplementedError):
        Parser().detect(source)
    with pytest.raises(NotImplementedError):
        Parser().parse(source)


# ── target guessing ──────────────────────────────────


def test_bank_statement_finds_its_account_from_the_printed_number(session: Session) -> None:
    batch = import_document(session, ImportRequest("extrato.pdf", docs.itau_bank_pdf()))
    assert batch.account_id == _bank(session).id and batch.card_id is None


def test_card_statement_picks_the_card_by_last_digits(session: Session) -> None:
    other = _add_card(session, "Cartão B", "5678")
    batch = import_document(session, ImportRequest("itau.pdf", docs.itau_card_pdf()))
    assert batch.card_id == other.id and batch.account_id == other.liability_account_id


def test_card_statement_with_several_unknown_cards_stays_without_target(session: Session) -> None:
    _add_card(session, "Cartão B", "4444")
    batch = import_document(session, ImportRequest("itau.pdf", docs.itau_card_pdf()))
    assert batch.card_id is None and batch.account_id is None
    with pytest.raises(DomainError, match="Escolha a conta"):
        pipeline.approve(session.ledger, batch.id)


def test_batch_target_can_change_until_something_is_approved(session: Session) -> None:
    card = next(iter(session.ledger.cards.values()))
    batch = import_document(session, ImportRequest("nucard.csv", docs.nubank_card_csv()))
    moved = pipeline.set_batch_target(session.ledger, batch.id, None, card.id)
    assert moved.card_id == card.id and moved.account_id == card.liability_account_id  # card implies its liability
    pipeline.approve(session.ledger, batch.id)
    with pytest.raises(DomainError, match="não pode mudar de conta"):
        pipeline.set_batch_target(session.ledger, batch.id, _bank(session).id, None)


# ── OFX card statements ──────────────────────────────


def test_ofx_card_statement_signs_and_kinds(session: Session) -> None:
    data = _ofx(
        _trn("-100.00", "MERCADO X")
        + _trn("-3.50", "IOF COMPRA EXTERIOR")
        + _trn("300.00", "PAGAMENTO RECEBIDO")
        + _trn("20.00", "ESTORNO LOJA")
        + _trn(None, "SEM VALOR")
        + _trn("-5.00", "DATA RUIM", posted="20261340"),
        card=True,
        currency="USD",
    )
    result = parser_by_id("ofx-generico").parse(load_source("c.ofx", data))
    kinds = {i.description: i.kind for i in result.items}
    assert kinds["MERCADO X"] is ItemKind.PURCHASE
    assert kinds["IOF COMPRA EXTERIOR"] is ItemKind.CARD_CHARGE
    assert kinds["PAGAMENTO RECEBIDO"] is ItemKind.CARD_PAYMENT
    assert kinds["ESTORNO LOJA"] is ItemKind.CARD_CREDIT
    missing = next(i for i in result.items if i.description == "SEM VALOR")
    assert missing.amount is None and missing.warnings == ["Valor ausente ou inválido."]
    bad_date = next(i for i in result.items if i.description == "DATA RUIM")
    assert bad_date.occurred_on is None and bad_date.warnings == ["Data ausente ou inválida."]
    assert result.header.closing_balance == D("250.00")  # a card balance is debt: sign flipped
    assert result.warnings == ["Moeda USD exige câmbio informado."]

    batch = import_document(session, ImportRequest("c.ofx", data))
    assert batch.doc_type is DocType.CARD_STATEMENT  # the OFX itself says it is a card
    assert batch.card_id is not None  # the only card
    unknown = next(i for i in pipeline.items_of(session.ledger, batch.id) if i.description == "SEM VALOR")
    assert unknown.status is ItemStatus.NEEDS_REVIEW
    assert pipeline.item_problems(unknown) == ["valor desconhecido"]
    with pytest.raises(DomainError, match="precisam de revisão"):
        pipeline.approve(session.ledger, batch.id, accept_divergence="teste")
    assert _imported_ops(session, batch.id) == []


# ── review actions ───────────────────────────────────


def test_corrections_are_refused_for_locked_fields_and_approved_items(session: Session) -> None:
    batch = import_document(session, ImportRequest("nu.csv", docs.nubank_account_csv(), account_id=_bank(session).id))
    item = pipeline.items_of(session.ledger, batch.id)[0]
    with pytest.raises(DomainError, match="Campo não editável"):
        pipeline.correct_item(session.ledger, item.id, "bank_id", "forjado")
    pipeline.approve(session.ledger, batch.id)
    with pytest.raises(DomainError, match="já aprovado"):
        pipeline.correct_item(session.ledger, item.id, "amount", D("1"))
    with pytest.raises(DomainError, match="não pode ser rejeitado"):
        pipeline.reject_items(session.ledger, [item.id], "tarde demais")


def test_zero_amount_blocks_approval(session: Session) -> None:
    batch = import_document(session, ImportRequest("nu.csv", docs.nubank_account_csv(), account_id=_bank(session).id))
    item = pipeline.items_of(session.ledger, batch.id)[0]
    fixed = pipeline.correct_item(session.ledger, item.id, "amount", D("0"), "teste")
    assert fixed.status is ItemStatus.NEEDS_REVIEW and pipeline.item_problems(fixed) == ["valor não positivo"]
    with pytest.raises(DomainError, match="1 item"):
        pipeline.approve(session.ledger, batch.id)
    assert _imported_ops(session, batch.id) == []


def _salary_marked_duplicate(session: Session) -> tuple[ImportBatch, ExtractedItem]:
    bank = _bank(session)
    first = import_document(session, ImportRequest("a.ofx", docs.ofx_bank("A"), account_id=bank.id))
    pipeline.approve(session.ledger, first.id)
    second = import_document(session, ImportRequest("b.pdf", docs.itau_bank_pdf(), account_id=bank.id))
    salary = next(i for i in pipeline.items_of(session.ledger, second.id) if "SALARIO" in i.description)
    assert salary.status is ItemStatus.DUPLICATE
    return second, salary


def test_correcting_a_duplicate_takes_it_out_of_the_duplicates(session: Session) -> None:
    _, salary = _salary_marked_duplicate(session)
    # Changing only the category keeps it a duplicate: the fact is still the same.
    category = next(a for a in session.ledger.categories(AccountType.INCOME) if a.name == "Salário")
    kept = pipeline.correct_item(session.ledger, salary.id, "target_account_id", category.id)
    assert kept.status is ItemStatus.DUPLICATE and kept.suggestion_source is None
    fixed = pipeline.correct_item(session.ledger, salary.id, "amount", D("5000.01"), "valor diferente")
    assert fixed.status is ItemStatus.READY and fixed.duplicate_of is None


def test_keep_separate_clears_the_duplicate_mark(session: Session) -> None:
    second, salary = _salary_marked_duplicate(session)
    other = next(i for i in pipeline.items_of(session.ledger, second.id) if "TED" in i.description)
    pipeline.keep_separate(session.ledger, other.id, "não é duplicata")  # not a duplicate: no-op
    assert pipeline.items(session.ledger)[other.id] == other
    pipeline.keep_separate(session.ledger, salary.id, "dois salários no mesmo dia")
    separate = pipeline.items(session.ledger)[salary.id]
    assert separate.status is ItemStatus.READY and separate.duplicate_of is None


def test_keep_separate_survives_approval(session: Session) -> None:
    second, salary = _salary_marked_duplicate(session)
    pipeline.keep_separate(session.ledger, salary.id, "dois salários no mesmo dia")
    pipeline.refresh_batch(session.ledger, second.id)  # e.g. after another correction in the batch
    kept = pipeline.items(session.ledger)[salary.id]
    assert kept.status is ItemStatus.READY
    assert kept.corrections[-1].reason == "dois salários no mesmo dia"  # the decision is on the record
    pipeline.approve(session.ledger, second.id)
    salaries = [o for o in session.ledger.operations.values() if "SALARIO" in o.description]
    assert len(salaries) == 2


def test_rejecting_every_item_rejects_the_batch(session: Session) -> None:
    batch = import_document(session, ImportRequest("nu.csv", docs.nubank_account_csv(), account_id=_bank(session).id))
    pipeline.reject_items(session.ledger, [], "nada")  # no-op
    assert pipeline.batches(session.ledger)[batch.id].status is BatchStatus.IN_REVIEW
    ids = [i.id for i in pipeline.items_of(session.ledger, batch.id)]
    pipeline.reject_items(session.ledger, ids, "extrato errado")
    assert pipeline.batches(session.ledger)[batch.id].status is BatchStatus.REJECTED
    with pytest.raises(DomainError, match="não pode ser aprovado"):
        pipeline.approve(session.ledger, batch.id)


def test_apply_rules_respects_batch_filter_and_approved_items(session: Session) -> None:
    bank = _bank(session)
    health = next(a for a in session.ledger.categories(AccountType.EXPENSE) if a.name == "Saúde")
    approved = import_document(session, ImportRequest("a.csv", docs.nubank_account_csv(), account_id=bank.id))
    pipeline.approve(session.ledger, approved.id)
    data = docs.nubank_account_csv().replace(b"a1b2", b"z9y8").replace(b"/02/", b"/03/")
    pending = import_document(session, ImportRequest("b.csv", data, account_id=bank.id))
    other = import_document(session, ImportRequest("c.csv", data.replace(b"z9y8", b"q7w6"), account_id=bank.id))

    rule = rules.add_rule(session.ledger, "FARMACIA SAO JOAO", health.id)
    assert pipeline.apply_rules(session.ledger, pending.id) == 2  # the two pharmacy lines of this batch only
    source = f"user_rule:{rule.id}"
    assert [i.suggestion_source for i in pipeline.items_of(session.ledger, pending.id)].count(source) == 2
    assert source not in {i.suggestion_source for i in pipeline.items_of(session.ledger, other.id)}
    assert source not in {i.suggestion_source for i in pipeline.items_of(session.ledger, approved.id)}
    assert rules.usage(session.ledger, rule.id) == 2


# ── approval refusals ────────────────────────────────


def test_card_payment_without_paying_account_blocks_the_whole_approval(session: Session) -> None:
    card = _add_card(session, "Cartão sem conta", "7777", settlement=False)
    batch = import_document(session, ImportRequest("nucard.csv", docs.nubank_card_csv(), card_id=card.id))
    with pytest.raises(DomainError, match="conta que pagou"):
        pipeline.approve(session.ledger, batch.id)
    # Blocking problems stop everything (docs/05 §7): no item of the batch became an operation.
    assert _imported_ops(session, batch.id) == []
    assert all(i.status is not ItemStatus.APPROVED for i in pipeline.items_of(session.ledger, batch.id))


def test_item_kind_that_bank_statements_cannot_hold_is_refused(session: Session) -> None:
    batch = import_document(session, ImportRequest("nu.csv", docs.nubank_account_csv(), account_id=_bank(session).id))
    item = pipeline.items_of(session.ledger, batch.id)[-1]
    pipeline.correct_item(session.ledger, item.id, "kind", ItemKind.TRADE, "teste")
    with pytest.raises(DomainError, match="não aprovável"):
        pipeline.approve(session.ledger, batch.id)
    assert _imported_ops(session, batch.id) == []


def test_closed_month_blocks_the_whole_approval(session: Session) -> None:
    data = _csv("20/01/2026,-10.00,j1,Compra XKCD", "05/02/2026,-20.00,f1,Compra ZWQ")
    batch = import_document(session, ImportRequest("a.csv", data, account_id=_bank(session).id))
    close_month(session.ledger, YearMonth(year=2026, month=2), pending_note="teste")
    with pytest.raises(DomainError, match="fechado"):
        pipeline.approve(session.ledger, batch.id)
    assert _imported_ops(session, batch.id) == []  # the January line was not approved alone
    assert pipeline.batches(session.ledger)[batch.id].status is BatchStatus.IN_REVIEW


def test_missing_default_category_is_created_on_approval(session: Session) -> None:
    ledger = session.ledger
    others = next(a for a in ledger.categories(AccountType.EXPENSE) if a.name == "Outras despesas")
    ledger.update_account(others.model_copy(update={"archived": True}), "teste")
    batch = import_document(
        session, ImportRequest("nu.csv", _csv("03/02/2026,-89.90,a1,Compra XKCD QWZ"), account_id=_bank(session).id)
    )
    (item,) = pipeline.items_of(ledger, batch.id)
    assert item.target_account_id is None  # nothing to suggest from
    pipeline.approve(ledger, batch.id)
    created = [a for a in ledger.categories(AccountType.EXPENSE) if a.name == "Outras despesas"]
    assert len(created) == 1 and created[0].id != others.id  # never posts to an archived category
    operation_id = pipeline.items(ledger)[item.id].operation_id
    assert operation_id is not None
    assert {p.account_id for p in ledger.operations[operation_id].postings} == {_bank(session).id, created[0].id}


# ── parser edges ─────────────────────────────────────


def test_itau_bank_statement_edge_lines() -> None:
    data = make_pdf(
        [
            "Itaú Unibanco - Extrato de conta corrente",
            "Período: 01/01/2026 a 31/01/2026",
            "01/01/2026 SALDO ANTERIOR 1.000,00",
            "05/01/2026 PIX RECEBIDO 200,00 1.200,00",
            "31/02/2026 DATA IMPOSSIVEL -10,00",
            "07/01/2026 VALOR ESTRANHO --5,00",
        ]
    )
    result = parser_by_id("itau-extrato-pdf").parse(load_source("e.pdf", data))
    assert result.header.opening_balance == D("1000.00")  # dated "SALDO ANTERIOR" line
    assert result.header.closing_balance == D("1200.00")  # balance column next to the value
    pix = next(i for i in result.items if "PIX" in i.description)
    assert pix.amount == D("200.00") and pix.kind is ItemKind.CREDIT
    impossible = next(i for i in result.items if "IMPOSSIVEL" in i.description)
    assert impossible.occurred_on is None and impossible.warnings == ["Data impossível no documento."]
    assert [line.text for line in result.unmapped] == ["07/01/2026 VALOR ESTRANHO --5,00"]
    assert result.header.account_hint is None


def test_nubank_card_csv_edges() -> None:
    data = b"date,title,amount\n2026-02-03,Uber,10.00\n03/02/2026,Data BR,5.00\n2026-02-04,Zero,0\nso uma coluna\n"
    result = NubankCardCsv().parse(load_source("c.csv", data))
    assert [i.description for i in result.items] == ["Uber", "Data BR"]
    assert result.items[1].occurred_on is None and result.items[1].warnings == ["Data inválida."]
    assert len(result.unmapped) == 2  # zero value and the short row
    assert NubankCardCsv().detect(Source(name="vazio.csv", format=DocFormat.CSV)) == 0.0


def test_nubank_account_csv_short_and_unreadable_rows_are_unmapped() -> None:
    result = NubankAccountCsv().parse(load_source("a.csv", _csv("01/02/2026,10.00", '01/02/2026,"1,50",x,Vírgula')))
    assert result.items == [] and len(result.unmapped) == 2  # never a guessed value


def _note(net_line: str) -> bytes:
    """The synthetic SINACOR note with another 'Líquido para' line."""
    return make_pdf(
        [
            "NOTA DE NEGOCIAÇÃO",
            "Nr. nota Folha Data pregão",
            "123456 1 02/03/2026",
            "CORRETORA FICTICIA - CLEAR",
            "1-BOVESPA C VISTA PETROBRAS PN N2 PETR4 100 30,00 3.000,00 D",
            "Resumo dos Negócios Resumo Financeiro",
            "Taxa de liquidação 1,65 D",
            "I.R.R.F. s/ operações, base R$3.000,00 0,15",
            net_line,
        ]
    )


def test_note_net_that_discounts_withheld_tax_gets_an_irrf_line() -> None:
    result = parser_by_id("sinacor-nota-pdf").parse(load_source("n.pdf", _note("Líquido para 04/03/2026 3.001,80 D")))
    irrf = [i for i in result.items if i.description == "IRRF retido"]
    assert len(irrf) == 1 and irrf[0].amount == D("0.15") and irrf[0].kind is ItemKind.FEE
    assert result.warnings == ["O líquido da nota desconta o IRRF retido."]
    assert note_computed_net(result.items) == result.header.net_amount == D("-3001.80")


def test_note_net_without_debit_credit_marker_keeps_the_printed_sign() -> None:
    result = parser_by_id("sinacor-nota-pdf").parse(load_source("n.pdf", _note("Líquido para 04/03/2026 3.001,65")))
    assert result.header.net_amount == D("3001.65")  # no D/C marker: taken as printed
    assert "não descontado" in result.warnings[0]


def test_note_net_ignores_items_of_unknown_value() -> None:
    items = [
        ParsedItem(kind=ItemKind.TRADE, occurred_on=None, description="Venda X", amount=None, lines=[]),
        ParsedItem(kind=ItemKind.FEE, occurred_on=None, description="Taxa", amount=D("1.00"), lines=[], credit=True),
        ParsedItem(kind=ItemKind.DEBIT, occurred_on=None, description="Outro", amount=D("9.00"), lines=[]),
    ]
    assert note_computed_net(items) == D("1.00")  # unknown value is not zero, it is left out


def test_impossible_printed_dates_are_unknown() -> None:

    assert safe_date(2026, 2, 30) is None
    assert resolve_year(29, 2, date(2026, 1, 10)) is None  # neither 2026 nor 2025 has 29/02
    assert resolve_year(28, 12, date(2026, 1, 10)) == date(2025, 12, 28)


# ── sources ──────────────────────────────────────────


def test_source_limits_are_classified(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(source_module, "MAX_PAGES", 1)
    with pytest.raises(SourceError) as pages:
        load_source("itau.pdf", docs.itau_card_pdf())  # two pages
    assert pages.value.problem is SourceProblem.TOO_MANY_PAGES

    monkeypatch.setattr(source_module, "MAX_DOCUMENT_BYTES", 10)
    with pytest.raises(SourceError) as large:
        load_source("x.csv", docs.nubank_account_csv())
    assert large.value.problem is SourceProblem.TOO_LARGE


def test_csv_with_a_huge_field_is_invalid_not_a_crash() -> None:

    data = b"a,b\n1," + b"x" * (csv.field_size_limit() + 10) + b"\n"
    with pytest.raises(SourceError) as exc:
        load_source("big.csv", data)
    assert exc.value.problem is SourceProblem.INVALID


def test_unreadable_document_is_kept_as_unsupported(session: Session) -> None:
    data = b"%PDF-1.4\n" + bytes(range(256)) * 4
    batch = import_document(session, ImportRequest("quebrado.pdf", data))
    assert batch.status is BatchStatus.UNSUPPORTED and batch.doc_format is DocFormat.PDF
    assert batch.warnings == ("Arquivo corrompido ou inválido.",)
    assert session.document(batch.document_id).data == data  # the original is preserved


# ── category rules ───────────────────────────────────


def test_rule_validation_refusals(session: Session) -> None:
    ledger = session.ledger
    health = next(a for a in ledger.categories(AccountType.EXPENSE) if a.name == "Saúde")
    with pytest.raises(DomainError, match="Conta da regra inexistente"):
        rules.add_rule(ledger, "FARMACIA", health.id, account_id=uuid4())
    with pytest.raises(DomainError, match="Escolha uma categoria"):
        rules.add_rule(ledger, "FARMACIA", _bank(session).id)
    rule = rules.add_rule(ledger, "farmácia", health.id)
    assert rule.pattern == "FARMACIA"  # stored normalized
    with pytest.raises(DomainError, match="Já existe"):
        rules.add_rule(ledger, "FARMACIA", health.id)
    with pytest.raises(DomainError, match="ao menos"):
        rules.update_rule(ledger, rule.model_copy(update={"pattern": "ab"}), "curto")
    with pytest.raises(DomainError, match="Regra inexistente"):
        rules.update_rule(ledger, rule.model_copy(update={"id": uuid4()}), "outra")
    with pytest.raises(DomainError, match="Regra inexistente"):
        rules.set_active(ledger, uuid4(), False, "outra")


def test_inactive_rule_may_repeat_an_active_pattern(session: Session) -> None:
    ledger = session.ledger
    health = next(a for a in ledger.categories(AccountType.EXPENSE) if a.name == "Saúde")
    first = rules.add_rule(ledger, "FARMACIA", health.id)
    rules.set_active(ledger, first.id, False, "trocando")
    second = rules.add_rule(ledger, "FARMACIA", health.id)
    with pytest.raises(DomainError, match="Já existe"):
        rules.set_active(ledger, first.id, True, "duas iguais")
    assert rules.rules(ledger)[first.id].version == 2 and rules.rules(ledger)[second.id].active


def test_most_specific_rule_wins_regardless_of_order(session: Session) -> None:
    ledger = session.ledger
    expense = {a.name: a for a in ledger.categories(AccountType.EXPENSE)}
    long_rule = rules.add_rule(ledger, "FARMACIA SAO JOAO", expense["Saúde"].id)
    rules.add_rule(ledger, "FARMACIA", expense["Alimentação"].id)
    found = rules.match(ledger, "Compra FARMACIA SAO JOAO 12", None, AccountType.EXPENSE)
    assert found is not None and found.id == long_rule.id
    assert rules.match(ledger, "FARMACIA SAO JOAO", None, AccountType.INCOME) is None  # wrong kind


# ── local AI suggestions ─────────────────────────────


def _ai_session(tmp_path: Path, *descriptions: str, income: str | None = None) -> tuple[Session, ImportBatch]:
    session = Session.new(tmp_path / "ai.opesvault")
    bank = session.ledger.add_account(
        LedgerAccount(name="Banco", type=AccountType.ASSET, subtype=AccountSubtype.CHECKING)
    )
    rows = [f"0{n + 1}/02/2026,-1{n}.00,s{n},Compra {d}" for n, d in enumerate(descriptions)]
    if income:
        rows.append(f"09/02/2026,100.00,i1,{income}")
    return session, import_document(session, ImportRequest("x.csv", _csv(*rows), account_id=bank.id))


def test_ai_client_comes_only_from_enabled_settings(tmp_path: Path) -> None:
    session, batch = _ai_session(tmp_path, "XKCD")
    assert client_from_settings(session.ledger) is None
    assert suggest_with_ai(session.ledger, batch.id) == 0  # off: nothing is asked
    update_settings(session.ledger, ai_enabled=True)
    assert client_from_settings(session.ledger) is None  # on, but no model chosen
    update_settings(session.ledger, ai_model="gemma4:12b")
    client = client_from_settings(session.ledger)
    assert client is not None and client.model == "gemma4:12b"


def test_ai_cancel_before_asking_sends_nothing(ollama: str, tmp_path: Path) -> None:

    session, batch = _ai_session(tmp_path, "XKCD", "QWZ", income="Recebido de ALGUEM")
    requests = plan_requests(session.ledger, batch.id)
    assert len(requests) == 2  # spending and income are separate requests
    cancel = threading.Event()
    cancel.set()
    outcome = ask(OllamaClient("m", ollama), requests, cancel=cancel)
    assert outcome.cancelled and outcome.planned == []
    assert outcome.asked == outcome.failed == 3
    assert FakeOllama.received == []


def test_ai_keeps_what_was_answered_when_a_later_request_fails(ollama: str, tmp_path: Path) -> None:

    session, batch = _ai_session(tmp_path, "XKCD", income="Recebido de ALGUEM")
    requests = plan_requests(session.ledger, batch.id)
    good = json.dumps({"suggestions": [{"index": 0, "category": "Lazer"}]})
    FakeOllama.answers = [good, "lixo", "lixo de novo"]  # the income request fails twice
    outcome = ask(OllamaClient("m", ollama), requests)
    assert len(outcome.planned) == 1 and outcome.failed == 1 and not outcome.cancelled
    spending = next(i for i in pipeline.items_of(session.ledger, batch.id) if i.kind is ItemKind.DEBIT)
    assert outcome.planned[0].item_id == spending.id
    assert apply_suggestions(session.ledger, outcome.planned) == 1
    assert pipeline.items(session.ledger)[spending.id].suggestion_source == "ollama:m:p3"


def test_ai_that_cannot_answer_anything_raises(ollama: str, tmp_path: Path) -> None:

    session, batch = _ai_session(tmp_path, "XKCD")
    FakeOllama.missing_model = True
    with pytest.raises(AiUnavailable) as exc:
        ask(OllamaClient("m", ollama), plan_requests(session.ledger, batch.id))
    assert exc.value.fatal


def test_ai_suggestion_never_overrides_a_choice_made_meanwhile(tmp_path: Path) -> None:

    session, batch = _ai_session(tmp_path, "XKCD", "QWZ")
    ledger = session.ledger
    leisure = next(a for a in ledger.categories(AccountType.EXPENSE) if a.name == "Lazer")
    chosen, rejected = pipeline.items_of(ledger, batch.id)
    pipeline.correct_item(ledger, chosen.id, "target_account_id", leisure.id)
    pipeline.reject_items(ledger, [rejected.id], "não é nosso")
    planned = [
        PlannedSuggestion(chosen.id, uuid4(), "ollama:m:p3"),
        PlannedSuggestion(rejected.id, leisure.id, "ollama:m:p3"),
        PlannedSuggestion(uuid4(), leisure.id, "ollama:m:p3"),  # item removed meanwhile
    ]
    assert apply_suggestions(ledger, planned) == 0
    assert pipeline.items(ledger)[chosen.id].target_account_id == leisure.id


def test_ai_examples_skip_variants_of_what_is_asked(tmp_path: Path) -> None:
    session, first = _ai_session(tmp_path, "XKCD LOJA 01", "PADOCA DO ZE")
    ledger = session.ledger
    leisure = next(a for a in ledger.categories(AccountType.EXPENSE) if a.name == "Lazer")
    for item in pipeline.items_of(ledger, first.id):
        pipeline.correct_item(ledger, item.id, "target_account_id", leisure.id)
    pipeline.approve(ledger, first.id)
    bank = next(a for a in ledger.accounts.values() if a.name == "Banco")
    data = _csv("01/03/2026,-5.00,t1,Compra XKCD LOJA 02")
    second = import_document(session, ImportRequest("y.csv", data, account_id=bank.id))
    (request,) = plan_requests(ledger, second.id)
    assert request.descriptions == ("Compra XKCD LOJA 02",)
    # "XKCD LOJA 01" differs only in numbers: it is the same question, not an example of the criteria.
    assert request.examples == (("Compra PADOCA DO ZE", "Lazer"),)


def test_release_models_unloads_from_the_server_that_was_used(ollama: str) -> None:

    release_models(wait=True)  # nothing remembered: nothing sent
    assert FakeOllama.received == []
    remember_used(OllamaClient("gemma4:12b", ollama))
    remember_used(OllamaClient("gemma4:12b", ollama))
    release_models(wait=True)
    assert FakeOllama.received == [{"model": "gemma4:12b", "keep_alive": 0}]
    release_models(wait=True)  # already released
    assert len(FakeOllama.received) == 1


# ── Ollama client failures ───────────────────────────


def test_unreadable_ollama_answer_is_retried_then_unavailable(ollama: str) -> None:

    FakeOllama.chat_body = b"<html>not json</html>"
    with pytest.raises(AiUnavailable, match="ilegível") as exc:
        OllamaClient("m", ollama).suggest_categories(["XKCD"], ["Lazer"])
    assert not exc.value.fatal and len(FakeOllama.received) == 2


def test_ollama_answer_without_content_is_unavailable(ollama: str) -> None:

    FakeOllama.chat_body = b'{"message": {"role": "assistant"}}'
    with pytest.raises(AiUnavailable, match="sem conteúdo"):
        OllamaClient("m", ollama).suggest_categories(["XKCD"], ["Lazer"])


def test_ollama_http_error_is_reported_by_code_only(ollama: str) -> None:

    FakeOllama.chat_status = 500
    with pytest.raises(AiUnavailable) as exc:
        OllamaClient("m", ollama).suggest_categories(["XKCD"], ["Lazer"])
    assert str(exc.value) == "Ollama recusou o pedido (500)."  # no server detail in the message


def test_slow_ollama_counts_as_off(ollama: str, monkeypatch: pytest.MonkeyPatch) -> None:

    monkeypatch.setattr(ollama_module, "INFO_TIMEOUT_S", 0.2)
    FakeOllama.get_delay = 0.6
    with pytest.raises(AiUnavailable, match="demorou") as exc:
        OllamaClient("m", ollama).server_info()
    assert exc.value.fatal


def test_nothing_to_classify_sends_nothing(ollama: str) -> None:

    client = OllamaClient("m", ollama)
    assert client.suggest_categories([], ["Lazer"]).suggestions == []
    assert client.suggest_categories(["XKCD"], []).suggestions == []
    assert FakeOllama.received == []
