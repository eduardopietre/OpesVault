"""Informes de rendimentos: reading one and checking it against what was recorded.

The reader is generic and conservative: it looks for the calendar year, the payer's CNPJ and
lines that end in an amount and name a known field ("Saldo em 31/12/2025", "Imposto retido",
"Rendimentos isentos"...). Anything else stays out and is listed, never guessed. Layouts
were not validated with real documents yet (docs/15 §2): every line read is shown for review
before it is saved. Like the parsers, the text is data, never instructions.
"""

import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from uuid import UUID

from opesvault.domain import queries
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType
from opesvault.domain.money import ZERO, MoneyError, parse_brl
from opesvault.importing.rules import normalize
from opesvault.tax import ids, records
from opesvault.tax.model import IncomeKind, IncomeReport, ReportField, ReportLine, ReportSource

VERSION = "informe-generico v1"
LIMITATIONS = "Leitura genérica de informes; não validada com documentos reais. Confira cada linha."
MAX_LINES = 400

_AMOUNT = re.compile(r"(-?\s*R?\$?\s*-?\d{1,3}(?:\.\d{3})*,\d{2})\s*$")
_YEAR = re.compile(r"ANO[- ]CALENDARIO\s*(?:DE)?\s*:?\s*(\d{4})")
_EXERCISE = re.compile(r"EXERCICIO\s*(?:DE)?\s*:?\s*(\d{4})")
_BALANCE = re.compile(r"SALDO\s+(?:EM|DE|NO DIA|ATE)\s+31/12/(\d{4})")


@dataclass
class ParsedReport:
    year: int | None
    payer_tax_id: str | None
    payer_name: str | None
    lines: list[ReportLine] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # lines with an amount that matched no field


def _field(text: str, year: int | None) -> ReportField | None:
    balance = _BALANCE.search(text)
    if balance is not None:
        found = int(balance.group(1))
        if year is not None and found == year - 1:
            return ReportField.BALANCE_PREVIOUS
        return ReportField.BALANCE_END
    if "SALDO" in text and "31/12" in text:
        return ReportField.BALANCE_PREVIOUS if "ANTERIOR" in text else ReportField.BALANCE_END
    if "PREVIDENCIA" in text and ("OFICIAL" in text or "CONTRIBUICAO" in text):
        return ReportField.SOCIAL_SECURITY
    thirteenth = "13O SALARIO" in text or "13 SALARIO" in text or "DECIMO TERCEIRO" in text
    if thirteenth:
        return None if "IMPOSTO" in text or "IRRF" in text else ReportField.THIRTEENTH
    if ("IMPOSTO" in text and "RETIDO" in text) or "IRRF" in text:
        return ReportField.WITHHELD
    if "TRIBUTACAO EXCLUSIVA" in text or "TRIBUTACAO DEFINITIVA" in text:
        return ReportField.EXCLUSIVE
    if "ISENTO" in text or "ISENTOS" in text or "NAO TRIBUTAVE" in text:
        return ReportField.EXEMPT
    if "RENDIMENTOS TRIBUTAVEIS" in text or "TOTAL DOS RENDIMENTOS" in text:
        return ReportField.TAXABLE
    return None


def parse(lines: list[str]) -> ParsedReport:
    """Reads the text lines of an informe. Never raises on bad input: what is unclear is skipped."""
    lines = [line for line in lines[:MAX_LINES] if isinstance(line, str)]
    year: int | None = None
    payer_tax_id: str | None = None
    payer_name: str | None = None
    for raw in lines:
        text = normalize(raw)
        if year is None:
            match = _YEAR.search(text)
            if match is not None:
                year = int(match.group(1))
            else:
                exercise = _EXERCISE.search(text)
                if exercise is not None:
                    year = int(exercise.group(1)) - 1
        if payer_tax_id is None and "CNPJ" in text:
            payer_tax_id = ids.find_cnpj(raw)
            if payer_tax_id is not None:
                before = re.split(r"(?i)\s*[-–,]?\s*CNPJ", raw)[0].strip(" :-–")
                payer_name = before[:150] or None
    out = ParsedReport(year if year and 1990 <= year <= 2999 else None, payer_tax_id, payer_name)
    found: dict[ReportField, list[tuple[bool, ReportLine]]] = {}
    section: ReportField | None = None  # informes list items under a heading ("Rendimentos isentos")
    for raw in lines:
        text = normalize(raw)
        match = _AMOUNT.search(raw.strip())
        if match is None:
            if len(text) < 120:
                heading = _field(text, out.year)
                if heading is not None or re.match(r"^\d+\s*[.)-]", text):  # a numbered heading ends the last one
                    section = heading
            continue
        if "CNPJ" in text or "CPF" in text:
            continue
        try:
            amount = parse_brl(match.group(1).replace(" ", ""))
        except MoneyError:
            continue
        kind = _field(text, out.year) or section
        if kind is None:
            out.skipped.append(raw.strip()[:200])
            continue
        is_total = "TOTAL" in text
        found.setdefault(kind, []).append(
            (is_total, ReportLine(field=kind, amount=abs(amount), label=raw.strip()[:200]))
        )
    for entries in found.values():
        totals = [line for is_total, line in entries if is_total]
        out.lines.extend(totals or [line for _, line in entries])
    return out


def read(data: bytes, password: str | None = None) -> ParsedReport:
    """Text of a PDF (or a text file) to a parsed informe. Runs off the UI thread."""
    from opesvault.importing.source import load_source

    source = load_source("informe", data, password)
    if source.lines:
        return parse([line.text for line in source.lines])
    return parse([" ".join(cells) for _, cells in source.rows])


# ── comparison with what was recorded ──────────


@dataclass(frozen=True)
class Check:
    field: ReportField
    informed: Decimal
    recorded: Decimal | None  # None: the app has no figure for this field
    note: str = ""

    @property
    def difference(self) -> Decimal | None:
        return None if self.recorded is None else self.informed - self.recorded

    @property
    def matches(self) -> bool:
        return self.recorded is not None and abs(self.informed - self.recorded) <= Decimal("0.01")


def totals(report: IncomeReport) -> dict[ReportField, Decimal]:
    out: dict[ReportField, Decimal] = {}
    for line in report.lines:
        out[line.field] = out.get(line.field, ZERO) + line.amount
    return out


def recorded(ledger: Ledger, report: IncomeReport) -> dict[ReportField, Decimal]:
    """What the app has for the same source and year, field by field."""
    year = report.year
    out: dict[ReportField, Decimal] = {}
    if report.source is ReportSource.ACCOUNT:
        account = ledger.account(report.source_id)
        out[ReportField.BALANCE_END] = queries.balance(ledger, account.id, date(year, 12, 31))
        out[ReportField.BALANCE_PREVIOUS] = queries.balance(ledger, account.id, date(year - 1, 12, 31))
        out.update(_account_income(ledger, report.source_id, year))
        return out
    taxable = thirteenth = withheld = social = ZERO
    for op in ledger.active_operations():
        when = op.cash_date
        if when is None or when.year != year:
            continue
        value = sum(
            (
                -p.amount
                for p in op.postings
                if p.account_id == report.source_id or _under(ledger, p.account_id, report.source_id)
            ),
            ZERO,
        )
        if not value:
            continue
        detail = records.detail_of(ledger, op.id)
        gross = detail.gross if detail is not None and detail.gross is not None else value
        if detail is not None and detail.kind is IncomeKind.THIRTEENTH:
            thirteenth += gross
            continue
        taxable += gross
        if detail is not None:
            withheld += detail.withheld or ZERO
            social += detail.social_security or ZERO
    out[ReportField.TAXABLE] = taxable
    out[ReportField.THIRTEENTH] = thirteenth
    out[ReportField.WITHHELD] = withheld
    out[ReportField.SOCIAL_SECURITY] = social
    return out


def _under(ledger: Ledger, account_id: UUID, parent_id: UUID) -> bool:
    account = ledger.accounts.get(account_id)
    return account is not None and account.parent_id == parent_id and account.type is AccountType.INCOME


def _account_income(ledger: Ledger, account_id: UUID, year: int) -> dict[ReportField, Decimal]:
    """Investment income credited to this account (proventos, redemption gains) and tax withheld."""
    from opesvault.investments.model import EventKind
    from opesvault.investments.service import events, positions
    from opesvault.tax.model import IncomeNature, NatureSubject

    held = {p.id for p in positions(ledger).values() if p.account_id == account_id}
    withheld = exempt = exclusive = ZERO
    seen = False
    for event in events(ledger).values():
        if event.on.year != year or (event.cash_account_id != account_id and event.position_id not in held):
            continue
        seen = True
        withheld += event.tax_withheld
        nature = records.nature_of(ledger, NatureSubject.POSITION, event.position_id)
        if event.kind is EventKind.DISTRIBUTION:
            value = event.gross if event.gross is not None else (event.net or ZERO)
        elif event.kind in (EventKind.WITHDRAWAL, EventKind.SELL):
            value = max(event.realized_gain or ZERO, ZERO)
        else:
            continue
        if nature is IncomeNature.EXEMPT:
            exempt += value
        elif nature is IncomeNature.EXCLUSIVE:
            exclusive += value
    if not seen:
        return {}
    return {ReportField.WITHHELD: withheld, ReportField.EXEMPT: exempt, ReportField.EXCLUSIVE: exclusive}


def check(ledger: Ledger, report: IncomeReport) -> list[Check]:
    informed = totals(report)
    have = recorded(ledger, report)
    return [Check(kind, value, have.get(kind)) for kind, value in informed.items()]


def differences(ledger: Ledger, report: IncomeReport) -> list[Check]:
    return [c for c in check(ledger, report) if c.recorded is not None and not c.matches]
