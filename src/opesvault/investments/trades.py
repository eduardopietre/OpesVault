"""Quantity-and-price tracking: lots, buys, sells and corporate events (docs/06 §1, §6).

Cost method depends on the class and is always recorded: average cost for
homogeneous positions (stocks, REITs, ETFs, funds) and per-acquisition lots
(FIFO) for fixed income and treasury bonds. Neither is presented as tax law.
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountType, Amount, Operation, OperationKind, Posting, _Entity
from opesvault.domain.money import ZERO, allocate, round_money, to_decimal
from opesvault.investments.model import AssetClass, EventKind, InvestmentEvent, TrackingMode
from opesvault.investments.service import (
    FEE_CATEGORY,
    INCOME_CATEGORY,
    LOSS_CATEGORY,
    TAX_CATEGORY,
    _category,
    _require_cash,
    assets,
    position,
)


class CostMethod(StrEnum):
    AVERAGE = "average"
    FIFO = "fifo"


AVERAGE_CLASSES = {AssetClass.STOCK, AssetClass.REIT, AssetClass.ETF, AssetClass.FUND, AssetClass.CRYPTO}


def default_method(asset_class: AssetClass) -> CostMethod:
    return CostMethod.AVERAGE if asset_class in AVERAGE_CLASSES else CostMethod.FIFO


METHOD_LABELS = {
    CostMethod.AVERAGE: "custo médio ponderado (gestão; não é regra fiscal universal)",
    CostMethod.FIFO: "por lote de aquisição, mais antigo primeiro",
}


class Lot(_Entity):
    position_id: UUID
    acquired_on: date
    quantity: Amount
    cost: Amount  # includes allocated buy costs
    remaining_quantity: Amount
    remaining_cost: Amount
    source: str = "compra"


Ledger.register_kind("lot", Lot)


def lots_of(ledger: Ledger, position_id: UUID, *, open_only: bool = False) -> list[Lot]:
    out = sorted(
        (lot for lot in ledger.entities("lot").values() if lot.position_id == position_id),
        key=lambda lot: lot.acquired_on,
    )
    return [lot for lot in out if lot.remaining_quantity > 0] if open_only else out


@dataclass(frozen=True)
class Holding:
    quantity: Decimal
    cost: Decimal

    @property
    def average_price(self) -> Decimal | None:
        return self.cost / self.quantity if self.quantity else None


def holding(ledger: Ledger, position_id: UUID) -> Holding:
    open_lots = lots_of(ledger, position_id, open_only=True)
    return Holding(
        sum((lot.remaining_quantity for lot in open_lots), ZERO), sum((lot.remaining_cost for lot in open_lots), ZERO)
    )


def _require_quantity_mode(ledger: Ledger, position_id: UUID) -> None:
    if position(ledger, position_id).mode is not TrackingMode.QUANTITY:
        raise DomainError(
            "Esta posição é acompanhada por valor; converta-a para quantidade com reconciliação de custo."
        )


def buy(
    ledger: Ledger,
    position_id: UUID,
    on: date,
    quantity: object,
    unit_price: object,
    from_account: UUID,
    *,
    fees: object = "0",
    settled_on: date | None = None,
    note: str | None = None,
) -> InvestmentEvent:
    _require_quantity_mode(ledger, position_id)
    _require_cash(ledger, from_account)
    pos = position(ledger, position_id)
    qty, price, fee = to_decimal(quantity), to_decimal(unit_price), to_decimal(fees)
    if qty <= 0 or price < 0 or fee < 0:
        raise DomainError("Quantidade, preço ou custos inválidos.")
    gross = round_money(qty * price)
    cost = gross + fee
    op = ledger.add_operation(
        Operation(
            kind=OperationKind.INVESTMENT_CONTRIBUTION,
            description=f"Compra {format(qty, 'f')} {assets(ledger)[pos.asset_id].name}",
            postings=(Posting(account_id=pos.account_id, amount=cost), Posting(account_id=from_account, amount=-cost)),
            occurred_on=on,
            settled_on=settled_on or on,
            notes=note,
        )
    )
    lot = ledger.put(
        "lot",
        Lot(
            position_id=position_id,
            acquired_on=on,
            quantity=qty,
            cost=cost,
            remaining_quantity=qty,
            remaining_cost=cost,
        ),
    )
    return ledger.put(
        "investment_event",
        InvestmentEvent(
            position_id=position_id,
            kind=EventKind.BUY,
            on=on,
            gross=cost,
            quantity=qty,
            unit_price=price,
            fees=fee,
            net=cost,
            cash_account_id=from_account,
            operation_ids=(op.id,),
            lot_id=lot.id,
            note=note,
        ),
    )


def _consume(ledger: Ledger, position_id: UUID, qty: Decimal, method: CostMethod) -> Decimal:
    """Removes `qty` from open lots and returns the cost attributed to it."""
    open_lots = lots_of(ledger, position_id, open_only=True)
    held = sum((lot.remaining_quantity for lot in open_lots), ZERO)
    if qty > held:
        raise DomainError("Venda maior que a quantidade em carteira (venda a descoberto não suportada).")
    if method is CostMethod.AVERAGE:
        total_cost = sum((lot.remaining_cost for lot in open_lots), ZERO)
        attributed = total_cost if qty == held else round_money(total_cost * qty / held)
        # Average cost: every lot shrinks proportionally, keeping one average price.
        remaining_qty_ratio = (held - qty) / held
        new_costs = (
            allocate(total_cost - attributed, [lot.remaining_cost for lot in open_lots])
            if total_cost - attributed
            else [ZERO] * len(open_lots)
        )
        for lot, new_cost in zip(open_lots, new_costs, strict=True):
            ledger.put(
                "lot",
                lot.model_copy(
                    update={
                        "remaining_quantity": lot.remaining_quantity * remaining_qty_ratio,
                        "remaining_cost": new_cost,
                    }
                ),
                reason="venda (custo médio)",
            )
        return attributed
    attributed = ZERO
    left = qty
    for lot in open_lots:
        if left == 0:
            break
        take = min(left, lot.remaining_quantity)
        if take == lot.remaining_quantity:
            cost = lot.remaining_cost
        else:
            cost = round_money(lot.remaining_cost * take / lot.remaining_quantity)
        attributed += cost
        ledger.put(
            "lot",
            lot.model_copy(
                update={
                    "remaining_quantity": lot.remaining_quantity - take,
                    "remaining_cost": lot.remaining_cost - cost,
                }
            ),
            reason="venda (por lote)",
        )
        left -= take
    return attributed


def sell(
    ledger: Ledger,
    position_id: UUID,
    on: date,
    quantity: object,
    unit_price: object,
    to_account: UUID,
    *,
    fees: object = "0",
    tax_withheld: object = "0",
    method: CostMethod | None = None,
    settled_on: date | None = None,
    note: str | None = None,
) -> InvestmentEvent:
    _require_quantity_mode(ledger, position_id)
    _require_cash(ledger, to_account)
    pos = position(ledger, position_id)
    asset = assets(ledger)[pos.asset_id]
    qty, price, fee, tax = to_decimal(quantity), to_decimal(unit_price), to_decimal(fees), to_decimal(tax_withheld)
    if qty <= 0 or price < 0 or fee < 0 or tax < 0:
        raise DomainError("Quantidade, preço ou custos inválidos.")
    chosen = method or default_method(asset.asset_class)
    gross = round_money(qty * price)
    net = gross - fee - tax
    # Validate quantity before touching lots.
    if qty > holding(ledger, position_id).quantity:
        raise DomainError("Venda maior que a quantidade em carteira (venda a descoberto não suportada).")
    cost = _consume(ledger, position_id, qty, chosen)
    gain = gross - cost
    postings = [Posting(account_id=to_account, amount=net), Posting(account_id=pos.account_id, amount=-cost)]
    if gain > 0:
        postings.append(Posting(account_id=_category(ledger, AccountType.INCOME, INCOME_CATEGORY), amount=-gain))
    elif gain < 0:
        postings.append(Posting(account_id=_category(ledger, AccountType.EXPENSE, LOSS_CATEGORY), amount=-gain))
    if fee:
        postings.append(Posting(account_id=_category(ledger, AccountType.EXPENSE, FEE_CATEGORY), amount=fee))
    if tax:
        postings.append(Posting(account_id=_category(ledger, AccountType.EXPENSE, TAX_CATEGORY), amount=tax))
    op = ledger.add_operation(
        Operation(
            kind=OperationKind.INVESTMENT_WITHDRAWAL,
            description=f"Venda {format(qty, 'f')} {asset.name}",
            postings=tuple(p for p in postings if p.amount != 0),
            occurred_on=on,
            settled_on=settled_on or on,
            notes=note,
        )
    )
    return ledger.put(
        "investment_event",
        InvestmentEvent(
            position_id=position_id,
            kind=EventKind.SELL,
            on=on,
            gross=gross,
            quantity=qty,
            unit_price=price,
            cost_attributed=cost,
            cost_method=METHOD_LABELS[chosen],
            tax_withheld=tax,
            fees=fee,
            net=net,
            cash_account_id=to_account,
            operation_ids=(op.id,),
            note=note,
        ),
    )


def split(ledger: Ledger, position_id: UUID, on: date, factor: object) -> InvestmentEvent:
    """Desdobramento (factor > 1) or grupamento (factor < 1): quantity changes, cost does not."""
    _require_quantity_mode(ledger, position_id)
    ratio = to_decimal(factor)
    if ratio <= 0:
        raise DomainError("Fator inválido.")
    for lot in lots_of(ledger, position_id):
        ledger.put(
            "lot",
            lot.model_copy(
                update={"quantity": lot.quantity * ratio, "remaining_quantity": lot.remaining_quantity * ratio}
            ),
            reason=f"desdobramento/grupamento fator {ratio}",
        )
    return ledger.put(
        "investment_event", InvestmentEvent(position_id=position_id, kind=EventKind.SPLIT, on=on, factor=ratio)
    )


def bonus(
    ledger: Ledger, position_id: UUID, on: date, quantity: object, informed_cost: object = "0"
) -> InvestmentEvent:
    """Bonificação: new shares; their cost is the value informed by the company (possibly zero)."""
    _require_quantity_mode(ledger, position_id)
    pos = position(ledger, position_id)
    qty, cost = to_decimal(quantity), to_decimal(informed_cost)
    if qty <= 0 or cost < 0:
        raise DomainError("Quantidade ou custo inválidos.")
    operation_ids: tuple[UUID, ...] = ()
    if cost:
        op = ledger.add_operation(
            Operation(
                kind=OperationKind.INVESTMENT_INCOME,
                description=f"Bonificação — {assets(ledger)[pos.asset_id].name} (custo informado pela empresa)",
                postings=(
                    Posting(account_id=pos.account_id, amount=cost),
                    Posting(account_id=_category(ledger, AccountType.INCOME, INCOME_CATEGORY), amount=-cost),
                ),
                occurred_on=on,
            )
        )
        operation_ids = (op.id,)
    lot = ledger.put(
        "lot",
        Lot(
            position_id=position_id,
            acquired_on=on,
            quantity=qty,
            cost=cost,
            remaining_quantity=qty,
            remaining_cost=cost,
            source="bonificação",
        ),
    )
    return ledger.put(
        "investment_event",
        InvestmentEvent(
            position_id=position_id,
            kind=EventKind.BONUS,
            on=on,
            quantity=qty,
            gross=cost,
            operation_ids=operation_ids,
            lot_id=lot.id,
        ),
    )


def quantity_on(ledger: Ledger, position_id: UUID, on: date) -> Decimal:
    """Quantity held at the end of a date, replaying buys, sells, splits and bonuses."""
    from opesvault.investments.service import events_of

    qty = ZERO
    for event in events_of(ledger, position_id):
        if event.on > on:
            break
        if event.kind in (EventKind.BUY, EventKind.BONUS) and event.quantity:
            qty += event.quantity
        elif event.kind is EventKind.SELL and event.quantity:
            qty -= event.quantity
        elif event.kind is EventKind.SPLIT and event.factor:
            qty *= event.factor
    return qty


def opening_lot(ledger: Ledger, position_id: UUID, on: date, quantity: object, cost: object) -> Lot:
    """Existing holdings when the vault starts: quantity and known cost, against opening equity."""
    _require_quantity_mode(ledger, position_id)
    pos = position(ledger, position_id)
    qty, value = to_decimal(quantity), to_decimal(cost)
    if qty <= 0 or value < 0:
        raise DomainError("Quantidade ou custo inválidos.")
    if value:
        ledger.record_opening_balance(pos.account_id, value, on)
    lot = ledger.put(
        "lot",
        Lot(
            position_id=position_id,
            acquired_on=on,
            quantity=qty,
            cost=value,
            remaining_quantity=qty,
            remaining_cost=value,
            source="posição inicial",
        ),
    )
    ledger.put(
        "investment_event",
        InvestmentEvent(
            position_id=position_id,
            kind=EventKind.BUY,
            on=on,
            gross=value,
            quantity=qty,
            lot_id=lot.id,
            note="posição inicial",
        ),
    )
    return lot
