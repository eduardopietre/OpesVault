"""Simplified or itemized return: which one costs less, with the table the user informed.

A simulation: it writes nothing and uses only the parameters of the year typed by the user
(`TaxParameters`). Missing parameters make the affected result unknown, never zero; donations
deducted from the tax itself and any extra reducer of the year are not considered.
"""

from dataclasses import dataclass, field
from decimal import Decimal
from uuid import UUID

from opesvault.domain.deductibles import DeductibleKind
from opesvault.domain.ledger import Ledger
from opesvault.domain.money import ZERO, round_money
from opesvault.tax import declaration, records
from opesvault.tax.model import Bracket, IncomeNature, PaymentPurpose, TaxParameters

NOTICE = (
    "Simulação com a tabela e os limites que você informou para o ano. Não considera doações deduzidas "
    "do imposto, redutores extras nem rendimentos que não foram registrados; o programa da Receita decide."
)


@dataclass
class Model:
    name: str
    deductions: Decimal | None
    base: Decimal | None
    tax: Decimal | None


@dataclass
class Comparison:
    year: int
    taxable: Decimal
    withheld: Decimal  # IRRF on salaries plus Carnê-Leão paid
    deductions: dict[str, Decimal] = field(default_factory=dict)  # itemized, by label
    left_out: dict[str, Decimal] = field(default_factory=dict)  # recorded, not deductible from the base
    simplified: Model | None = None
    itemized: Model | None = None
    missing: list[str] = field(default_factory=list)

    def balance(self, model: Model | None) -> Decimal | None:
        """Positive: to pay; negative: to be refunded."""
        if model is None or model.tax is None:
            return None
        return model.tax - self.withheld

    @property
    def best(self) -> Model | None:
        known = [m for m in (self.simplified, self.itemized) if m is not None and m.tax is not None]
        return min(known, key=lambda m: m.tax or ZERO) if len(known) == 2 else None


def table_tax(brackets: tuple[Bracket, ...], base: Decimal) -> Decimal:
    if base <= 0 or not brackets:
        return ZERO
    for bracket in brackets:
        if bracket.up_to is None or base <= bracket.up_to:
            return max(round_money(base * bracket.rate - bracket.deduction), ZERO)
    last = brackets[-1]
    return max(round_money(base * last.rate - last.deduction), ZERO)


def compare(ledger: Ledger, year: int, declarant_id: UUID | None) -> Comparison:
    people = records.people_of(ledger, declarant_id)
    params = records.parameters(ledger, year)
    found = declaration.income(ledger, year, people)
    taxable = sum((r.taxable for r in found.taxable), ZERO)
    taxable += sum((r.amount for r in found.by_nature(IncomeNature.CARNE_LEAO)), ZERO)
    withheld = sum((r.withheld for r in found.taxable), ZERO)
    withheld += sum((m.paid for m in found.carne_leao), ZERO)
    out = Comparison(year, taxable, withheld)
    if params is None or not params.brackets:
        out.missing.append(f"a tabela anual de {year}")
    social = sum((r.social_security for r in found.taxable), ZERO)
    if social:
        out.deductions["Previdência oficial (INSS)"] = social
    _itemize(ledger, year, people, declarant_id, params, taxable, out)
    if params is not None and params.brackets:
        _models(params, taxable, out)
    return out


def _itemize(
    ledger: Ledger,
    year: int,
    people: set[UUID] | None,
    declarant_id: UUID | None,
    params: TaxParameters | None,
    taxable: Decimal,
    out: Comparison,
) -> None:
    rows = declaration.payments(ledger, year, people)
    by_kind: dict[DeductibleKind, Decimal] = {}
    education: dict[UUID | None, Decimal] = {}
    for row in rows:
        kind = row.kind
        by_kind[kind] = by_kind.get(kind, ZERO) + row.net
        if kind is DeductibleKind.EDUCATION:
            education[row.beneficiary_id] = education.get(row.beneficiary_id, ZERO) + row.net
    if by_kind.get(DeductibleKind.HEALTH):
        out.deductions["Despesas médicas"] = by_kind[DeductibleKind.HEALTH]
    if education:
        if params is None or params.education_cap is None:
            out.missing.append("o limite anual de educação")
        else:
            cap = params.education_cap
            out.deductions["Instrução (até o limite por pessoa)"] = sum(
                (min(max(v, ZERO), cap) for v in education.values()), ZERO
            )
    pension = by_kind.get(DeductibleKind.PENSION, ZERO)
    if pension:
        if params is None or params.pension_cap_rate is None:
            out.missing.append("o limite da previdência privada")
        else:
            out.deductions["Previdência privada (até o limite)"] = min(
                pension, round_money(taxable * params.pension_cap_rate)
            )
    if by_kind.get(DeductibleKind.ALIMONY):
        out.deductions["Pensão alimentícia"] = by_kind[DeductibleKind.ALIMONY]
    count = len(records.dependents_of(ledger, declarant_id)) if declarant_id else 0
    if count:
        if params is None or params.dependent_deduction is None:
            out.missing.append("a dedução por dependente")
        else:
            out.deductions[f"Dependentes ({count})"] = params.dependent_deduction * count
    for kind, label in ((DeductibleKind.DONATION, "Doações (deduzidas do imposto)"), (DeductibleKind.OTHER, "Outras")):
        if by_kind.get(kind):
            out.left_out[label] = by_kind[kind]


def _models(params: TaxParameters, taxable: Decimal, out: Comparison) -> None:
    deductions = sum(out.deductions.values(), ZERO)
    itemized_known = not any(
        m in out.missing
        for m in ("o limite anual de educação", "o limite da previdência privada", "a dedução por dependente")
    )
    if itemized_known:
        base = max(taxable - deductions, ZERO)
        out.itemized = Model("Completa", deductions, base, table_tax(params.brackets, base))
    else:
        out.itemized = Model("Completa", None, None, None)
    if params.simplified_rate is None or params.simplified_cap is None:
        out.missing.append("o desconto simplificado (percentual e teto)")
        out.simplified = Model("Simplificada", None, None, None)
        return
    discount = min(round_money(taxable * params.simplified_rate), params.simplified_cap)
    base = max(taxable - discount, ZERO)
    out.simplified = Model("Simplificada", discount, base, table_tax(params.brackets, base))


def carne_leao_paid(ledger: Ledger, year: int) -> Decimal:
    from opesvault.tax.model import TaxPayment

    found: list[TaxPayment] = list(records.payments(ledger).values())
    return sum((p.amount for p in found if p.purpose is PaymentPurpose.CARNE_LEAO and p.month.year == year), ZERO)
