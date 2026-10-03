"""Words the review shows for batches, items and where a suggested category came from."""

from opesvault.importing import learning
from opesvault.importing.model import BatchStatus, ExtractedItem, ItemKind, ItemStatus

STATUS_LABELS = {
    BatchStatus.UNSUPPORTED: "Não suportado",
    BatchStatus.AMBIGUOUS: "Escolher layout",
    BatchStatus.IN_REVIEW: "Em revisão",
    BatchStatus.PARTIAL: "Parcial",
    BatchStatus.APPROVED: "Aprovado",
    BatchStatus.REJECTED: "Rejeitado",
}
ITEM_STATUS_LABELS = {
    ItemStatus.NEEDS_REVIEW: "Revisar",
    ItemStatus.READY: "Pronto",
    ItemStatus.APPROVED: "Aprovado",
    ItemStatus.REJECTED: "Rejeitado",
    ItemStatus.DUPLICATE: "Já registrado",
}
KIND_LABELS = {
    ItemKind.PURCHASE: "Compra",
    ItemKind.CARD_CREDIT: "Crédito/estorno",
    ItemKind.CARD_PAYMENT: "Pagamento",
    ItemKind.CARD_CHARGE: "Encargo",
    ItemKind.DEBIT: "Saída",
    ItemKind.CREDIT: "Entrada",
    ItemKind.TRADE: "Negócio",
    ItemKind.FEE: "Custo",
}
# "history" was written by versions before the learned suggestions; old items still carry it.
SOURCE_LABELS = {"history": "sugestão (histórico)", "rule": "sugestão (regra padrão)"}


def source_label(source: str) -> str:
    learned = learning.describe_source(source)
    if learned is not None:
        return f"sugestão ({learned})"
    if source.startswith("user_rule:"):
        return "sugestão (sua regra)"
    if source.startswith("ollama:"):
        # "ollama:<model>:<prompt>[@digest]": the model name is what a person recognizes.
        model = source.removeprefix("ollama:").split("@")[0].rsplit(":", 1)[0]
        return f"sugestão (IA local, {model})"
    return SOURCE_LABELS.get(source, f"sugestão ({source})")


def item_notes(item: ExtractedItem) -> str:
    """What the review row says about an item besides its fields: warnings, installment, origin."""
    notes = [*item.warnings]
    if item.installment:
        notes.append(f"parcela {item.installment[0]}/{item.installment[1]}")
    if item.foreign_amount is not None:
        notes.append(f"{item.foreign_currency} {item.foreign_amount}")
    if item.card_last4:
        notes.append(f"cartão final {item.card_last4}")
    if item.suggestion_source:
        notes.append(source_label(item.suggestion_source))
    if item.status is ItemStatus.DUPLICATE:
        notes.append("já existe no livro: aprovar só vincula a evidência")
    return "; ".join(notes)
