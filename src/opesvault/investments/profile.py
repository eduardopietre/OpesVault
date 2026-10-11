"""What an investment is: its IRPF type, where it is held, issuer, yield, maturity, liquidity and tax.

Characteristics are kept beside the position (they never change cost, value or flows). The type
comes from the IRPF Bens e Direitos table and the tax treatment names how the income is declared;
neither carries a rate (docs/00 §5). The value over time stays in the valuations.
"""

from datetime import date
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import Field

from opesvault.catalogs.irpf import EXCLUSIVE_CODES, EXEMPT_CODES, is_asset_code
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import Amount, _Entity
from opesvault.domain.money import format_decimal_br
from opesvault.investments.model import AssetClass


class Indexer(StrEnum):
    FIXED = "fixed"  # prefixado
    CDI = "cdi"
    SELIC = "selic"
    IPCA = "ipca"
    IGPM = "igpm"
    SAVINGS = "savings"  # rendimento da poupança
    VARIABLE = "variable"  # renda variável, sem indexador
    OTHER = "other"


INDEXER_LABELS = {
    Indexer.FIXED: "Prefixado",
    Indexer.CDI: "CDI",
    Indexer.SELIC: "Selic",
    Indexer.IPCA: "IPCA",
    Indexer.IGPM: "IGP-M",
    Indexer.SAVINGS: "Rendimento da poupança",
    Indexer.VARIABLE: "Renda variável (sem indexador)",
    Indexer.OTHER: "Outro",
}


class Liquidity(StrEnum):
    DAILY = "daily"
    AT_MATURITY = "at_maturity"
    DAYS = "days"  # D+N
    NONE = "none"  # sem resgate antecipado (só na bolsa, venda)


LIQUIDITY_LABELS = {
    Liquidity.DAILY: "Diária",
    Liquidity.AT_MATURITY: "No vencimento",
    Liquidity.DAYS: "Em dias (D+N)",
    Liquidity.NONE: "Só por venda no mercado",
}


class TaxTreatment(StrEnum):
    EXEMPT = "exempt"  # isento (poupança, LCI/LCA, dividendos)
    WITHHELD = "withheld"  # tributação exclusiva na fonte no resgate (CDB, Tesouro)
    COME_COTAS = "come_cotas"  # fundos com tributação periódica
    VARIABLE = "variable"  # renda variável: apuração mensal (ações, FII, ETF)
    PENSION = "pension"  # previdência (PGBL/VGBL)
    OTHER = "other"


TAX_LABELS = {
    TaxTreatment.EXEMPT: "Isento de IR",
    TaxTreatment.WITHHELD: "Retido na fonte no resgate (tributação exclusiva)",
    TaxTreatment.COME_COTAS: "Come-cotas e retenção no resgate",
    TaxTreatment.VARIABLE: "Renda variável: apuração mensal pelo investidor",
    TaxTreatment.PENSION: "Previdência privada",
    TaxTreatment.OTHER: "Outro",
}


class InvestmentProfile(_Entity):
    position_id: UUID
    bank_account_id: UUID | None = None  # where it is held (domain.banking)
    irpf_group: str | None = Field(default=None, pattern=r"^\d{2}$")
    irpf_code: str | None = Field(default=None, pattern=r"^\d{2}$")
    issuer: str | None = Field(default=None, max_length=120)
    issuer_tax_id: str | None = Field(default=None, pattern=r"^\d{14}$")
    indexer: Indexer | None = None
    rate: Amount | None = None  # percent: 110 (% do CDI), 6.5 (IPCA + 6,5%), 12.4 (prefixado)
    applied_on: date | None = None
    maturity: date | None = None
    liquidity: Liquidity | None = None
    liquidity_days: int | None = Field(default=None, ge=0, le=3650)
    tax: TaxTreatment | None = None
    income_code: str | None = Field(default=None, pattern=r"^(isento|exclusivo):\d{2}$")
    fgc: bool | None = None  # covered by the Fundo Garantidor de Créditos
    notes: str | None = Field(default=None, max_length=500)


Ledger.register_kind("investment_profile", InvestmentProfile)


def profiles(ledger: Ledger) -> dict[UUID, InvestmentProfile]:
    return ledger.entities("investment_profile")


def profile_of(ledger: Ledger, position_id: UUID) -> InvestmentProfile | None:
    return next((p for p in profiles(ledger).values() if p.position_id == position_id), None)


def save_profile(ledger: Ledger, profile: InvestmentProfile) -> InvestmentProfile:
    from opesvault.investments.service import positions

    if profile.position_id not in positions(ledger):
        raise DomainError("Investimento inexistente.")
    if (profile.irpf_group is None) != (profile.irpf_code is None) or (
        profile.irpf_group is not None and not is_asset_code(profile.irpf_group, profile.irpf_code or "")
    ):
        raise DomainError("Escolha o tipo na tabela de Bens e Direitos do IRPF.")
    if profile.income_code is not None:
        table, code = profile.income_code.split(":")
        if code not in (EXEMPT_CODES if table == "isento" else EXCLUSIVE_CODES):
            raise DomainError("Escolha o código do rendimento na lista do IRPF.")
    if profile.bank_account_id is not None:
        from opesvault.domain.banking import bank_accounts

        if profile.bank_account_id not in bank_accounts(ledger):
            raise DomainError("Escolha a conta bancária onde o investimento está.")
    if profile.rate is not None and not Decimal("-100") < profile.rate < Decimal("10000"):
        raise DomainError("Taxa fora do esperado: use o percentual, como 110 ou 6,5.")
    if profile.maturity and profile.applied_on and profile.maturity < profile.applied_on:
        raise DomainError("O vencimento não pode ser antes da aplicação.")
    if profile.issuer_tax_id is not None:
        from opesvault.tax.ids import is_cnpj

        if not is_cnpj(profile.issuer_tax_id):
            raise DomainError("CNPJ do emissor inválido: confira os dígitos.")
    current = profile_of(ledger, profile.position_id)
    if current is None:
        return ledger.put("investment_profile", profile)
    updated = profile.model_copy(update={"id": current.id})
    return (
        current if updated == current else ledger.put("investment_profile", updated, reason="características alteradas")
    )


def class_for(group: str, code: str) -> AssetClass:
    """The app's asset class for an IRPF type (the class drives renda variável and lots)."""
    if group == "03":
        return AssetClass.STOCK
    if group == "07":
        return {"03": AssetClass.REIT, "02": AssetClass.REIT, "08": AssetClass.ETF, "09": AssetClass.ETF}.get(
            code, AssetClass.FUND
        )
    if group == "08":
        return AssetClass.CRYPTO
    if (group, code) == ("99", "06"):
        return AssetClass.PENSION
    if group == "04" and code in ("02", "03"):
        return AssetClass.FIXED_INCOME
    return AssetClass.OTHER


def tax_for(group: str, code: str) -> TaxTreatment | None:
    """A starting point for the tax treatment, shown as a suggestion in the form."""
    return {
        ("04", "02"): TaxTreatment.WITHHELD,
        ("04", "03"): TaxTreatment.EXEMPT,
        ("07", "01"): TaxTreatment.COME_COTAS,
        ("07", "03"): TaxTreatment.VARIABLE,
        ("07", "09"): TaxTreatment.VARIABLE,
        ("03", "01"): TaxTreatment.VARIABLE,
        ("99", "06"): TaxTreatment.PENSION,
    }.get((group, code))


def yield_text(profile: InvestmentProfile | None) -> str:
    """'110% do CDI', 'IPCA + 6,5% a.a.', '12,4% a.a.' or '—'."""
    if profile is None or profile.indexer is None:
        return "—"
    label = INDEXER_LABELS[profile.indexer]
    if profile.rate is None:
        return label
    rate = format_decimal_br(profile.rate)
    if profile.indexer in (Indexer.CDI, Indexer.SELIC):
        return f"{rate}% do {label}"
    if profile.indexer in (Indexer.IPCA, Indexer.IGPM):
        return f"{label} + {rate}% a.a."
    if profile.indexer is Indexer.FIXED:
        return f"{rate}% a.a."
    return f"{label} ({rate}%)"


def income_code_label(code: str | None) -> str:
    if not code:
        return "—"
    table, number = code.split(":")
    names = EXEMPT_CODES if table == "isento" else EXCLUSIVE_CODES
    kind = "Isentos" if table == "isento" else "Tributação exclusiva"
    return f"{kind} {number} — {names.get(number, '?')}"


def description(ledger: Ledger, position_id: UUID) -> str | None:
    """Discriminação for Bens e Direitos, built from the characteristics (None without a profile)."""
    from opesvault.domain.banking import bank_accounts
    from opesvault.investments.service import assets, positions
    from opesvault.tax.ids import display

    profile = profile_of(ledger, position_id)
    if profile is None:
        return None
    pos = positions(ledger)[position_id]
    parts = [assets(ledger)[pos.asset_id].name]
    if profile.issuer:
        parts.append(
            f"emitido por {profile.issuer}"
            + (f", CNPJ {display(profile.issuer_tax_id)}" if profile.issuer_tax_id else "")
        )
    if profile.indexer is not None:
        parts.append(yield_text(profile))
    if profile.applied_on:
        parts.append(f"aplicado em {profile.applied_on:%d/%m/%Y}")
    if profile.maturity:
        parts.append(f"vencimento em {profile.maturity:%d/%m/%Y}")
    bank = bank_accounts(ledger).get(profile.bank_account_id) if profile.bank_account_id else None
    if bank is not None:
        parts.append(f"custodiado em {bank.where}")
    return "; ".join(parts)[:512]
