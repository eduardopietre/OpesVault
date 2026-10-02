"""Redemption and tax simulation (RF-17, docs/06 §7, docs/07 §6).

A simulation never writes to the ledger. Rules are user-parameterized and
labeled as simulations; no legal table is built in.
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from uuid import UUID

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.money import ZERO, round_money, to_decimal
from opesvault.investments.model import TaxRule, TaxRuleKind
from opesvault.investments.service import proportional_cost, remaining_cost


@dataclass(frozen=True)
class Simulation:
    gross: Decimal
    cost_attributed: Decimal | None
    cost_method: str
    gain: Decimal | None
    tax_base: Decimal | None
    rule: str
    tax: Decimal | None
    fees: Decimal
    net: Decimal | None
    net_gain: Decimal | None
    gross_return: Decimal | None
    net_return: Decimal | None
    estimated_fields: tuple[str, ...]
    remaining_value: Decimal | None
    remaining_cost: Decimal | None


def tax_for(rule: TaxRule, gain: Decimal | None, base: Decimal | None = None, on: date | None = None) -> Decimal | None:
    if on is not None and ((rule.valid_from and on < rule.valid_from) or (rule.valid_to and on > rule.valid_to)):
        raise DomainError("Regra fora da vigência na data.")
    if rule.kind is TaxRuleKind.FIXED:
        return to_decimal(rule.fixed_amount or ZERO)
    rate = to_decimal(rule.rate or ZERO)
    if rule.kind is TaxRuleKind.RATE_ON_POSITIVE_GAIN:
        if gain is None:
            return None
        return round_money(max(gain, ZERO) * rate)
    if base is None:
        return None
    return round_money(base * rate)


def simulate(
    ledger: Ledger,
    position_id: UUID,
    on: date,
    gross: object,
    rule: TaxRule,
    *,
    fees: object = "0",
    cost_attributed: object | None = None,
    current_value: object | None = None,
    informed_base: object | None = None,
) -> Simulation:
    g, fee = to_decimal(gross), to_decimal(fees)
    estimated = ["imposto (simulado: " + rule.name + ")"]
    if cost_attributed is not None:
        cost: Decimal | None = to_decimal(cost_attributed)
        method = "custo informado"
    else:
        try:
            attribution = proportional_cost(ledger, position_id, g, on)
            cost, method = attribution.amount, attribution.method
            estimated.append("custo atribuído")
        except DomainError as exc:
            cost, method = None, str(exc)
    gain = g - cost if cost is not None else None
    base = to_decimal(informed_base) if informed_base is not None else gain
    tax = tax_for(rule, gain, base, on)
    net = g - tax - fee if tax is not None else None
    net_gain = gain - tax - fee if gain is not None and tax is not None else None
    gross_return = gain / cost if gain is not None and cost else None
    net_return = net_gain / cost if net_gain is not None and cost else None
    value = to_decimal(current_value) if current_value is not None else None
    held_cost = remaining_cost(ledger, position_id, on)
    return Simulation(
        gross=g,
        cost_attributed=cost,
        cost_method=method,
        gain=gain,
        tax_base=base if rule.kind is not TaxRuleKind.FIXED else None,
        rule=f"{rule.name} v{rule.version} ({rule.source})",
        tax=tax,
        fees=fee,
        net=net,
        net_gain=net_gain,
        gross_return=gross_return,
        net_return=net_return,
        estimated_fields=tuple(estimated),
        remaining_value=value - g if value is not None else None,
        remaining_cost=held_cost - cost if cost is not None else None,
    )
