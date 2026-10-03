"""Reading and changing the tax entities (tax.model). Every change goes through `Ledger.put`."""

from datetime import date
from decimal import Decimal
from typing import Any
from uuid import UUID

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, YearMonth
from opesvault.domain.money import ZERO, is_cents, to_decimal
from opesvault.investments.model import AssetClass
from opesvault.tax import ids
from opesvault.tax.model import (
    ASSET_GROUPS,
    AssetFiling,
    BucketRule,
    ChecklistMark,
    DeclaredAsset,
    FilingSubject,
    IncomeClassification,
    IncomeDetail,
    IncomeKind,
    IncomeNature,
    IncomeReport,
    MemberTaxInfo,
    NatureSubject,
    PaymentPurpose,
    ReportLine,
    ReportSource,
    TaxIdentity,
    TaxParameters,
    TaxPayment,
    TaxSubject,
    VariableIncomeRules,
    require_year,
)


def _all(ledger: Ledger, kind: str) -> dict[UUID, Any]:
    return ledger.entities(kind)


def _money(value: object, label: str, *, allow_none: bool = True) -> Decimal | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        if allow_none:
            return None
        raise DomainError(f"Informe {label}.")
    amount = value if isinstance(value, Decimal) else to_decimal(value)
    if amount < 0 or not is_cents(amount):
        raise DomainError(f"{label.capitalize()}: informe um valor positivo em reais e centavos.")
    return amount


def _rate(value: object, label: str) -> Decimal | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    rate = value if isinstance(value, Decimal) else to_decimal(value)
    if not ZERO <= rate <= 1:
        raise DomainError(f"{label}: informe uma alíquota entre 0% e 100%.")
    return rate


# ── CPF / CNPJ ──────────────────────────────────


def identities(ledger: Ledger) -> dict[UUID, TaxIdentity]:
    return _all(ledger, "tax_identity")


def identity(ledger: Ledger, subject: TaxSubject, ref: object) -> TaxIdentity | None:
    key = str(ref)
    return next((i for i in identities(ledger).values() if i.subject is subject and i.ref == key), None)


def set_identity(ledger: Ledger, subject: TaxSubject, ref: object, tax_id: str, name: str | None = None) -> TaxIdentity:
    """Records the CPF or CNPJ of a payee (merchant), an institution (account) or a payer (category)."""
    if subject is TaxSubject.ACCOUNT or subject is TaxSubject.CATEGORY:
        if not isinstance(ref, UUID) or ref not in ledger.accounts:
            raise DomainError("Escolha a conta ou a categoria.")
    elif not str(ref).strip():
        raise DomainError("Escolha o estabelecimento.")
    number = ids.normalize(tax_id)
    label = " ".join((name or "").split())[:150] or None
    current = identity(ledger, subject, ref)
    if current is None:
        return ledger.put("tax_identity", TaxIdentity(subject=subject, ref=str(ref), tax_id=number, name=label))
    if current.tax_id == number and current.name == label:
        return current
    return ledger.put(
        "tax_identity", current.model_copy(update={"tax_id": number, "name": label}), reason="CPF/CNPJ alterado"
    )


def clear_identity(ledger: Ledger, subject: TaxSubject, ref: object) -> None:
    current = identity(ledger, subject, ref)
    if current is not None:
        del identities(ledger)[current.id]


# ── people: CPF, birth date, who declares whom ──────────


def member_infos(ledger: Ledger) -> dict[UUID, MemberTaxInfo]:
    return _all(ledger, "member_tax_info")


def member_info(ledger: Ledger, member_id: UUID) -> MemberTaxInfo | None:
    return next((i for i in member_infos(ledger).values() if i.member_id == member_id), None)


def set_member_info(
    ledger: Ledger,
    member_id: UUID,
    *,
    cpf: str | None,
    birth_date: date | None,
    declared_by: UUID | None,
    relation: str | None = None,
) -> MemberTaxInfo:
    if member_id not in ledger.members:
        raise DomainError("Integrante inexistente.")
    number = ids.normalize(cpf, (ids.TaxIdKind.CPF,)) if cpf and cpf.strip() else None
    if declared_by is not None:
        if declared_by not in ledger.members:
            raise DomainError("Escolha quem declara este integrante.")
        if declared_by == member_id:
            declared_by = None
        else:
            above = member_info(ledger, declared_by)
            if above is not None and above.declared_by is not None:
                raise DomainError("Quem declara não pode ser dependente na declaração de outra pessoa.")
            if any(i.declared_by == member_id for i in member_infos(ledger).values()):
                raise DomainError("Este integrante declara outras pessoas; não pode ser dependente.")
    if number is not None:
        other = next((i for i in member_infos(ledger).values() if i.cpf == number and i.member_id != member_id), None)
        if other is not None:
            raise DomainError("Este CPF já pertence a outro integrante.")
    if birth_date is not None and birth_date > date.today():
        raise DomainError("A data de nascimento está no futuro.")
    fields = {
        "cpf": number,
        "birth_date": birth_date,
        "declared_by": declared_by,
        "relation": (relation or "").strip()[:60] or None,
    }
    current = member_info(ledger, member_id)
    if current is None:
        return ledger.put("member_tax_info", MemberTaxInfo(member_id=member_id, **fields))
    updated = current.model_copy(update=fields)
    if updated == current:
        return current
    return ledger.put("member_tax_info", updated, reason="dados fiscais do integrante alterados")


def declarants(ledger: Ledger) -> list[UUID]:
    """Members who file a return: everyone active who is not declared by someone else."""
    dependents = {i.member_id for i in member_infos(ledger).values() if i.declared_by is not None}
    return [
        m.id
        for m in sorted(ledger.members.values(), key=lambda m: m.name.casefold())
        if m.active and m.id not in dependents
    ]


def dependents_of(ledger: Ledger, declarant_id: UUID) -> list[UUID]:
    return [i.member_id for i in member_infos(ledger).values() if i.declared_by == declarant_id]


def people_of(ledger: Ledger, declarant_id: UUID | None) -> set[UUID] | None:
    """The declarant and their dependents; None is the whole project (nobody filtered)."""
    if declarant_id is None:
        return None
    return {declarant_id, *dependents_of(ledger, declarant_id)}


# ── income classification ──────────


def classifications(ledger: Ledger) -> dict[UUID, IncomeClassification]:
    return _all(ledger, "income_classification")


def nature_of(ledger: Ledger, subject: NatureSubject, ref: UUID) -> IncomeNature | None:
    found = next((c for c in classifications(ledger).values() if c.subject is subject and c.ref == ref), None)
    if found is not None:
        return found.nature
    if subject is NatureSubject.CATEGORY:
        account = ledger.accounts.get(ref)
        if account is not None and account.parent_id is not None:  # a subcategory follows its parent
            return nature_of(ledger, subject, account.parent_id)
    return None


def classify(ledger: Ledger, subject: NatureSubject, ref: UUID, nature: IncomeNature | None) -> None:
    if subject is NatureSubject.CATEGORY:
        account = ledger.accounts.get(ref)
        if account is None or account.type is not AccountType.INCOME:
            raise DomainError("Só categorias de receita têm natureza fiscal.")
    else:
        from opesvault.investments.service import positions

        if ref not in positions(ledger):
            raise DomainError("Investimento inexistente.")
    current = next((c for c in classifications(ledger).values() if c.subject is subject and c.ref == ref), None)
    if nature is None:
        if current is not None:
            del classifications(ledger)[current.id]
        return
    nature = IncomeNature(nature)
    if current is None:
        ledger.put("income_classification", IncomeClassification(subject=subject, ref=ref, nature=nature))
    elif current.nature is not nature:
        ledger.put("income_classification", current.model_copy(update={"nature": nature}), reason="natureza alterada")


# ── payslip detail of a deposit ──────────


def income_details(ledger: Ledger) -> dict[UUID, IncomeDetail]:
    return _all(ledger, "income_detail")


def detail_of(ledger: Ledger, operation_id: UUID) -> IncomeDetail | None:
    return next((d for d in income_details(ledger).values() if d.operation_id == operation_id), None)


def received_amount(ledger: Ledger, operation_id: UUID) -> Decimal:
    op = ledger.operations[operation_id]
    return sum((-p.amount for p in op.postings if ledger.account(p.account_id).type is AccountType.INCOME), ZERO)


def set_income_detail(
    ledger: Ledger,
    operation_id: UUID,
    kind: IncomeKind,
    gross: object = None,
    withheld: object = None,
    social_security: object = None,
) -> IncomeDetail | None:
    """Gross, IRRF and INSS of a salary deposit. Empty fields stay unknown, never zero."""
    op = ledger.operations.get(operation_id)
    if op is None or not op.active:
        raise DomainError("Escolha um lançamento ativo.")
    received = received_amount(ledger, operation_id)
    if received <= 0:
        raise DomainError("Só receitas têm detalhamento de rendimento.")
    values = {
        "gross": _money(gross, "o valor bruto"),
        "withheld": _money(withheld, "o imposto retido"),
        "social_security": _money(social_security, "a contribuição ao INSS"),
    }
    if values["gross"] is not None and values["gross"] < received:
        raise DomainError("O bruto não pode ser menor que o valor recebido.")
    current = detail_of(ledger, operation_id)
    if all(v is None for v in values.values()) and IncomeKind(kind) is IncomeKind.SALARY:
        if current is not None:
            del income_details(ledger)[current.id]
        return None
    detail = IncomeDetail(
        operation_id=operation_id,
        kind=IncomeKind(kind),
        gross=values["gross"],
        withheld=values["withheld"],
        social_security=values["social_security"],
    )
    if current is None:
        return ledger.put("income_detail", detail)
    updated = detail.model_copy(update={"id": current.id})
    if updated == current:
        return current
    return ledger.put("income_detail", updated, reason="detalhamento do rendimento alterado")


# ── Bens e Direitos ──────────


def filings(ledger: Ledger) -> dict[UUID, AssetFiling]:
    return _all(ledger, "asset_filing")


def filing_of(ledger: Ledger, subject: FilingSubject, ref: UUID) -> AssetFiling | None:
    return next((f for f in filings(ledger).values() if f.subject is subject and f.ref == ref), None)


def _check_code(group: str, code: str) -> None:
    if group not in ASSET_GROUPS:
        raise DomainError("Escolha o grupo do bem.")
    if len(code) != 2 or not code.isdigit():
        raise DomainError("O código tem dois dígitos (veja a tabela do programa da Receita).")


def set_filing(
    ledger: Ledger, subject: FilingSubject, ref: UUID, group: str, code: str, description: str
) -> AssetFiling:
    _check_code(group, code)
    text = " ".join(description.split())[:512]
    current = filing_of(ledger, subject, ref)
    if current is None:
        return ledger.put(
            "asset_filing", AssetFiling(subject=subject, ref=ref, group=group, code=code, description=text)
        )
    updated = current.model_copy(update={"group": group, "code": code, "description": text})
    if updated == current:
        return current
    return ledger.put("asset_filing", updated, reason="bem alterado")


GROUP_BY_SUBTYPE = {
    AccountSubtype.CHECKING: "06",
    AccountSubtype.CASH: "06",
    AccountSubtype.BROKERAGE_CASH: "06",
    AccountSubtype.SAVINGS: "04",
}
GROUP_BY_CLASS = {
    AssetClass.FIXED_INCOME: "04",
    AssetClass.TREASURY: "04",
    AssetClass.STOCK: "03",
    AssetClass.REIT: "07",
    AssetClass.FUND: "07",
    AssetClass.ETF: "07",
    AssetClass.CRYPTO: "08",
}


def suggested_group(subtype: AccountSubtype | None = None, asset_class: AssetClass | None = None) -> str | None:
    """A starting point for the user to confirm; never filed on its own."""
    if subtype is not None:
        return GROUP_BY_SUBTYPE.get(subtype)
    if asset_class is not None:
        return GROUP_BY_CLASS.get(asset_class)
    return None


def declared_assets(ledger: Ledger) -> dict[UUID, DeclaredAsset]:
    return _all(ledger, "declared_asset")


def save_declared_asset(ledger: Ledger, asset: DeclaredAsset, reason: str | None = None) -> DeclaredAsset:
    _check_code(asset.group, asset.code)
    _money(asset.cost, "o custo de aquisição", allow_none=False)
    if asset.sale_value is not None:
        _money(asset.sale_value, "o valor de venda")
    if asset.sold_on is not None and asset.sold_on < asset.acquired_on:
        raise DomainError("A venda não pode ser antes da aquisição.")
    if asset.owner_id is not None and asset.owner_id not in ledger.members:
        raise DomainError("Escolha o dono do bem.")
    if asset.id in declared_assets(ledger):
        return ledger.put("declared_asset", asset, reason=reason or "bem alterado")
    return ledger.put("declared_asset", asset)


def remove_declared_asset(ledger: Ledger, asset_id: UUID) -> None:
    if asset_id in declared_assets(ledger):
        del declared_assets(ledger)[asset_id]


# ── informes ──────────


def reports(ledger: Ledger) -> dict[UUID, IncomeReport]:
    return _all(ledger, "income_report")


def reports_of(ledger: Ledger, year: int) -> list[IncomeReport]:
    return sorted((r for r in reports(ledger).values() if r.year == year), key=lambda r: (r.source, str(r.source_id)))


def save_report(
    ledger: Ledger,
    year: int,
    source: ReportSource,
    source_id: UUID,
    lines: list[ReportLine],
    *,
    payer_tax_id: str | None = None,
    payer_name: str | None = None,
    document_id: UUID | None = None,
    report_id: UUID | None = None,
    note: str | None = None,
) -> IncomeReport:
    require_year(year)
    account = ledger.accounts.get(source_id)
    if account is None:
        raise DomainError("Escolha de quem é o informe.")
    if source is ReportSource.ACCOUNT and account.type not in (AccountType.ASSET, AccountType.LIABILITY):
        raise DomainError("Escolha a conta do banco ou da corretora.")
    if source is ReportSource.CATEGORY and account.type is not AccountType.INCOME:
        raise DomainError("Escolha a categoria de receita da fonte pagadora.")
    for line in lines:
        if not is_cents(line.amount):
            raise DomainError("Use valores em reais e centavos.")
    number = ids.normalize(payer_tax_id) if payer_tax_id else None
    fields = {
        "year": year,
        "source": source,
        "source_id": source_id,
        "payer_tax_id": number,
        "payer_name": (payer_name or "").strip()[:150] or None,
        "document_id": document_id,
        "lines": tuple(lines),
        "note": (note or "").strip()[:500] or None,
    }
    current = reports(ledger).get(report_id) if report_id is not None else None
    if current is None:
        duplicate = next((r for r in reports_of(ledger, year) if r.source is source and r.source_id == source_id), None)
        if duplicate is not None:
            raise DomainError("Já há um informe desta fonte neste ano; abra-o para corrigir.")
        return ledger.put("income_report", IncomeReport(**fields))
    return ledger.put("income_report", current.model_copy(update=fields), reason="informe corrigido")


def remove_report(ledger: Ledger, report_id: UUID) -> None:
    if report_id in reports(ledger):
        del reports(ledger)[report_id]


# ── parameters informed by the user ──────────


def parameters(ledger: Ledger, year: int) -> TaxParameters | None:
    return next((p for p in _all(ledger, "tax_parameters").values() if p.year == year), None)


def set_parameters(ledger: Ledger, params: TaxParameters) -> TaxParameters:
    require_year(params.year)
    last = None
    for index, bracket in enumerate(params.brackets):
        if bracket.up_to is None and index != len(params.brackets) - 1:
            raise DomainError("Só a última faixa fica sem limite.")
        if bracket.up_to is not None:
            if last is not None and bracket.up_to <= last:
                raise DomainError("Os limites das faixas precisam crescer.")
            last = bracket.up_to
        _rate(bracket.rate, "Alíquota da faixa")
        _money(bracket.deduction, "a parcela a deduzir", allow_none=False)
    _rate(params.simplified_rate, "Desconto simplificado")
    _rate(params.pension_cap_rate, "Limite da previdência privada")
    for value, label in (
        (params.simplified_cap, "o teto do desconto simplificado"),
        (params.dependent_deduction, "a dedução por dependente"),
        (params.education_cap, "o limite de educação"),
    ):
        _money(value, label)
    current = parameters(ledger, params.year)
    if current is None:
        return ledger.put("tax_parameters", params)
    updated = params.model_copy(update={"id": current.id})
    return current if updated == current else ledger.put("tax_parameters", updated, reason="tabela alterada")


def variable_rules(ledger: Ledger, on: date | None = None) -> VariableIncomeRules | None:
    """The rules in force on a date (the most recent `valid_from` not after it)."""
    found = sorted(_all(ledger, "variable_income_rules").values(), key=lambda r: r.valid_from)
    if on is not None:
        found = [r for r in found if r.valid_from <= on]
    return found[-1] if found else None


def set_variable_rules(ledger: Ledger, valid_from: date, rules: list[BucketRule], source: str) -> VariableIncomeRules:
    for rule in rules:
        _rate(rule.rate, "Alíquota")
        _money(rule.exempt_sales_limit, "o limite de vendas isentas")
    current = next((r for r in _all(ledger, "variable_income_rules").values() if r.valid_from == valid_from), None)
    text = (source or "").strip()[:300] or "informado pelo usuário"
    if current is None:
        return ledger.put(
            "variable_income_rules", VariableIncomeRules(valid_from=valid_from, rules=tuple(rules), source=text)
        )
    updated = current.model_copy(update={"rules": tuple(rules), "source": text})
    return current if updated == current else ledger.put("variable_income_rules", updated, reason="regras alteradas")


# ── DARF payments ──────────


def payments(ledger: Ledger) -> dict[UUID, TaxPayment]:
    return _all(ledger, "tax_payment")


def paid(ledger: Ledger, purpose: PaymentPurpose, month: YearMonth, member_id: UUID | None = None) -> Decimal:
    return sum(
        (
            p.amount
            for p in payments(ledger).values()
            if p.purpose is purpose and p.month == month and (member_id is None or p.member_id in (None, member_id))
        ),
        ZERO,
    )


def record_payment(
    ledger: Ledger,
    purpose: PaymentPurpose,
    month: YearMonth,
    amount: object,
    paid_on: date,
    from_account: UUID,
    member_id: UUID | None = None,
) -> TaxPayment:
    """A DARF paid: the money leaves the account as a tax expense and the month is marked as paid."""
    from opesvault.investments.service import TAX_CATEGORY, _category
    from opesvault.tax.model import PURPOSE_LABELS

    value = _money(amount, "o valor pago", allow_none=False)
    assert value is not None
    if value == 0:
        raise DomainError("Informe o valor pago.")
    account = ledger.accounts.get(from_account)
    if account is None or not account.is_liquid:
        raise DomainError("Escolha a conta de onde saiu o pagamento.")
    category = _category(ledger, AccountType.EXPENSE, TAX_CATEGORY)
    op = ledger.record_expense(
        from_account,
        category,
        value,
        paid_on,
        f"{PURPOSE_LABELS[purpose]} — {month.month:02d}/{month.year}",
        member_id=member_id,
    )
    return ledger.put(
        "tax_payment",
        TaxPayment(
            purpose=purpose, month=month, amount=value, paid_on=paid_on, operation_id=op.id, member_id=member_id
        ),
    )


# ── documents checklist ──────────


def marks(ledger: Ledger) -> dict[UUID, ChecklistMark]:
    return _all(ledger, "tax_checklist_mark")


def mark_of(ledger: Ledger, year: int, key: str) -> ChecklistMark | None:
    return next((m for m in marks(ledger).values() if m.year == year and m.key == key), None)


def set_mark(ledger: Ledger, year: int, key: str, received: bool | None, note: str | None = None) -> None:
    """Marks a document of the checklist as received (or not) by hand; None returns to automatic."""
    current = mark_of(ledger, year, key)
    if received is None:
        if current is not None:
            del marks(ledger)[current.id]
        return
    text = (note or "").strip()[:300] or None
    if current is None:
        ledger.put("tax_checklist_mark", ChecklistMark(year=year, key=key, received=received, note=text))
    elif current.received != received or current.note != text:
        ledger.put("tax_checklist_mark", current.model_copy(update={"received": received, "note": text}))
