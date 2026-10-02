"""Bank account statement (extrato) parsers."""

import re
from decimal import Decimal

from opesvault.importing.model import DocFormat, DocType, ItemKind, StatementHeader
from opesvault.importing.parsers.base import AMOUNT_RE, ParsedItem, Parser, ParseResult, amount, dmy
from opesvault.importing.source import Source


class ItauBankPdf(Parser):
    id = "itau-extrato-pdf"
    version = "1"
    institution = "Itaú"
    product = "Conta corrente"
    doc_type = DocType.BANK_STATEMENT
    doc_format = DocFormat.PDF
    limitations = "Layout sintético; linhas 'SALDO DO DIA' são informativas; saldo final usado na conciliação."

    _LINE = re.compile(rf"^(\d{{2}}/\d{{2}}/\d{{4}})\s+(.+?)\s+({AMOUNT_RE})(?:\s+({AMOUNT_RE}))?$")
    _PERIOD = re.compile(r"per[íi]odo\D{0,10}(\d{2}/\d{2}/\d{4})\s+a\s+(\d{2}/\d{2}/\d{4})", re.IGNORECASE)
    _ACCOUNT = re.compile(r"ag[êe]ncia\D{0,5}(\d{4})\D{0,20}conta\D{0,5}([\d.-]+)", re.IGNORECASE)

    def detect(self, source: Source) -> float:
        if source.format is not DocFormat.PDF:
            return 0.0
        text = source.text
        score = 0.0
        if re.search(r"ita[uú]", text, re.IGNORECASE):
            score += 0.3
        if re.search(r"\bextrato\b", text, re.IGNORECASE):
            score += 0.3
        if self._PERIOD.search(text):
            score += 0.2
        if re.search(r"saldo\s+anterior", text, re.IGNORECASE):
            score += 0.2
        return min(score, 1.0)

    def parse(self, source: Source) -> ParseResult:
        text = source.text
        period = self._PERIOD.search(text)
        account = self._ACCOUNT.search(text)
        result = ParseResult(
            header=StatementHeader(
                institution=self.institution,
                period_start=dmy(period[1]) if period else None,
                period_end=dmy(period[2]) if period else None,
                account_hint=f"ag {account[1]} cc {account[2]}" if account else None,
            ),
            items=[],
        )
        opening: Decimal | None = None
        closing: Decimal | None = None
        for line in source.lines:
            match = self._LINE.match(line.text)
            if not match:
                saldo = re.search(rf"saldo\s+anterior\D{{0,10}}({AMOUNT_RE})", line.text, re.IGNORECASE)
                if saldo:
                    opening = amount(saldo[1])
                continue
            description = match[2].strip()
            upper = description.upper()
            value = amount(match[3])
            if "SALDO ANTERIOR" in upper:
                opening = value
                continue
            if upper.startswith("SALDO"):
                closing = value  # SALDO DO DIA / SALDO FINAL: informative, last one wins
                continue
            when = dmy(match[1])
            item = ParsedItem(
                kind=ItemKind.CREDIT if value > 0 else ItemKind.DEBIT,
                occurred_on=when,
                description=description,
                amount=abs(value),
                lines=[line],
            )
            if when is None:
                item.warnings.append("Data impossível no documento.")
            if match[4]:
                closing = amount(match[4])
            result.items.append(item)
        result.header = result.header.model_copy(update={"opening_balance": opening, "closing_balance": closing})
        return result
