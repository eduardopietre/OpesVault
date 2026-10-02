"""Credit card statement (fatura) parsers.

Layouts follow the public descriptions gathered in docs/12 §3 and are marked as
not yet validated with real documents. Each one records what it ignores.
"""

import re
from datetime import date
from decimal import Decimal

from opesvault.domain.money import ZERO
from opesvault.importing.model import DocFormat, DocType, ItemKind, StatementHeader
from opesvault.importing.parsers.base import (
    AMOUNT_RE,
    MONTHS_PT,
    ParsedItem,
    Parser,
    ParseResult,
    amount,
    contains_all,
    dmy,
    resolve_year,
)
from opesvault.importing.source import Line, Source

_INSTALLMENT = re.compile(r"\s*(?:-\s*)?(?:Parcela\s+)?(\d{1,2})/(\d{1,2})\s*$", re.IGNORECASE)
_PAYMENT_WORDS = ("PAGAMENTO", "PAGTO", "PGTO")
_CHARGE_WORDS = ("IOF", "JUROS", "MULTA", "ENCARGO", "TARIFA", "ANUIDADE")


def _split_installment(description: str) -> tuple[str, tuple[int, int] | None]:
    match = _INSTALLMENT.search(description)
    if not match:
        return description.strip(), None
    number, total = int(match[1]), int(match[2])
    if not 1 <= number <= total <= 99:
        return description.strip(), None
    return description[: match.start()].strip(" -"), (number, total)


def _classify(description: str, negative: bool) -> ItemKind:
    upper = description.upper()
    if negative:
        return ItemKind.CARD_PAYMENT if any(w in upper for w in _PAYMENT_WORDS) else ItemKind.CARD_CREDIT
    if any(re.search(rf"\b{w}\b", upper) for w in _CHARGE_WORDS):
        return ItemKind.CARD_CHARGE
    return ItemKind.PURCHASE


def card_reconciliation_total(items: list[ParsedItem], previous: Decimal | None) -> Decimal:
    """Bill total = previous balance + charges − credits − payments."""
    total = previous or ZERO
    for item in items:
        if item.amount is None:
            continue
        if item.kind in (ItemKind.PURCHASE, ItemKind.CARD_CHARGE):
            total += item.amount
        elif item.kind in (ItemKind.CARD_CREDIT, ItemKind.CARD_PAYMENT):
            total -= item.amount
    return total


class NubankCardPdf(Parser):
    id = "nubank-cartao-pdf"
    version = "1"
    institution = "Nubank"
    product = "Cartão de crédito"
    doc_type = DocType.CARD_STATEMENT
    doc_format = DocFormat.PDF
    limitations = "Layout sintético; compras internacionais com cotação em linha separada; ano vem do cabeçalho."

    _HEADER = re.compile(r"FATURA\s+(\d{1,2})\s+([A-Z]{3})\s+(\d{4})", re.IGNORECASE)
    _PERIOD = re.compile(r"TRANSA[ÇC][ÕO]ES\s+DE\s+(\d{1,2})\s+([A-Z]{3})\s+A\s+(\d{1,2})\s+([A-Z]{3})", re.IGNORECASE)
    _LINE = re.compile(rf"^(\d{{1,2}})\s+([A-Z]{{3}})\s+(.+?)\s+({AMOUNT_RE})$", re.IGNORECASE)
    _FOREIGN = re.compile(r"^(\d{1,2})\s+([A-Z]{3})\s+(.+?)\s+(USD|EUR|GBP)\s+([\d.,]+)$", re.IGNORECASE)

    def detect(self, source: Source) -> float:
        if source.format is not DocFormat.PDF:
            return 0.0
        text = source.text
        score = 0.0
        if contains_all(text, "Nu Pagamentos"):
            score += 0.6
        if self._HEADER.search(text):
            score += 0.2
        if self._PERIOD.search(text):
            score += 0.2
        return min(score, 1.0)

    def parse(self, source: Source) -> ParseResult:
        text = source.text
        header_match = self._HEADER.search(text)
        due = None
        if header_match and header_match[2].upper() in MONTHS_PT:
            due = date(int(header_match[3]), MONTHS_PT[header_match[2].upper()], int(header_match[1]))
        period = self._PERIOD.search(text)
        closing = None
        if period and due and period[4].upper() in MONTHS_PT:
            closing = resolve_year(int(period[3]), MONTHS_PT[period[4].upper()], due)
        reference = closing or due
        result = ParseResult(
            header=StatementHeader(institution=self.institution, due_on=due, closing_on=closing),
            items=[],
        )
        if reference is None:
            result.warnings.append("Data da fatura não encontrada; datas das transações ficaram desconhecidas.")
        total = previous = None
        in_transactions = False
        pending_foreign: ParsedItem | None = None
        for line in source.lines:
            t = line.text
            low = t.casefold()
            if low.startswith("total a pagar"):
                total = amount(t.split()[-1] if "R$" not in t else t[t.index("R$") :])
                continue
            if low.startswith("saldo anterior"):
                previous = amount(t[t.index("R$") :] if "R$" in t else t.split()[-1])
                continue
            if self._PERIOD.search(t):
                in_transactions = True
                continue
            if not in_transactions:
                continue
            if pending_foreign is not None and re.fullmatch(r"R\$\s*[\d.,]+", t):
                pending_foreign.amount = amount(t)
                pending_foreign.lines.append(line)
                result.items.append(pending_foreign)
                pending_foreign = None
                continue
            if t.upper().startswith(("COTAÇÃO", "CONVERSÃO", "COTACAO", "CONVERSAO")) and pending_foreign:
                pending_foreign.lines.append(line)
                continue
            foreign = self._FOREIGN.match(t)
            if foreign:
                when = self._date(foreign[1], foreign[2], reference)
                pending_foreign = ParsedItem(
                    kind=ItemKind.PURCHASE,
                    occurred_on=when,
                    description=foreign[3].strip(),
                    amount=None,
                    lines=[line],
                    foreign_currency=foreign[4].upper(),
                    foreign_amount=amount(foreign[5]),
                )
                continue
            match = self._LINE.match(t)
            if not match:
                if t.strip():
                    result.unmapped.append(line)
                continue
            raw_amount = match[4]
            value = amount(raw_amount)
            negative = value < 0
            description, installment = _split_installment(match[3])
            if value == 0:
                result.unmapped.append(line)  # "Saldo restante" style informative lines
                continue
            kind = _classify(description, negative)
            result.items.append(
                ParsedItem(
                    kind=kind,
                    occurred_on=self._date(match[1], match[2], reference),
                    description=description,
                    amount=abs(value),
                    lines=[line],
                    installment=installment,
                )
            )
        if pending_foreign is not None:
            pending_foreign.warnings.append("Valor em reais da compra internacional não encontrado.")
            result.items.append(pending_foreign)
        result.header = result.header.model_copy(update={"total": total, "previous_balance": previous})
        return result

    def _date(self, day: str, month: str, reference: date | None) -> date | None:
        number = MONTHS_PT.get(month.upper())
        if number is None or reference is None:
            return None
        return resolve_year(int(day), number, reference)


class _SlashCardParser(Parser):
    """Shared logic for layouts with 'DD/MM DESCRIPTION VALUE' lines."""

    doc_type = DocType.CARD_STATEMENT
    doc_format = DocFormat.PDF
    _LINE = re.compile(rf"^(\d{{2}})/(\d{{2}})\s+(.+?)\s+({AMOUNT_RE})$")
    _STOP_SECTIONS: tuple[str, ...] = ()
    _CARD_HEADER = re.compile(r"final\s+(\d{4})", re.IGNORECASE)
    _SKIP_PREFIXES: tuple[str, ...] = ()

    def _header(self, text: str) -> tuple[date | None, date | None, Decimal | None, Decimal | None]:
        due = closing = None
        total = previous = None
        for label, target in (("vencimento", "due"), ("fechamento", "closing")):
            match = re.search(rf"{label}\D{{0,20}}(\d{{2}}/\d{{2}}/\d{{4}})", text, re.IGNORECASE)
            if match:
                if target == "due":
                    due = dmy(match[1])
                else:
                    closing = dmy(match[1])
        match = re.search(rf"total\s+(?:desta|da)\s+fatura\D{{0,10}}({AMOUNT_RE})", text, re.IGNORECASE)
        if match:
            total = amount(match[1])
        match = re.search(rf"(?:saldo|fatura)\s+anterior\D{{0,10}}({AMOUNT_RE})", text, re.IGNORECASE)
        if match:
            previous = amount(match[1])
        return due, closing, total, previous

    def parse(self, source: Source) -> ParseResult:
        due, closing, total, previous = self._header(source.text)
        reference = closing or due
        result = ParseResult(
            header=StatementHeader(
                institution=self.institution, due_on=due, closing_on=closing, total=total, previous_balance=previous
            ),
            items=[],
        )
        if reference is None:
            result.warnings.append("Data de fechamento/vencimento não encontrada; datas ficaram desconhecidas.")
        card_last4: str | None = None
        stopped = False
        for line in source.lines:
            t = line.text
            low = t.casefold()
            if any(low.startswith(s) for s in self._STOP_SECTIONS):
                stopped = True  # e.g. "próximas faturas" repeats future installments
                continue
            card = self._CARD_HEADER.search(t)
            if card and not self._LINE.match(t):
                card_last4 = card[1]
                stopped = False
                continue
            if stopped or any(low.startswith(p) for p in self._SKIP_PREFIXES):
                continue
            extra = self._extra_item(line, reference)
            if extra is not None:
                result.items.append(extra)
                continue
            match = self._LINE.match(t)
            if not match:
                continue
            value = amount(match[4])
            description, installment = _split_installment(match[3])
            occurred = resolve_year(int(match[1]), int(match[2]), reference) if reference else None
            result.items.append(
                ParsedItem(
                    kind=_classify(description, value < 0),
                    occurred_on=occurred,
                    description=description,
                    amount=abs(value),
                    lines=[line],
                    installment=installment,
                    card_last4=card_last4,
                )
            )
        mapped = {id(item_line) for item in result.items for item_line in item.lines}
        result.unmapped = [line for line in source.lines if id(line) not in mapped and self._LINE.match(line.text)]
        return result

    def _extra_item(self, line: Line, reference: date | None) -> ParsedItem | None:
        return None


class ItauCardPdf(_SlashCardParser):
    id = "itau-cartao-pdf"
    version = "1"
    institution = "Itaú"
    product = "Cartão de crédito"
    limitations = "Layout sintético; a seção de próximas faturas é ignorada; IOF lido do resumo."
    _STOP_SECTIONS = ("compras parceladas - próximas faturas", "próximas faturas", "proximas faturas")
    _SKIP_PREFIXES = ("total", "limite")
    _IOF = re.compile(rf"repasse\s+de\s+iof\D{{0,10}}({AMOUNT_RE})", re.IGNORECASE)

    def detect(self, source: Source) -> float:
        if source.format is not DocFormat.PDF:
            return 0.0
        text = source.text
        score = 0.0
        if re.search(r"ita[uú]\s*unibanco", text, re.IGNORECASE):
            score += 0.6
        if re.search(r"total\s+desta\s+fatura", text, re.IGNORECASE):
            score += 0.3
        if re.search(r"vencimento", text, re.IGNORECASE):
            score += 0.1
        return min(score, 1.0)

    def _extra_item(self, line: Line, reference: date | None) -> ParsedItem | None:
        match = self._IOF.search(line.text)
        if not match:
            return None
        return ParsedItem(
            kind=ItemKind.CARD_CHARGE,
            occurred_on=reference,
            description="Repasse de IOF",
            amount=abs(amount(match[1])),
            lines=[line],
            warnings=["IOF informado só no resumo; data assumida = fechamento da fatura."],
        )


class BradescoCardPdf(_SlashCardParser):
    id = "bradesco-cartao-pdf"
    version = "1"
    institution = "Bradesco"
    product = "Cartão de crédito"
    limitations = "Layout sintético; subtotais por portador ignorados; pagamentos com sufixo '-'."
    _SKIP_PREFIXES = ("total para", "subtotal", "total da fatura")

    def detect(self, source: Source) -> float:
        if source.format is not DocFormat.PDF:
            return 0.0
        text = source.text
        score = 0.0
        if re.search(r"bradesco\s+cart[õo]es|banco\s+bradesco", text, re.IGNORECASE):
            score += 0.7
        if re.search(r"total\s+da\s+fatura", text, re.IGNORECASE):
            score += 0.3
        return min(score, 1.0)
