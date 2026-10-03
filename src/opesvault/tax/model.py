"""Persisted tax entities: who is who (CPF/CNPJ), how income is declared, assets, statements.

Classification is the user's: the app never decides that an income is exempt or taxable.
Every rate, table and limit is informed by the user for the year it applies to (docs/00 §5).
Classification lives beside the operations, never inside them (CLAUDE.md, "Classificação
não é fato financeiro").
"""

from datetime import date
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from opesvault.catalogs.irpf import GROUPS
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import Amount, YearMonth, _Entity

YEAR = Field(ge=1990, le=2999)


# ── tax ids of the people and companies around the money ──────────


class TaxSubject(StrEnum):
    MERCHANT = "merchant"  # ref: merchant key (domain.merchants.key_of): doctor, school, health plan
    ACCOUNT = "account"  # ref: account id: bank, broker, lender
    CATEGORY = "category"  # ref: income category id: employer, tenant, client


class TaxIdentity(_Entity):
    subject: TaxSubject
    ref: str = Field(min_length=1, max_length=120)
    tax_id: str = Field(pattern=r"^\d{11}$|^\d{14}$")
    name: str | None = Field(default=None, max_length=150)  # name as it goes in the return


class MemberTaxInfo(_Entity):
    member_id: UUID
    cpf: str | None = Field(default=None, pattern=r"^\d{11}$")
    birth_date: date | None = None
    declared_by: UUID | None = None  # None: files their own return (or is not declared)
    relation: str | None = Field(default=None, max_length=60)  # "Filho(a)", "Cônjuge"


# ── how each income is declared (the user's choice) ──────────


class IncomeNature(StrEnum):
    TAXABLE_PJ = "taxable_pj"
    CARNE_LEAO = "carne_leao"
    EXEMPT = "exempt"
    EXCLUSIVE = "exclusive"
    IGNORED = "ignored"


NATURE_LABELS = {
    IncomeNature.TAXABLE_PJ: "Tributável recebido de pessoa jurídica",
    IncomeNature.CARNE_LEAO: "Tributável recebido de pessoa física ou do exterior (Carnê-Leão)",
    IncomeNature.EXEMPT: "Isento e não tributável",
    IncomeNature.EXCLUSIVE: "Tributação exclusiva ou definitiva",
    IncomeNature.IGNORED: "Não entra na declaração",
}
NATURE_SHORT = {
    IncomeNature.TAXABLE_PJ: "Tributável (PJ)",
    IncomeNature.CARNE_LEAO: "Carnê-Leão",
    IncomeNature.EXEMPT: "Isento",
    IncomeNature.EXCLUSIVE: "Exclusiva",
    IncomeNature.IGNORED: "Não declarar",
}


class NatureSubject(StrEnum):
    CATEGORY = "category"  # an income category
    POSITION = "position"  # an investment: its proventos and redemption gains


class IncomeClassification(_Entity):
    subject: NatureSubject
    ref: UUID
    nature: IncomeNature


class IncomeKind(StrEnum):
    SALARY = "salary"
    THIRTEENTH = "thirteenth"
    OTHER = "other"


INCOME_KIND_LABELS = {
    IncomeKind.SALARY: "Salário, férias e outros",
    IncomeKind.THIRTEENTH: "13º salário",
    IncomeKind.OTHER: "Outro rendimento do trabalho",
}


class IncomeDetail(_Entity):
    """What the payslip says about a deposit: the gross, the tax withheld, the INSS."""

    operation_id: UUID
    kind: IncomeKind = IncomeKind.SALARY
    gross: Amount | None = None
    withheld: Amount | None = None
    social_security: Amount | None = None


# ── assets (Bens e Direitos) ──────────


class FilingSubject(StrEnum):
    ACCOUNT = "account"
    POSITION = "position"


ASSET_GROUPS = GROUPS  # the IRPF table (catalogs.irpf)

CODE = Field(pattern=r"^\d{2}$")


class AssetFiling(_Entity):
    """How an account or an investment is described in Bens e Direitos."""

    subject: FilingSubject
    ref: UUID
    group: str = CODE
    code: str = CODE
    description: str = Field(default="", max_length=512)


class DeclaredAsset(_Entity):
    """A good that is not an account: a house, a car. Declared at acquisition cost."""

    name: str = Field(min_length=1, max_length=120)
    group: str = CODE
    code: str = CODE
    description: str = Field(default="", max_length=512)
    owner_id: UUID | None = None
    acquired_on: date
    cost: Amount
    sold_on: date | None = None
    sale_value: Amount | None = None


# ── statements from the institutions (informes de rendimentos) ──────────


class ReportField(StrEnum):
    BALANCE_PREVIOUS = "balance_previous"
    BALANCE_END = "balance_end"
    TAXABLE = "taxable"
    THIRTEENTH = "thirteenth"
    SOCIAL_SECURITY = "social_security"
    WITHHELD = "withheld"
    EXEMPT = "exempt"
    EXCLUSIVE = "exclusive"


FIELD_LABELS = {
    ReportField.BALANCE_PREVIOUS: "Saldo no fim do ano anterior",
    ReportField.BALANCE_END: "Saldo no fim do ano",
    ReportField.TAXABLE: "Rendimentos tributáveis",
    ReportField.THIRTEENTH: "13º salário",
    ReportField.SOCIAL_SECURITY: "Contribuição previdenciária oficial",
    ReportField.WITHHELD: "Imposto retido na fonte",
    ReportField.EXEMPT: "Rendimentos isentos",
    ReportField.EXCLUSIVE: "Tributação exclusiva",
}


class ReportLine(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    field: ReportField
    amount: Amount
    label: str = Field(default="", max_length=200)  # the line as printed


class ReportSource(StrEnum):
    ACCOUNT = "account"  # bank, broker
    CATEGORY = "category"  # employer or other payer, by its income category


class IncomeReport(_Entity):
    year: int = YEAR
    source: ReportSource
    source_id: UUID
    payer_tax_id: str | None = Field(default=None, pattern=r"^\d{11}$|^\d{14}$")
    payer_name: str | None = Field(default=None, max_length=150)
    document_id: UUID | None = None  # the original file, kept encrypted in the vault
    lines: tuple[ReportLine, ...] = ()
    note: str | None = Field(default=None, max_length=500)


# ── parameters informed by the user ──────────


class Bracket(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    up_to: Amount | None  # None: the last bracket
    rate: Amount  # 0.075
    deduction: Amount  # parcela a deduzir


class TaxParameters(_Entity):
    """The annual table and limits of one year, copied by the user from the official source."""

    year: int = YEAR
    brackets: tuple[Bracket, ...] = ()
    simplified_rate: Amount | None = None  # desconto simplificado (0.20)
    simplified_cap: Amount | None = None
    dependent_deduction: Amount | None = None  # per dependent, per year
    education_cap: Amount | None = None  # per person, per year
    pension_cap_rate: Amount | None = None  # PGBL: share of the taxable income (0.12)
    source: str = Field(default="informado pelo usuário", max_length=300)


class Bucket(StrEnum):
    COMMON = "common"  # stocks and ETFs, swing trade
    DAY_TRADE = "day_trade"
    REIT = "reit"  # fundos imobiliários


BUCKET_LABELS = {
    Bucket.COMMON: "Operações comuns (ações e ETF)",
    Bucket.DAY_TRADE: "Day trade",
    Bucket.REIT: "Fundos imobiliários",
}


class BucketRule(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    bucket: Bucket
    rate: Amount | None = None
    exempt_sales_limit: Amount | None = None  # monthly stock sales up to this are exempt (stocks only)


class VariableIncomeRules(_Entity):
    valid_from: date
    rules: tuple[BucketRule, ...] = ()
    source: str = Field(default="informado pelo usuário", max_length=300)

    def rule(self, bucket: Bucket) -> BucketRule | None:
        return next((r for r in self.rules if r.bucket is bucket), None)


# ── what was paid and what was received ──────────


class PaymentPurpose(StrEnum):
    VARIABLE_INCOME = "variable_income"
    CARNE_LEAO = "carne_leao"


PURPOSE_LABELS = {
    PaymentPurpose.VARIABLE_INCOME: "DARF de renda variável",
    PaymentPurpose.CARNE_LEAO: "DARF do Carnê-Leão",
}


class TaxPayment(_Entity):
    purpose: PaymentPurpose
    month: YearMonth  # the month the tax refers to (apuração)
    amount: Amount
    paid_on: date
    operation_id: UUID | None = None
    member_id: UUID | None = None


class ChecklistMark(_Entity):
    year: int = YEAR
    key: str = Field(min_length=1, max_length=200)
    received: bool = True
    note: str | None = Field(default=None, max_length=300)


KINDS = {
    "tax_identity": TaxIdentity,
    "member_tax_info": MemberTaxInfo,
    "income_classification": IncomeClassification,
    "income_detail": IncomeDetail,
    "asset_filing": AssetFiling,
    "declared_asset": DeclaredAsset,
    "income_report": IncomeReport,
    "tax_parameters": TaxParameters,
    "variable_income_rules": VariableIncomeRules,
    "tax_payment": TaxPayment,
    "tax_checklist_mark": ChecklistMark,
}
for _kind, _model in KINDS.items():
    Ledger.register_kind(_kind, _model)


def collection(ledger: Ledger, kind: str) -> dict[UUID, object]:
    return ledger.entities(kind)


def require_year(year: int) -> None:
    if not 1990 <= year <= 2999:
        raise DomainError("Ano inválido.")


def positive_or_none(value: Decimal | None, label: str) -> None:
    if value is not None and value < 0:
        raise DomainError(f"{label}: informe um valor positivo.")
