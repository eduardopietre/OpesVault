"""Investment commands: positions, valuations, flows, redemptions and taxes (docs/06 §1-7).

Every money movement is a ledger operation (postings on the position's cost
account); valuations live apart and never create flows (docs/04 §3).
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from uuid import UUID

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import (
    AccountSubtype,
    AccountType,
    LedgerAccount,
    Operation,
    OperationKind,
    Posting,
)
from opesvault.domain.money import round_money, to_decimal
from opesvault.investments.model import (
    Asset,
    AssetClass,
    EventKind,
    EventQuality,
    InvestmentEvent,
    Position,
    TrackingMode,
    Valuation,
    ValueNature,
)

INCOME_CATEGORY = "Rendimentos de investimentos"
LOSS_CATEGORY = "Perdas em investimentos"
TAX_CATEGORY = "Impostos e taxas"
FEE_CATEGORY = "Custos de investimentos"
TAX_PAYABLE = "Imposto a pagar"
SUSPENSE = "Resgates a discriminar"


def assets(ledger: Ledger) -> dict[UUID, Asset]:
    return ledger.entities("asset")


def positions(ledger: Ledger) -> dict[UUID, Position]:
    return ledger.entities("position")


def valuations(ledger: Ledger) -> dict[UUID, Valuation]:
    return ledger.entities("valuation")


def events(ledger: Ledger) -> dict[UUID, InvestmentEvent]:
    return ledger.entities("investment_event")


def valuations_of(ledger: Ledger, position_id: UUID) -> list[Valuation]:
    return sorted((v for v in valuations(ledger).values() if v.position_id == position_id), key=lambda v: v.on)


def events_of(ledger: Ledger, position_id: UUID) -> list[InvestmentEvent]:
    return sorted((e for e in events(ledger).values() if e.position_id == position_id), key=lambda e: e.on)


def position(ledger: Ledger, position_id: UUID) -> Position:
    try:
        return positions(ledger)[position_id]
    except KeyError:
        raise DomainError("Posição inexistente.") from None


def _category(ledger: Ledger, kind: AccountType, name: str) -> UUID:
    for account in ledger.categories(kind):
        if account.name == name:
            return account.id
    return ledger.add_account(LedgerAccount(name=name, type=kind, subtype=AccountSubtype.CATEGORY)).id


def tax_payable_account(ledger: Ledger) -> UUID:
    for account in ledger.accounts.values():
        if account.subtype is AccountSubtype.TAX_PAYABLE and not account.archived:
            return account.id
    return ledger.add_account(
        LedgerAccount(name=TAX_PAYABLE, type=AccountType.LIABILITY, subtype=AccountSubtype.TAX_PAYABLE)
    ).id


def _require_cash(ledger: Ledger, account_id: UUID) -> None:
    account = ledger.account(account_id)
    if account.type is not AccountType.ASSET or account.subtype is AccountSubtype.INVESTMENT:
        raise DomainError("Escolha uma conta de dinheiro (corrente, poupança ou saldo em corretora).")


def remaining_cost(ledger: Ledger, position_id: UUID, at: date | None = None) -> Decimal:
    """Cost of what is still held, kept as the balance of the position's ledger account."""
    from opesvault.domain.queries import balance

    return balance(ledger, position(ledger, position_id).account_id, at)


# ── positions ─────────────────────────────────────


def create_position(
    ledger: Ledger,
    name: str,
    asset_class: AssetClass,
    opened_on: date,
    *,
    holder_id: UUID | None = None,
    mode: TrackingMode = TrackingMode.VALUE,
    ticker: str | None = None,
    initial_cost: object | None = None,
    from_account: UUID | None = None,
    reference_value: object | None = None,
    reference_nature: ValueNature = ValueNature.GROSS,
) -> Position:
    """Open a position.

    - `initial_cost` + `from_account`: money leaves a cash account now (aporte).
    - `initial_cost` alone: an existing investment whose cost is known (opening balance).
    - `reference_value` without cost: only market value is known (docs/06 §8 F); gain since
      acquisition and tax base stay unknown.
    """
    if mode is TrackingMode.QUANTITY:
        if initial_cost is not None and to_decimal(initial_cost) != 0:
            raise DomainError("Posições por quantidade começam vazias: registre compras ou uma posição inicial.")
        initial_cost = None
    elif initial_cost is None and reference_value is None:
        raise DomainError("Informe o custo inicial ou um valor de referência.")
    asset = ledger.put("asset", Asset(name=name.strip(), asset_class=asset_class, ticker=ticker))
    account = ledger.add_account(
        LedgerAccount(
            name=f"Investimento: {asset.name}",
            type=AccountType.ASSET,
            subtype=AccountSubtype.INVESTMENT,
            holders=(holder_id,) if holder_id else (),
        )
    )
    pos = ledger.put(
        "position",
        Position(
            asset_id=asset.id,
            account_id=account.id,
            holder_id=holder_id,
            mode=mode,
            opened_on=opened_on,
            cost_known=initial_cost is not None or mode is TrackingMode.QUANTITY,
        ),
    )
    if initial_cost is not None and to_decimal(initial_cost) > 0:
        cost = to_decimal(initial_cost)
        if from_account is not None:
            contribute(ledger, pos.id, cost, opened_on, from_account)
        else:
            op = ledger.record_opening_balance(account.id, cost, opened_on)
            ledger.put(
                "investment_event",
                InvestmentEvent(
                    position_id=pos.id,
                    kind=EventKind.CONTRIBUTION,
                    on=opened_on,
                    gross=cost,
                    operation_ids=(op.id,),
                    note="saldo de abertura",
                ),
            )
        if reference_value is None and mode is TrackingMode.VALUE:
            add_valuation(ledger, pos.id, opened_on, cost, ValueNature.GROSS, source="custo inicial")
    elif reference_value is not None:
        value = to_decimal(reference_value)
        if value:
            ledger.record_opening_balance(account.id, value, opened_on)
    if reference_value is not None:
        add_valuation(ledger, pos.id, opened_on, reference_value, reference_nature, source="referência inicial")
    return pos


# ── valuations ───────────────────────────────────


def add_valuation(
    ledger: Ledger,
    position_id: UUID,
    on: date,
    value: object,
    nature: ValueNature,
    *,
    source: str = "manual",
    quantity: object | None = None,
    unit_price: object | None = None,
    note: str | None = None,
) -> Valuation:
    """A new date adds a point; another source on the same date is kept apart (never averaged)."""
    position(ledger, position_id)
    amount = to_decimal(value)
    if amount < 0:
        raise DomainError("Valor de avaliação não pode ser negativo.")
    same_day = [v for v in valuations_of(ledger, position_id) if v.on == on]
    if any(v.source == source for v in same_day):
        raise DomainError("Já existe avaliação desta fonte nesta data: use 'corrigir observação'.")
    valuation = Valuation(
        position_id=position_id,
        on=on,
        value=amount,
        nature=nature,
        source=source,
        quantity=to_decimal(quantity) if quantity is not None else None,
        unit_price=to_decimal(unit_price) if unit_price is not None else None,
        note=note,
        selected=not same_day,  # the first observation of a date is used until the user picks another
    )
    return ledger.put("valuation", valuation)


def correct_valuation(
    ledger: Ledger, valuation_id: UUID, value: object, reason: str, nature: ValueNature | None = None
) -> Valuation:
    current = valuations(ledger).get(valuation_id)
    if current is None:
        raise DomainError("Avaliação inexistente.")
    if not reason.strip():
        raise DomainError("Correções exigem motivo.")
    update: dict[str, object] = {"value": to_decimal(value)}
    if nature is not None:
        update["nature"] = nature
    return ledger.put("valuation", current.model_copy(update=update), reason=reason)


def select_valuation(ledger: Ledger, valuation_id: UUID) -> None:
    chosen = valuations(ledger)[valuation_id]
    for other in valuations_of(ledger, chosen.position_id):
        if other.on == chosen.on and other.selected != (other.id == valuation_id):
            ledger.put(
                "valuation",
                other.model_copy(update={"selected": other.id == valuation_id}),
                reason="escolha da observação usada",
            )


# ── flows ────────────────────────────────────────


def contribute(ledger: Ledger, position_id: UUID, amount: object, on: date, from_account: UUID) -> InvestmentEvent:
    pos = position(ledger, position_id)
    _require_cash(ledger, from_account)
    value = to_decimal(amount)
    if value <= 0:
        raise DomainError("Informe um valor positivo.")
    op = ledger.add_operation(
        Operation(
            kind=OperationKind.INVESTMENT_CONTRIBUTION,
            description=f"Aporte — {assets(ledger)[pos.asset_id].name}",
            postings=(
                Posting(account_id=pos.account_id, amount=value),
                Posting(account_id=from_account, amount=-value),
            ),
            occurred_on=on,
            settled_on=on,
        )
    )
    return ledger.put(
        "investment_event",
        InvestmentEvent(
            position_id=position_id,
            kind=EventKind.CONTRIBUTION,
            on=on,
            gross=value,
            net=value,
            cash_account_id=from_account,
            operation_ids=(op.id,),
        ),
    )


def distribute(
    ledger: Ledger, position_id: UUID, gross: object, on: date, to_account: UUID, tax_withheld: object = "0"
) -> InvestmentEvent:
    """Provento paid outside the position: income, never a change in cost or value."""
    pos = position(ledger, position_id)
    _require_cash(ledger, to_account)
    value, tax = to_decimal(gross), to_decimal(tax_withheld)
    if value <= 0 or tax < 0 or tax > value:
        raise DomainError("Valores do provento inválidos.")
    postings = [
        Posting(account_id=to_account, amount=value - tax),
        Posting(account_id=_category(ledger, AccountType.INCOME, INCOME_CATEGORY), amount=-value),
    ]
    if tax:
        postings.append(Posting(account_id=_category(ledger, AccountType.EXPENSE, TAX_CATEGORY), amount=tax))
    op = ledger.add_operation(
        Operation(
            kind=OperationKind.INVESTMENT_INCOME,
            description=f"Provento — {assets(ledger)[pos.asset_id].name}",
            postings=tuple(postings),
            occurred_on=on,
            settled_on=on,
        )
    )
    return ledger.put(
        "investment_event",
        InvestmentEvent(
            position_id=position_id,
            kind=EventKind.DISTRIBUTION,
            on=on,
            gross=value,
            tax_withheld=tax,
            net=value - tax,
            cash_account_id=to_account,
            operation_ids=(op.id,),
        ),
    )


@dataclass(frozen=True)
class CostAttribution:
    amount: Decimal
    method: str


def proportional_cost(ledger: Ledger, position_id: UUID, gross: Decimal, on: date) -> CostAttribution:
    """Average proportional cost: a management choice for homogeneous positions, not a tax rule (docs/06 §6)."""
    from opesvault.investments.performance import value_at

    pos = position(ledger, position_id)
    if not pos.cost_known:
        raise DomainError("Custo desconhecido: informe o custo atribuído ou registre sem apurar ganho.")
    observed = value_at(ledger, position_id, on)
    if observed is None or observed.valuation.nature is not ValueNature.GROSS or observed.valuation.value <= 0:
        raise DomainError("É preciso uma avaliação bruta até a data para atribuir custo proporcional.")
    cost = remaining_cost(ledger, position_id, on)
    fraction = gross / observed.valuation.value
    if fraction > 1:
        raise DomainError("Resgate maior que o valor avaliado.")
    return CostAttribution(round_money(cost * fraction), "custo médio proporcional (hipótese de posição homogênea)")


def redeem(
    ledger: Ledger,
    position_id: UUID,
    on: date,
    gross: object,
    to_account: UUID,
    *,
    cost_attributed: object | None = None,
    tax_withheld: object = "0",
    tax_due_later: object = "0",
    fees: object = "0",
    net_informed: object | None = None,
    final: bool = False,
    event_id: UUID | None = None,
    reason: str | None = None,
) -> InvestmentEvent:
    """Resgate: net credited now = gross − withheld tax − fees (docs/06 §6).

    Tax due later is an obligation (Imposto a pagar), reducing cash only when paid (TA-28).
    """
    pos = position(ledger, position_id)
    _require_cash(ledger, to_account)
    g, tw, td, fee = to_decimal(gross), to_decimal(tax_withheld), to_decimal(tax_due_later), to_decimal(fees)
    if g <= 0 or min(tw, td, fee) < 0:
        raise DomainError("Valores do resgate inválidos.")
    net = g - tw - fee
    if net < 0:
        raise DomainError("Impostos e taxas maiores que o valor bruto.")
    if net_informed is not None and to_decimal(net_informed) != net:
        raise DomainError("O líquido informado não confere com bruto − imposto retido − taxas.")
    if cost_attributed is None:
        if final:
            attribution = CostAttribution(
                remaining_cost(ledger, position_id, on), "custo total remanescente (resgate total)"
            )
        else:
            attribution = proportional_cost(ledger, position_id, g, on)
    else:
        attribution = CostAttribution(to_decimal(cost_attributed), "custo informado")
    cost = attribution.amount
    if cost < 0 or cost > remaining_cost(ledger, position_id, on):
        raise DomainError("Custo atribuído maior que o custo remanescente.")
    gain = g - cost
    postings = [
        Posting(account_id=to_account, amount=net),
        Posting(account_id=pos.account_id, amount=-cost),
    ]
    if gain > 0:
        postings.append(Posting(account_id=_category(ledger, AccountType.INCOME, INCOME_CATEGORY), amount=-gain))
    elif gain < 0:
        postings.append(Posting(account_id=_category(ledger, AccountType.EXPENSE, LOSS_CATEGORY), amount=-gain))
    if tw:
        postings.append(Posting(account_id=_category(ledger, AccountType.EXPENSE, TAX_CATEGORY), amount=tw))
    if fee:
        postings.append(Posting(account_id=_category(ledger, AccountType.EXPENSE, FEE_CATEGORY), amount=fee))
    operations = [
        Operation(
            kind=OperationKind.INVESTMENT_WITHDRAWAL,
            description=f"Resgate — {assets(ledger)[pos.asset_id].name}",
            postings=tuple(postings),
            occurred_on=on,
            settled_on=on,
        )
    ]
    if td:
        operations.append(
            Operation(
                kind=OperationKind.OTHER,
                description=f"Imposto devido sobre resgate — {assets(ledger)[pos.asset_id].name}",
                postings=(
                    Posting(account_id=_category(ledger, AccountType.EXPENSE, TAX_CATEGORY), amount=td),
                    Posting(account_id=tax_payable_account(ledger), amount=-td),
                ),
                occurred_on=on,
            )
        )
    # Compared with the cost remaining BEFORE this redemption: after it is posted the remaining cost
    # is already reduced, so a total redemption must be recognised first.
    remaining_before = remaining_cost(ledger, position_id)
    created = [ledger.add_operation(op) for op in operations]
    if final and cost == remaining_before and pos.mode is TrackingMode.VALUE:
        ledger.put("position", pos.model_copy(update={"closed": True}), reason="resgate total")
    event = InvestmentEvent(
        position_id=position_id,
        kind=EventKind.WITHDRAWAL,
        on=on,
        gross=g,
        cost_attributed=cost,
        cost_method=attribution.method,
        tax_withheld=tw,
        tax_due_later=td,
        fees=fee,
        net=net,
        cash_account_id=to_account,
        operation_ids=tuple(o.id for o in created),
    )
    if event_id is not None:
        event = event.model_copy(update={"id": event_id})
    return ledger.put("investment_event", event, reason=reason)


def redeem_net_only(ledger: Ledger, position_id: UUID, on: date, net: object, to_account: UUID) -> InvestmentEvent:
    """Only the credited net is known: cash is recorded, deductions stay 'a discriminar' (docs/01 §3).

    Tax is never inferred as zero; results using this event are flagged incomplete.
    """
    pos = position(ledger, position_id)
    _require_cash(ledger, to_account)
    value = to_decimal(net)
    if value <= 0:
        raise DomainError("Informe o líquido recebido.")
    # A liability-side suspense keeps income and net worth untouched until the deductions are known.
    suspense = (
        next(
            (a.id for a in ledger.accounts.values() if a.name == SUSPENSE and a.type is AccountType.LIABILITY),
            None,
        )
        or ledger.add_account(
            LedgerAccount(name=SUSPENSE, type=AccountType.LIABILITY, subtype=AccountSubtype.OTHER_LIABILITY)
        ).id
    )
    op = ledger.add_operation(
        Operation(
            kind=OperationKind.INVESTMENT_WITHDRAWAL,
            description=f"Resgate (líquido, deduções a discriminar) — {assets(ledger)[pos.asset_id].name}",
            postings=(Posting(account_id=to_account, amount=value), Posting(account_id=suspense, amount=-value)),
            occurred_on=on,
            settled_on=on,
        )
    )
    return ledger.put(
        "investment_event",
        InvestmentEvent(
            position_id=position_id,
            kind=EventKind.WITHDRAWAL,
            on=on,
            net=value,
            cash_account_id=to_account,
            operation_ids=(op.id,),
            quality=EventQuality.INCOMPLETE,
            note="deduções a discriminar",
        ),
    )


def complete_redemption(
    ledger: Ledger,
    event_id: UUID,
    gross: object,
    *,
    cost_attributed: object | None = None,
    tax_withheld: object = "0",
    fees: object = "0",
    reason: str = "complemento do resgate",
) -> InvestmentEvent:
    """Replace a net-only redemption by its itemized version; the provisional operation is cancelled."""
    current = events(ledger).get(event_id)
    if current is None or current.quality is not EventQuality.INCOMPLETE or current.cash_account_id is None:
        raise DomainError("Resgate incompleto inexistente.")
    completed = redeem(
        ledger,
        current.position_id,
        current.on,
        gross,
        current.cash_account_id,
        cost_attributed=cost_attributed,
        tax_withheld=tax_withheld,
        fees=fees,
        net_informed=current.net,
        event_id=current.id,
        reason=reason,
    )
    # Only after the itemized version is valid is the provisional net-only entry cancelled.
    for op_id in current.operation_ids:
        ledger.cancel_operation(op_id, reason)
    return completed


def pay_tax(
    ledger: Ledger, amount: object, on: date, from_account: UUID, description: str = "Pagamento de imposto"
) -> Operation:
    """Cash leaves only when the tax is paid (TA-28)."""
    _require_cash(ledger, from_account)
    value = to_decimal(amount)
    return ledger.add_operation(
        Operation(
            kind=OperationKind.TAX_PAYMENT,
            description=description,
            postings=(
                Posting(account_id=tax_payable_account(ledger), amount=value),
                Posting(account_id=from_account, amount=-value),
            ),
            occurred_on=on,
            settled_on=on,
        )
    )
