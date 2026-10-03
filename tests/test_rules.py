from pathlib import Path

import pytest

from opesvault.domain.ledger import DomainError
from opesvault.domain.model import AccountType
from opesvault.importing import pipeline, rules
from opesvault.importing.pipeline import ImportRequest
from opesvault.session import Session

from . import synthetic_docs as docs
from .domain_fixtures import category, family


def session_with_bill(tmp_path: Path):  # type: ignore[no-untyped-def]
    f = family()
    session = Session.new(tmp_path / "x.opesvault")
    session.ledger = f.ledger
    batch = pipeline.import_document(session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    return f, session, batch


def test_suggest_pattern_drops_numbers_and_installments() -> None:
    assert rules.suggest_pattern("Uber *Trip 8812") == "UBER *TRIP"
    assert rules.suggest_pattern("Loja Eletro - Parcela 2/10") == "LOJA ELETRO"
    assert rules.suggest_pattern("Farmácia São João") == "FARMACIA SAO JOAO"
    assert rules.suggest_pattern("LOJA TV (6x)") == "LOJA TV"
    assert rules.suggest_pattern("Curso Online 10X") == "CURSO ONLINE"
    assert rules.suggest_pattern("Posto 24 - 123") == "POSTO"


def test_user_rule_wins_over_builtin_and_history(tmp_path: Path) -> None:
    _, session, batch = session_with_bill(tmp_path)
    ledger = session.ledger
    leisure = category(ledger, "Lazer")
    market = next(i for i in pipeline.items_of(ledger, batch.id) if "Mercado" in i.description)
    assert market.suggestion_source == "rule"  # built-in keyword rule (MERCADO → Alimentação)
    rule = rules.add_rule(ledger, "mercado bom", leisure)
    assert rule.pattern == "MERCADO BOM"
    assert pipeline.apply_rules(ledger, batch.id) == 2  # two "Mercado Bom Preço" lines
    updated = pipeline.items(ledger)[market.id]
    assert updated.target_account_id == leisure and updated.suggestion_source == f"user_rule:{rule.id}"
    assert rules.usage(ledger, rule.id) == 2


def test_manual_choice_is_never_overridden(tmp_path: Path) -> None:
    _, session, batch = session_with_bill(tmp_path)
    ledger = session.ledger
    item = next(i for i in pipeline.items_of(ledger, batch.id) if "Padaria" in i.description)
    health = category(ledger, "Saúde")
    pipeline.correct_item(ledger, item.id, "target_account_id", health)
    rules.add_rule(ledger, "padaria", category(ledger, "Lazer"))
    pipeline.apply_rules(ledger, batch.id)
    assert pipeline.items(ledger)[item.id].target_account_id == health


def test_account_scoped_rule_is_more_specific(tmp_path: Path) -> None:
    f, session, _ = session_with_bill(tmp_path)
    ledger = session.ledger
    general = rules.add_rule(ledger, "amazon", category(ledger, "Lazer"))
    scoped = rules.add_rule(ledger, "amazon", category(ledger, "Educação"), account_id=f.card_account)
    match = rules.match(ledger, "AMAZON.COM", f.card_account, AccountType.EXPENSE)
    assert match is not None and match.id == scoped.id
    other = rules.match(ledger, "AMAZON.COM", f.bank, AccountType.EXPENSE)
    assert other is not None and other.id == general.id
    # An expense rule never categorizes income.
    assert rules.match(ledger, "AMAZON.COM", f.bank, AccountType.INCOME) is None


def test_validation_and_deactivation(tmp_path: Path) -> None:
    f, session, batch = session_with_bill(tmp_path)
    ledger = session.ledger
    with pytest.raises(DomainError):
        rules.add_rule(ledger, "ab", category(ledger, "Lazer"))
    with pytest.raises(DomainError):
        rules.add_rule(ledger, "uber", f.bank)  # not a category
    rule = rules.add_rule(ledger, "padaria", category(ledger, "Lazer"))
    with pytest.raises(DomainError):
        rules.add_rule(ledger, "Padaria", category(ledger, "Saúde"))  # duplicate text
    pipeline.apply_rules(ledger)
    rules.set_active(ledger, rule.id, False, "não era lazer")
    assert pipeline.apply_rules(ledger) >= 1  # its suggestions are withdrawn or replaced
    item = next(i for i in pipeline.items_of(ledger, batch.id) if "Padaria" in i.description)
    assert item.suggestion_source != f"user_rule:{rule.id}"
    assert ledger.history_of(rule.id)[-1].reason == "não era lazer"


def test_rules_survive_a_save_roundtrip(tmp_path: Path) -> None:
    from opesvault.domain.ledger import Ledger

    f = family()
    rule = rules.add_rule(f.ledger, "netflix", category(f.ledger, "Serviços e assinaturas"))
    restored = Ledger.from_records(f.ledger.to_records())
    assert rules.rules(restored)[rule.id] == rule
