"""Category suggestions for review items (docs/05 §3, step 8). Suggestions never approve anything."""

import re
from uuid import UUID

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import (
    AccountType,
)
from opesvault.importing import learning, rules
from opesvault.importing.model import (
    ExtractedItem,
    ItemKind,
    ItemStatus,
)
from opesvault.importing.store import batches, items

# Keyword rules for category suggestions. Suggestions never approve anything (docs/05 §5).
KEYWORD_RULES: tuple[tuple[str, str], ...] = (
    (r"\bIOF\b", "Impostos e taxas"),
    (r"JUROS|MULTA|ENCARGO|ANUIDADE|TARIFA", "Juros e encargos"),
    (r"UBER|99\s*POP|POSTO|SHELL|IPIRANGA|ESTACIONA", "Transporte"),
    (r"IFOOD|MERCADO|SUPERMERC|PADARIA|RESTAURANTE|PAO DE ACUCAR|CARREFOUR", "Alimentação"),
    (r"NETFLIX|SPOTIFY|AMAZON PRIME|DISNEY|YOUTUBE|ASSINATURA", "Serviços e assinaturas"),
    (r"FARMACIA|DROGA|HOSPITAL|CLINICA|LABORAT", "Saúde"),
    (r"ESCOLA|FACULDADE|CURSO|LIVRARIA", "Educação"),
    (r"ALUGUEL|CONDOMINIO|ENERGIA|ENEL|SABESP|AGUA|INTERNET|VIVO|CLARO", "Moradia"),
    (r"SALARIO|PROVENTOS|FOLHA", "Salário"),
)


def suggest(ledger: Ledger, item: ExtractedItem) -> tuple[UUID | None, str | None]:
    """Order of trust: the user's rule, then what the family chose before, then the keyword rules."""
    if item.kind in (ItemKind.TRADE, ItemKind.FEE, ItemKind.CARD_PAYMENT):
        return None, None
    wanted = AccountType.INCOME if item.kind in (ItemKind.CREDIT,) else AccountType.EXPENSE
    if item.kind is ItemKind.CARD_CREDIT:
        wanted = AccountType.EXPENSE  # a refund reduces the original expense category
    batch = batches(ledger).get(item.batch_id)
    account_id = batch.account_id if batch else None
    rule = rules.match(ledger, item.description, account_id, wanted)
    if rule is not None:
        return rule.target_account_id, f"user_rule:{rule.id}"
    learned = learning.suggest(ledger, item.description, wanted, account_id)
    if learned is not None:
        return learned.category_id, learned.source
    key = rules.normalize(item.description)
    for pattern, category_name in KEYWORD_RULES:
        if re.search(pattern, key):
            for account in ledger.categories(wanted):
                if account.name == category_name:
                    return account.id, "rule"
    return None, None


def apply_rules(ledger: Ledger, batch_id: UUID | None = None) -> int:
    """Re-suggests pending items after the rules changed. Categories chosen by hand stay."""
    changed = 0
    store = items(ledger)
    for item in list(store.values()):
        if batch_id is not None and item.batch_id != batch_id:
            continue
        if item.status not in (ItemStatus.READY, ItemStatus.NEEDS_REVIEW):
            continue
        if item.target_account_id is not None and item.suggestion_source is None:
            continue  # a person chose this category
        target, source = suggest(ledger, item.model_copy(update={"target_account_id": None}))
        old_rule = (item.suggestion_source or "").startswith("user_rule:")
        if target is None and not old_rule:
            continue  # nothing better than the current suggestion (e.g. from the local AI)
        if (target, source) != (item.target_account_id, item.suggestion_source):
            store[item.id] = item.model_copy(update={"target_account_id": target, "suggestion_source": source})
            changed += 1
    return changed
