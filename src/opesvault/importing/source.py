"""Turn document bytes into parser input: PDF lines with geometry, CSV rows or OFX records.

Everything stays in memory (docs/03 §6). PDF passwords are used once and never stored.
"""

import csv
import io
import re
from dataclasses import dataclass, field
from enum import StrEnum

from opesvault.importing.model import DocFormat

MAX_DOCUMENT_BYTES = 50 * 1024 * 1024
MAX_PAGES = 300


class SourceProblem(StrEnum):
    TOO_LARGE = "too_large"
    UNKNOWN_FORMAT = "unknown_format"
    PASSWORD_REQUIRED = "password_required"
    WRONG_PASSWORD = "wrong_password"
    INVALID = "invalid"
    NO_TEXT = "no_text"  # scanned: OCR is a planned expansion (docs/00 §5)
    TOO_MANY_PAGES = "too_many_pages"


PROBLEM_MESSAGES = {
    SourceProblem.TOO_LARGE: "Arquivo grande demais para importar.",
    SourceProblem.UNKNOWN_FORMAT: "Formato não reconhecido (aceitos: PDF, CSV, OFX).",
    SourceProblem.PASSWORD_REQUIRED: "PDF protegido por senha.",
    SourceProblem.WRONG_PASSWORD: "Senha do PDF incorreta.",
    SourceProblem.INVALID: "Arquivo corrompido ou inválido.",
    SourceProblem.NO_TEXT: "PDF sem texto selecionável (provavelmente escaneado). OCR ainda não é suportado.",
    SourceProblem.TOO_MANY_PAGES: "PDF com páginas demais para importar.",
}


class SourceError(Exception):
    def __init__(self, problem: SourceProblem) -> None:
        super().__init__(problem.value)
        self.problem = problem


@dataclass(frozen=True)
class Line:
    page: int  # 1-based
    text: str
    bbox: tuple[float, float, float, float] | None = None
    number: int | None = None  # 1-based line number for text formats


@dataclass
class OfxTransaction:
    line: int
    fields: dict[str, str]


@dataclass
class OfxData:
    kind: str  # "bank" or "card"
    account_id: str | None
    bank_id: str | None
    currency: str | None
    ledger_balance: str | None
    ledger_balance_date: str | None
    start: str | None
    end: str | None
    transactions: list[OfxTransaction] = field(default_factory=list)


@dataclass
class Source:
    name: str
    format: DocFormat
    lines: list[Line] = field(default_factory=list)
    rows: list[tuple[int, list[str]]] = field(default_factory=list)  # (line number, cells) for CSV
    ofx: OfxData | None = None
    pages: int = 0
    producer: str | None = None

    @property
    def text(self) -> str:
        return "\n".join(line.text for line in self.lines)


def detect_format(data: bytes) -> DocFormat:
    head = data[:2048].lstrip(b"\xef\xbb\xbf \r\n\t")
    if head.startswith(b"%PDF"):
        return DocFormat.PDF
    upper = head.upper()
    if b"OFXHEADER" in upper or b"<OFX>" in upper or b"<?OFX" in upper:
        return DocFormat.OFX
    try:
        decode_text(data)
    except UnicodeDecodeError:
        raise SourceError(SourceProblem.UNKNOWN_FORMAT) from None
    return DocFormat.CSV


def decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise UnicodeDecodeError("text", data, 0, 1, "undecodable")


def load_source(name: str, data: bytes, password: str | None = None) -> Source:
    if len(data) > MAX_DOCUMENT_BYTES:
        raise SourceError(SourceProblem.TOO_LARGE)
    fmt = detect_format(data)
    if fmt is DocFormat.PDF:
        return _load_pdf(name, data, password)
    if fmt is DocFormat.OFX:
        return Source(name=name, format=fmt, ofx=parse_ofx(decode_text(data)))
    return _load_csv(name, data)


def _load_pdf(name: str, data: bytes, password: str | None) -> Source:
    import pdfplumber
    from pdfminer.pdfdocument import PDFPasswordIncorrect
    from pdfplumber.utils.exceptions import PdfminerException

    try:
        pdf = pdfplumber.open(io.BytesIO(data), password=password or "")
    except PdfminerException as exc:
        cause = exc.args[0] if exc.args else None
        if isinstance(cause, PDFPasswordIncorrect):
            raise SourceError(SourceProblem.WRONG_PASSWORD if password else SourceProblem.PASSWORD_REQUIRED) from None
        raise SourceError(SourceProblem.INVALID) from None
    except Exception:
        raise SourceError(SourceProblem.INVALID) from None
    with pdf:
        if len(pdf.pages) > MAX_PAGES:
            raise SourceError(SourceProblem.TOO_MANY_PAGES)
        source = Source(name=name, format=DocFormat.PDF, pages=len(pdf.pages))
        producer = pdf.metadata.get("Producer") if isinstance(pdf.metadata, dict) else None
        source.producer = str(producer)[:80] if producer else None
        for index, page in enumerate(pdf.pages, start=1):
            # Some generators fake bold by printing each glyph twice (seen in NuInvest notes).
            clean = page.dedupe_chars()
            for entry in clean.extract_text_lines(layout=False, strip=True):
                text = re.sub(r"\s+", " ", entry["text"]).strip()
                if text:
                    bbox = (float(entry["x0"]), float(entry["top"]), float(entry["x1"]), float(entry["bottom"]))
                    source.lines.append(Line(page=index, text=text, bbox=bbox))
    if sum(len(line.text) for line in source.lines) < 20:
        raise SourceError(SourceProblem.NO_TEXT)
    return source


def _load_csv(name: str, data: bytes) -> Source:
    text = decode_text(data)
    sample = text[:4096]
    delimiter = max((",", ";", "\t"), key=sample.count)
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    source = Source(name=name, format=DocFormat.CSV)
    for number, row in enumerate(reader, start=1):
        cells = [c.strip() for c in row]
        if any(cells):
            source.rows.append((number, cells))
            source.lines.append(Line(page=0, text=delimiter.join(cells), number=number))
    if not source.rows:
        raise SourceError(SourceProblem.INVALID)
    return source


_TAG = re.compile(r"<([A-Z0-9.]+)>([^<\r\n]*)", re.IGNORECASE)


def parse_ofx(text: str) -> OfxData:
    """Tolerant reader for OFX 1.x (SGML, unclosed tags) and 2.x (XML)."""
    upper = text.upper()
    kind = "card" if "<CCSTMTRS>" in upper or "CREDITCARDMSGSRSV1" in upper else "bank"

    def first(tag: str, scope: str = text) -> str | None:
        match = re.search(rf"<{tag}>([^<\r\n]*)", scope, re.IGNORECASE)
        return match.group(1).strip() if match and match.group(1).strip() else None

    balance_block = re.search(r"<LEDGERBAL>(.*?)(</LEDGERBAL>|<AVAILBAL>|</STMTRS>|</CCSTMTRS>)", text, re.I | re.S)
    data = OfxData(
        kind=kind,
        account_id=first("ACCTID"),
        bank_id=first("BANKID"),
        currency=first("CURDEF"),
        ledger_balance=first("BALAMT", balance_block.group(1)) if balance_block else None,
        ledger_balance_date=first("DTASOF", balance_block.group(1)) if balance_block else None,
        start=first("DTSTART"),
        end=first("DTEND"),
    )
    for match in re.finditer(r"<STMTTRN>(.*?)(?=</STMTTRN>|<STMTTRN>|</BANKTRANLIST>)", text, re.I | re.S):
        block = match.group(1)
        fields = {tag.upper(): value.strip() for tag, value in _TAG.findall(block) if value.strip()}
        line = text.count("\n", 0, match.start()) + 1
        data.transactions.append(OfxTransaction(line=line, fields=fields))
    if not data.transactions and data.ledger_balance is None:
        raise SourceError(SourceProblem.INVALID)
    return data
