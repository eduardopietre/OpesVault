"""Parser catalog (docs/05 §1): support is declared per layout, never per bank name."""

from opesvault.importing.parsers.bank import ItauBankPdf
from opesvault.importing.parsers.base import Parser
from opesvault.importing.parsers.brokerage import SinacorNotePdf
from opesvault.importing.parsers.cards import BradescoCardPdf, ItauCardPdf, NubankCardPdf
from opesvault.importing.parsers.structured import NubankAccountCsv, NubankCardCsv, OfxParser

PARSERS: tuple[Parser, ...] = (
    NubankCardPdf(),
    ItauCardPdf(),
    BradescoCardPdf(),
    ItauBankPdf(),
    SinacorNotePdf(),
    OfxParser(),
    NubankCardCsv(),
    NubankAccountCsv(),
)

DETECTION_THRESHOLD = 0.6
AMBIGUITY_MARGIN = 0.15


def parser_by_id(parser_id: str) -> Parser:
    for parser in PARSERS:
        if parser.id == parser_id:
            return parser
    raise KeyError(parser_id)
