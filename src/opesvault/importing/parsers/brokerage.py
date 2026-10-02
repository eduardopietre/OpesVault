"""Brokerage notes (notas de negociação) in the B3/SINACOR layout and the NuInvest variant.

Layout knowledge comes from anonymized public notes (docs/12 §3-4). The summary is
printed in two columns, so fee labels are searched anywhere in a line.
"""

import re
from decimal import Decimal

from opesvault.domain.money import ZERO
from opesvault.importing.model import DocFormat, DocType, ItemKind, StatementHeader
from opesvault.importing.parsers.base import ParsedItem, Parser, ParseResult, amount, dmy
from opesvault.importing.source import Source

_NUM = r"-?\d{1,3}(?:\.\d{3})*,\d+"
_TRADE = re.compile(
    r"^(?:1-)?BOVESPA\s+(?P<side>[CV])\s+"
    r"(?P<market>VISTA|FRACIONARIO|TERMO|OPCAO DE COMPRA|OPCAO DE VENDA|EXERC OPC COMPRA|EXERC OPC VENDA|VIS)\s+"
    rf"(?P<spec>.+?)\s+(?P<qty>\d{{1,3}}(?:\.\d{{3}})*)\s+(?P<price>{_NUM})\s+(?P<value>{_NUM})\s+(?P<dc>[DC])$",
    re.IGNORECASE,
)
# (label pattern, key). Values may carry a D/C marker or a leading minus (NuInvest).
_FEES = (
    (r"taxa\s+de\s+liquida[çc][ãa]o", "Taxa de liquidação"),
    (r"taxa\s+de\s+registro", "Taxa de registro"),
    (r"taxa\s+de\s+termo\s*/\s*op[çc][õo]es", "Taxa de termo/opções"),
    (r"taxa\s+a\.n\.a\.", "Taxa A.N.A."),
    (r"emolumentos", "Emolumentos"),
    (r"taxa\s+operacional|corretagem(?!/)", "Corretagem"),
    (r"execu[çc][ãa]o(?!\s+casa)", "Execução"),
    (r"taxa\s+de\s+cust[óo]dia", "Custódia"),
    (r"impostos|\biss\b(?:\s*\([^)]*\))?", "Impostos (ISS)"),
    (r"outr[ao]s", "Outros"),
)
_SPEC_TICKER = re.compile(r"\b([A-Z]{4}\d{1,2})\b")


def _signed(value: str, marker: str | None) -> Decimal:
    """D = debit to the client (negative), C = credit; a leading minus also means debit."""
    number = amount(value)
    if marker == "D":
        return -abs(number)
    if marker == "C":
        return abs(number)
    return number


class SinacorNotePdf(Parser):
    id = "sinacor-nota-pdf"
    version = "1"
    institution = "Corretoras padrão SINACOR (Clear, Rico, XP) e NuInvest"
    product = "Nota de negociação (B3)"
    doc_type = DocType.BROKERAGE_NOTE
    doc_format = DocFormat.PDF
    validated_with_real_documents = True  # anonymized public notes, see docs/12 §4
    limitations = "Mercado à vista, fracionário e opções; futuros (BM&F) não suportados."

    def detect(self, source: Source) -> float:
        if source.format is not DocFormat.PDF:
            return 0.0
        text = source.text
        score = 0.0
        if re.search(r"nota\s+de\s+(negocia[çc][ãa]o|corretagem)|nuinvest", text, re.IGNORECASE):
            score += 0.4
        if re.search(r"resumo\s+financeiro", text, re.IGNORECASE):
            score += 0.2
        if re.search(r"l[íi]quido\s+para", text, re.IGNORECASE):
            score += 0.2
        if any(_TRADE.match(line.text) for line in source.lines):
            score += 0.2
        return min(score, 1.0)

    def parse(self, source: Source) -> ParseResult:
        text = source.text
        header_values: dict[str, object] = {}
        # "4535159 1 02/05/2022" (number, sheet, date) or "... 8242 24/01/2025" (NuInvest).
        number_match = re.search(r"(\d{3,})\s+(?:\d{1,3}\s+)?\d{2}/\d{2}/\d{4}\s*$", text, re.MULTILINE)
        date_match = re.search(r"data\s+preg[ãa]o.*?(\d{2}/\d{2}/\d{4})", text, re.IGNORECASE | re.S)
        net_match = re.search(
            rf"l[íi]quido\s+para\s+(\d{{2}}/\d{{2}}/\d{{4}})\s+({_NUM})\s*([DC])?", text, re.IGNORECASE
        )
        broker = next(
            (
                n
                for n in ("CLEAR", "RICO", "XP INVESTIMENTOS", "NUINVEST", "BTG", "MODAL")
                if n.casefold() in text.casefold()
            ),
            None,
        )
        trade_date = dmy(date_match[1]) if date_match else None
        if number_match:
            header_values["note_number"] = number_match[1]
        result = ParseResult(header=StatementHeader(institution=broker, trade_date=trade_date), items=[])
        if net_match:
            header_values["settlement_date"] = dmy(net_match[1])
            header_values["net_amount"] = _signed(net_match[2], net_match[3])
        trades_net = ZERO
        irrf: Decimal | None = None
        fees: dict[str, tuple[Decimal, object]] = {}
        for line in source.lines:
            trade = _TRADE.match(line.text)
            if trade:
                value = _signed(trade["value"], trade["dc"])
                trades_net += value
                spec = re.sub(r"\s+#\S*$|\s+#$", "", trade["spec"].strip())
                ticker = _SPEC_TICKER.search(spec)
                result.items.append(
                    ParsedItem(
                        kind=ItemKind.TRADE,
                        occurred_on=trade_date,
                        description=f"{'Compra' if trade['side'].upper() == 'C' else 'Venda'} {spec}",
                        amount=abs(value),
                        lines=[line],
                        quantity=Decimal(trade["qty"].replace(".", "")),
                        unit_price=amount(trade["price"]),
                        ticker=ticker[1] if ticker else None,
                    )
                )
                continue
            irrf_match = re.search(
                rf"I\.?R\.?R\.?F\.?\s+s/\s*opera[çc][õo]es.*?({_NUM})\s*([DC])?\s*$", line.text, re.IGNORECASE
            )
            if irrf_match:
                irrf = abs(amount(irrf_match[1]))
                continue
            for pattern, label in _FEES:
                if label in fees:
                    continue
                fee = re.search(rf"(?:{pattern})\s+({_NUM})(?:\s+([DC])\b)?", line.text, re.IGNORECASE)
                if fee:
                    raw = amount(fee[1])
                    # Without a D/C marker a positive fee is a cost to the client.
                    value = _signed(fee[1], fee[2]) if fee[2] or raw < 0 else -raw
                    fees[label] = (value, line)
        fee_total = ZERO
        for label, (value, line) in fees.items():
            if value == 0:
                continue
            fee_total += value
            result.items.append(
                ParsedItem(
                    kind=ItemKind.FEE,
                    occurred_on=trade_date,
                    description=label,
                    amount=abs(value),
                    lines=[line],  # type: ignore[list-item]
                    credit=value > 0,
                )
            )
        header_values["previous_balance"] = None
        result.header = result.header.model_copy(update=header_values)
        computed = trades_net + fee_total
        expected = header_values.get("net_amount")
        if isinstance(expected, Decimal) and computed != expected and irrf is not None and computed - irrf == expected:
            result.warnings.append("O líquido da nota desconta o IRRF retido.")
            result.items.append(
                ParsedItem(
                    kind=ItemKind.FEE,
                    occurred_on=trade_date,
                    description="IRRF retido",
                    amount=irrf,
                    lines=[],
                )
            )
        elif irrf:
            result.warnings.append("IRRF informado na nota, mas não descontado do líquido (informativo).")
        if not result.items:
            result.warnings.append("Nenhum negócio reconhecido nesta nota.")
        return result


def note_computed_net(items: list[ParsedItem]) -> Decimal:
    """Client-side net of a parsed note: sells − buys − costs (+ credits)."""
    total = ZERO
    for item in items:
        if item.amount is None:
            continue
        if item.kind is ItemKind.TRADE:
            total += item.amount if item.description.startswith("Venda") else -item.amount
        elif item.kind is ItemKind.FEE:
            total += item.amount if item.credit else -item.amount
    return total
