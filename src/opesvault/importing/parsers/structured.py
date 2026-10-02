"""Structured exports: OFX (bank and card) and Nubank CSV (docs/05 §3, exportações estruturadas)."""

import re
from datetime import date
from decimal import Decimal, InvalidOperation

from opesvault.importing.model import DocFormat, DocType, ItemKind, StatementHeader
from opesvault.importing.parsers.base import ParsedItem, Parser, ParseResult, dmy
from opesvault.importing.source import Line, Source


def _dot_decimal(text: str) -> Decimal | None:
    """OFX/CSV exports use '.' as decimal separator; reject anything else."""
    cleaned = text.strip().replace(" ", "")
    if not re.fullmatch(r"[-+]?\d+(\.\d+)?", cleaned):
        return None
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        return None


def _ofx_date(text: str | None) -> date | None:
    if not text:
        return None
    match = re.match(r"(\d{4})(\d{2})(\d{2})", text)
    if not match:
        return None
    try:
        return date(int(match[1]), int(match[2]), int(match[3]))
    except ValueError:
        return None


class OfxParser(Parser):
    id = "ofx-generico"
    version = "1"
    institution = "Qualquer (OFX)"
    product = "Conta ou cartão"
    doc_type = DocType.BANK_STATEMENT
    doc_format = DocFormat.OFX
    limitations = "FITID usado como identificador, sem supor unicidade entre arquivos."

    def detect(self, source: Source) -> float:
        return 0.9 if source.ofx is not None else 0.0

    def parse(self, source: Source) -> ParseResult:
        ofx = source.ofx
        assert ofx is not None
        card = ofx.kind == "card"
        balance = _dot_decimal(ofx.ledger_balance) if ofx.ledger_balance else None
        result = ParseResult(
            header=StatementHeader(
                institution=f"banco {ofx.bank_id}" if ofx.bank_id else None,
                account_hint=ofx.account_id,
                period_start=_ofx_date(ofx.start),
                period_end=_ofx_date(ofx.end),
                closing_balance=(-balance if card and balance is not None else balance),
            ),
            items=[],
        )
        if ofx.currency and ofx.currency.upper() != "BRL":
            result.warnings.append(f"Moeda {ofx.currency} exige câmbio informado.")
        for trn in ofx.transactions:
            value = _dot_decimal(trn.fields.get("TRNAMT", ""))
            description = trn.fields.get("MEMO") or trn.fields.get("NAME") or "(sem descrição)"
            line = Line(page=0, text=" | ".join(f"{k}={v}" for k, v in trn.fields.items())[:2000], number=trn.line)
            item = ParsedItem(
                kind=ItemKind.CREDIT,
                occurred_on=_ofx_date(trn.fields.get("DTPOSTED")),
                description=description,
                amount=abs(value) if value is not None else None,
                lines=[line],
                bank_id=trn.fields.get("FITID"),
            )
            if value is None:
                item.warnings.append("Valor ausente ou inválido.")
            elif card:
                # On card statements, negative amounts are charges and positive ones credits/payments.
                upper = description.upper()
                if value < 0:
                    item.kind = (
                        ItemKind.CARD_CHARGE
                        if re.search(r"\b(IOF|JUROS|MULTA|ANUIDADE)\b", upper)
                        else ItemKind.PURCHASE
                    )
                else:
                    item.kind = ItemKind.CARD_PAYMENT if re.search(r"PAGAMENTO|PAGTO", upper) else ItemKind.CARD_CREDIT
            else:
                item.kind = ItemKind.CREDIT if value > 0 else ItemKind.DEBIT
            if item.occurred_on is None:
                item.warnings.append("Data ausente ou inválida.")
            result.items.append(item)
        return result


class _NubankCsv(Parser):
    institution = "Nubank"
    doc_format = DocFormat.CSV
    _HEADER: tuple[str, ...] = ()

    def _header_row(self, source: Source) -> list[str] | None:
        if not source.rows:
            return None
        return [c.casefold() for c in source.rows[0][1]]

    def detect(self, source: Source) -> float:
        if source.format is not DocFormat.CSV:
            return 0.0
        header = self._header_row(source)
        if header is None:
            return 0.0
        return 0.9 if all(h in header for h in self._HEADER) else 0.0


class NubankCardCsv(_NubankCsv):
    id = "nubank-cartao-csv"
    version = "1"
    product = "Cartão de crédito"
    doc_type = DocType.CARD_STATEMENT
    limitations = "Colunas date,title,amount (category opcional); valores negativos são pagamentos/créditos."
    _HEADER = ("date", "title", "amount")

    def parse(self, source: Source) -> ParseResult:
        header = self._header_row(source) or []
        index = {name: header.index(name) for name in ("date", "title", "amount")}
        result = ParseResult(header=StatementHeader(institution=self.institution), items=[])
        for number, cells in source.rows[1:]:
            line = Line(page=0, text=",".join(cells), number=number)
            try:
                raw_date, title, raw_amount = (cells[index["date"]], cells[index["title"]], cells[index["amount"]])
            except IndexError:
                result.unmapped.append(line)
                continue
            value = _dot_decimal(raw_amount)
            when = date.fromisoformat(raw_date) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw_date) else None
            if value is None or value == 0:
                result.unmapped.append(line)
                continue
            from opesvault.importing.parsers.cards import _classify, _split_installment

            description, installment = _split_installment(title)
            item = ParsedItem(
                kind=_classify(description, value < 0),
                occurred_on=when,
                description=description,
                amount=abs(value),
                lines=[line],
                installment=installment,
            )
            if when is None:
                item.warnings.append("Data inválida.")
            result.items.append(item)
        return result


class NubankAccountCsv(_NubankCsv):
    id = "nubank-conta-csv"
    version = "1"
    product = "Conta"
    doc_type = DocType.BANK_STATEMENT
    limitations = "Colunas Data,Valor,Identificador,Descrição; o identificador é usado contra duplicatas."
    _HEADER = ("data", "valor", "identificador", "descrição")

    def parse(self, source: Source) -> ParseResult:
        header = self._header_row(source) or []
        index = {name: header.index(name) for name in self._HEADER}
        result = ParseResult(header=StatementHeader(institution=self.institution), items=[])
        for number, cells in source.rows[1:]:
            line = Line(page=0, text=",".join(cells), number=number)
            try:
                raw_date = cells[index["data"]]
                value = _dot_decimal(cells[index["valor"]])
                identifier = cells[index["identificador"]] or None
                description = cells[index["descrição"]]
            except IndexError:
                result.unmapped.append(line)
                continue
            if value is None or value == 0:
                result.unmapped.append(line)
                continue
            when = dmy(raw_date)
            item = ParsedItem(
                kind=ItemKind.CREDIT if value > 0 else ItemKind.DEBIT,
                occurred_on=when,
                description=description,
                amount=abs(value),
                lines=[line],
                bank_id=identifier,
            )
            if when is None:
                item.warnings.append("Data inválida.")
            result.items.append(item)
        return result
