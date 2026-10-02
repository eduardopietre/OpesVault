"""Incorporating approved brokerage notes into the portfolio (docs/05 §2, nota de negociação).

Note costs are allocated to trades in proportion to their value (exactly, in cents):
they raise the cost of buys and reduce the proceeds of sells.
"""

import re

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import HistoryAction
from opesvault.domain.money import ZERO, allocate
from opesvault.importing.model import ExtractedItem, ImportBatch, ItemKind, ItemStatus
from opesvault.investments.model import AssetClass, Position, TrackingMode
from opesvault.investments.service import assets, positions
from opesvault.investments.trades import buy, sell


def guess_class(spec: str, ticker: str | None) -> AssetClass:
    upper = spec.upper()
    if re.search(r"\bFII\b|\bCI\b", upper):
        return AssetClass.REIT
    if re.search(r"\bETF\b|\bCI\s+ER\b", upper):
        return AssetClass.ETF
    return AssetClass.STOCK if ticker else AssetClass.OTHER


def position_for(ledger: Ledger, ticker: str | None, description: str, opened_on, holder=None) -> Position:  # type: ignore[no-untyped-def]
    from opesvault.investments.service import create_position

    key = ticker or description.split(" ", 1)[1]
    for pos in positions(ledger).values():
        asset = assets(ledger)[pos.asset_id]
        if pos.mode is TrackingMode.QUANTITY and not pos.closed and (asset.ticker or asset.name) == key:
            return pos
    spec = description.split(" ", 1)[1] if " " in description else description
    return create_position(
        ledger,
        ticker or spec,
        guess_class(spec, ticker),
        opened_on,
        holder_id=holder,
        mode=TrackingMode.QUANTITY,
        ticker=ticker,
    )


def approve_note(ledger: Ledger, batch: ImportBatch, selected: list[ExtractedItem]):  # type: ignore[no-untyped-def]
    from opesvault.importing.pipeline import ApprovalResult, _update_batch_status

    if batch.account_id is None:
        raise DomainError("Escolha a conta (saldo em corretora ou conta corrente) onde a nota liquida.")
    trades = [i for i in selected if i.kind is ItemKind.TRADE and i.status is not ItemStatus.APPROVED]
    fees = [i for i in selected if i.kind is ItemKind.FEE]
    if not trades:
        raise DomainError("Nenhum negócio a incorporar.")
    if any(i.quantity is None or i.unit_price is None or i.amount is None for i in trades):
        raise DomainError("Há negócios sem quantidade, preço ou valor.")
    cost_total = sum((f.amount or ZERO) * (1 if not f.credit else -1) for f in fees if "IRRF" not in f.description)
    irrf = sum((f.amount or ZERO for f in fees if "IRRF" in f.description), ZERO)
    shares = allocate(cost_total, [i.amount or ZERO for i in trades]) if cost_total else [ZERO] * len(trades)
    sells = [i for i in trades if i.description.startswith("Venda")]
    irrf_shares = allocate(irrf, [i.amount or ZERO for i in sells]) if irrf and sells else [ZERO] * len(sells)
    irrf_by_item = dict(zip([i.id for i in sells], irrf_shares, strict=True))
    trade_date = batch.header.trade_date
    settle = batch.header.settlement_date
    if trade_date is None:
        raise DomainError("Data do pregão desconhecida.")
    note_ref = f"nota {batch.header.note_number or '?'}"
    result = ApprovalResult()
    # Buys first, so a same-note buy-and-sell never sells what was not yet bought.
    ordered = sorted(zip(trades, shares, strict=True), key=lambda pair: pair[0].description.startswith("Venda"))
    store = ledger.entities("extracted_item")
    for item, share in ordered:
        pos = position_for(ledger, item.ticker, item.description, trade_date, item.member_id)
        assert item.quantity is not None and item.unit_price is not None
        if item.description.startswith("Venda"):
            event = sell(
                ledger,
                pos.id,
                trade_date,
                item.quantity,
                item.unit_price,
                batch.account_id,
                fees=share,
                tax_withheld=irrf_by_item.get(item.id, ZERO),
                settled_on=settle,
                note=note_ref,
            )
        else:
            event = buy(
                ledger,
                pos.id,
                trade_date,
                item.quantity,
                item.unit_price,
                batch.account_id,
                fees=share,
                settled_on=settle,
                note=note_ref,
            )
        ledger.put(
            "extracted_item",
            store[item.id].model_copy(update={"status": ItemStatus.APPROVED, "operation_id": event.operation_ids[0]}),
            reason="incorporado à carteira",
            action=HistoryAction.APPROVE_IMPORT,
        )
        result.created += 1
    for fee in fees:
        ledger.put(
            "extracted_item",
            store[fee.id].model_copy(update={"status": ItemStatus.APPROVED}),
            reason="custo rateado entre os negócios",
            action=HistoryAction.APPROVE_IMPORT,
        )
    _update_batch_status(ledger, batch.id)
    return result
