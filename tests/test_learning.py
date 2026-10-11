"""Categories learned from use (importing/learning.py): suggestions, rule proposals and contradictions."""

from datetime import date
from pathlib import Path
from uuid import UUID

import pytest

from opesvault.domain.edits import reclassify
from opesvault.domain.model import AccountType, Operation
from opesvault.importing import learning, rules

from .domain_fixtures import Family, category, family


@pytest.fixture
def f() -> Family:
    return family()


def _spend(f: Family, name: str, description: str, day: int, account: UUID | None = None) -> Operation:
    return f.ledger.record_expense(
        account or f.bank, category(f.ledger, name), "42.00", date(2026, 3, day), description
    )


def test_the_merchant_key_drops_what_changes_between_purchases() -> None:
    assert learning.merchant_key("Uber *Trip 8812 PARCELA 2/3") == "UBER *TRIP"
    assert learning.merchant_key("Padaria São João 03/10") == "PADARIA SAO JOAO"


def test_a_choice_made_twice_is_suggested_for_the_next_purchase(f: Family) -> None:
    _spend(f, "Transporte", "UBER *TRIP 1234", 1)
    _spend(f, "Transporte", "UBER *TRIP 5678", 2)
    found = learning.suggest(f.ledger, "Uber *Trip 9999", AccountType.EXPENSE)
    assert found is not None and found.category_id == category(f.ledger, "Transporte")
    assert (found.agreeing, found.considered, found.source) == (2, 2, "learned:2/2")
    assert learning.suggest(f.ledger, "UBER *TRIP", AccountType.INCOME) is None  # an expense teaches no income


def test_the_family_changing_its_mind_is_followed(f: Family) -> None:
    for day in (1, 2, 3):
        _spend(f, "Alimentação", "FEIRA DO BAIRRO", day)
    for day in (4, 5):
        _spend(f, "Lazer", "FEIRA DO BAIRRO", day)
    found = learning.suggest(f.ledger, "FEIRA DO BAIRRO", AccountType.EXPENSE)
    assert found is not None and found.category_id == category(f.ledger, "Alimentação")  # 3 of the last 5
    _spend(f, "Lazer", "FEIRA DO BAIRRO", 6)
    found = learning.suggest(f.ledger, "FEIRA DO BAIRRO", AccountType.EXPENSE)
    assert found is not None and found.category_id == category(f.ledger, "Lazer")  # now 3 of the last 5
    assert found.source == "learned:3/5"


def test_a_tie_goes_to_the_newest_choice(f: Family) -> None:
    _spend(f, "Alimentação", "LOJA CENTRAL", 1)
    _spend(f, "Lazer", "LOJA CENTRAL", 2)
    found = learning.suggest(f.ledger, "LOJA CENTRAL", AccountType.EXPENSE)
    assert found is not None and found.category_id == category(f.ledger, "Lazer")


def test_a_later_reclassification_is_what_is_learned(f: Family) -> None:
    op = _spend(f, "Alimentação", "CASA DO PAO", 1)
    leisure = category(f.ledger, "Lazer")
    reclassify(f.ledger, [op.id], leisure, "era um presente")
    found = learning.suggest(f.ledger, "CASA DO PAO", AccountType.EXPENSE)
    assert found is not None and found.category_id == leisure


def test_choices_made_on_the_same_account_come_first(f: Family) -> None:
    _spend(f, "Alimentação", "MERCADINHO", 1, f.bank)
    _spend(f, "Alimentação", "MERCADINHO", 2, f.bank)
    _spend(f, "Lazer", "MERCADINHO", 3, f.joint)
    on_joint = learning.suggest(f.ledger, "MERCADINHO", AccountType.EXPENSE, f.joint)
    on_bank = learning.suggest(f.ledger, "MERCADINHO", AccountType.EXPENSE, f.bank)
    anywhere = learning.suggest(f.ledger, "MERCADINHO", AccountType.EXPENSE, f.savings)
    assert on_joint is not None and on_joint.category_id == category(f.ledger, "Lazer")
    assert on_bank is not None and on_bank.category_id == category(f.ledger, "Alimentação")
    assert anywhere is not None and anywhere.category_id == category(f.ledger, "Alimentação")  # all choices


def test_a_longer_description_starting_with_a_learned_one_is_recognized(f: Family) -> None:
    _spend(f, "Serviços e assinaturas", "NETFLIX.COM", 1)
    found = learning.suggest(f.ledger, "NETFLIX.COM SAO PAULO BR", AccountType.EXPENSE)
    assert found is not None and found.category_id == category(f.ledger, "Serviços e assinaturas")
    assert learning.suggest(f.ledger, "NETFLIXCOMPRAS", AccountType.EXPENSE) is None  # not on a word boundary


def test_generic_and_split_operations_teach_nothing(f: Family) -> None:
    _spend(f, "Lazer", "PIX 123456", 1)  # key "PIX" is too short to mean a merchant
    assert learning.suggest(f.ledger, "PIX 999", AccountType.EXPENSE) is None
    f.ledger.record_transfer(f.bank, f.savings, "100.00", date(2026, 3, 2), "RESERVA MENSAL")
    assert learning.suggest(f.ledger, "RESERVA MENSAL", AccountType.EXPENSE) is None


def test_a_purchase_in_installments_is_one_choice(f: Family) -> None:
    from opesvault.domain.cards import record_installment_purchase

    record_installment_purchase(f.ledger, f.card, category(f.ledger, "Lazer"), "600.00", date(2026, 1, 5), "LOJA TV", 6)
    found = learning.suggest(f.ledger, "LOJA TV", AccountType.EXPENSE)
    assert found is not None and (found.agreeing, found.considered) == (1, 1)


def test_cancelled_operations_and_archived_categories_are_forgotten(f: Family) -> None:
    op = _spend(f, "Lazer", "CINEMA CENTRAL", 1)
    f.ledger.cancel_operation(op.id, "lançado em dobro")
    assert learning.suggest(f.ledger, "CINEMA CENTRAL", AccountType.EXPENSE) is None


def test_repeated_choices_are_offered_as_a_rule(f: Family) -> None:
    for day in (1, 2, 3):
        _spend(f, "Transporte", f"POSTO IPIRANGA {day}", day)
    _spend(f, "Lazer", "BOLICHE", 4)
    found = learning.proposals(f.ledger)
    assert [(p.pattern, p.category_id, p.count) for p in found] == [
        ("POSTO IPIRANGA", category(f.ledger, "Transporte"), 3)
    ]
    rules.add_rule(f.ledger, "POSTO IPIRANGA", category(f.ledger, "Transporte"))
    assert learning.proposals(f.ledger) == []  # the rule already says so


def test_choices_that_disagree_are_not_offered_as_a_rule(f: Family) -> None:
    for day, name in ((1, "Transporte"), (2, "Transporte"), (3, "Lazer")):
        _spend(f, name, "AUTO POSTO", day)
    assert learning.proposals(f.ledger) == []


def test_a_rule_the_family_keeps_overriding_is_reported(f: Family) -> None:
    rule = rules.add_rule(f.ledger, "PADARIA", category(f.ledger, "Alimentação"))
    _spend(f, "Alimentação", "PADARIA REAL", 1)
    assert learning.contradictions(f.ledger) == {}
    _spend(f, "Lazer", "PADARIA REAL CAFE", 2)
    _spend(f, "Lazer", "PADARIA REAL CAFE", 3)
    found = learning.contradictions(f.ledger)
    assert set(found) == {rule.id}
    assert (found[rule.id].matched, found[rule.id].contrary) == (3, 2)
    assert found[rule.id].usual_category_id == category(f.ledger, "Lazer")


def test_learning_is_recomputed_only_when_operations_or_accounts_change(f: Family) -> None:
    _spend(f, "Lazer", "TEATRO MUNICIPAL", 1)
    first = learning.knowledge(f.ledger)
    f.ledger.add_member("Carla")  # a member is not an operation or an account
    assert learning.knowledge(f.ledger) is first
    _spend(f, "Lazer", "TEATRO MUNICIPAL", 2)
    assert learning.knowledge(f.ledger) is not first


def test_review_labels_say_how_many_choices_agree() -> None:
    assert learning.describe_source("learned:3/3") == "aprendida: 3 escolha(s) iguais"
    assert learning.describe_source("learned:3/5") == "aprendida: 3 de 5 escolhas recentes"
    assert learning.describe_source("rule") is None


def test_import_trusts_the_users_rule_then_what_was_learned_then_keywords(tmp_path: Path) -> None:
    from opesvault.importing import pipeline
    from opesvault.importing.pipeline import ImportRequest
    from opesvault.session import Session

    from . import synthetic_docs as docs

    f = family()
    ledger = f.ledger
    leisure, health = category(ledger, "Lazer"), category(ledger, "Saúde")
    for day in (1, 2):
        ledger.record_card_purchase(f.card, leisure, "30.00", date(2025, 12, day), "MERCADO BOM PRECO")
    session = Session.new(tmp_path / "x.opesvault")
    session.ledger = ledger
    batch = pipeline.import_document(session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    market = next(i for i in pipeline.items_of(ledger, batch.id) if "Mercado" in i.description)
    # the keyword rule says Alimentação; this family files it under Lazer
    assert market.target_account_id == leisure and market.suggestion_source == "learned:2/2"
    rules.add_rule(ledger, "mercado bom", health)
    pipeline.apply_rules(ledger, batch.id)
    assert pipeline.items(ledger)[market.id].target_account_id == health  # an explicit rule wins
