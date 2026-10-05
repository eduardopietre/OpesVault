"""importing/source.py and importing/parsers over the synthetic documents and fuzzed variants.

For every synthetic document (tests/synthetic_docs.py) the file records its bytes, the source as
pdfplumber/csv/OFX reading gave it (lines with boxes, rows, OFX records), each parser's detection
score, the chosen layout and every parser's result. The TS side checks two things:

- parser parity: TS parsers fed with Python's extracted source give identical results;
- extraction parity: the pdf.js extractor on the same bytes gives the same text (boxes within a
  tolerance) and the whole pipeline from bytes gives the same items.

Fuzzed variants come from tests/test_fuzz.py's own mutations, with fixed seeds: mutated PDF text
forced into every PDF parser, and mutated CSV/OFX bytes through load_source and the parsers.
Encrypted copies of the Nubank bill (pypdf, as tests/test_pdf_password.py) check PDF passwords.
"""

import base64
import io
import random
from dataclasses import replace
from typing import Any

from opesvault.devtools.synthetic_pdf import make_pdf
from opesvault.importing.model import StatementHeader
from opesvault.importing.parsers import PARSERS
from opesvault.importing.parsers.base import ParsedItem, ParseResult
from opesvault.importing.pipeline import ParseFailed, choose_parser, run_parser
from opesvault.importing.source import Line, Source, SourceError, load_source
from scripts.golden.common import j
from tests import synthetic_docs as docs
from tests.test_fuzz import _mutate_text

FUZZ_TEXT_ITERATIONS = 20
FUZZ_BYTES_ITERATIONS = 30
PASSWORD = "12345678900"


def positioned_pdf(runs: list[tuple[float, float, str]]) -> bytes:
    """One page with text runs placed one by one (columns, runs that touch, fake bold), so line
    and word grouping are compared too, not only one run per line as in synthetic_pdf."""
    import re as _re

    def esc(text: str) -> str:
        return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    page = make_pdf(["placeholder"])
    ops = ["BT", "/F1 10 Tf"] + [f"1 0 0 1 {x} {y} Tm ({esc(t)}) Tj" for x, y, t in runs] + ["ET"]
    content = "\n".join(ops).encode("cp1252")
    old = _re.search(rb"<< /Length \d+ >>\nstream\n.*?\nendstream", page, _re.S)
    assert old is not None
    body = b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream"
    # Rebuild the file so the xref offsets stay right.
    objects = _re.findall(rb"\d+ 0 obj\n(.*?)\nendobj\n", page, _re.S)
    objects = [body if o == old.group(0) else o for o in objects]
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


POSITIONED = [
    (40, 800, "Resumo dos Negócios"),
    (300, 800, "Resumo Financeiro"),  # a second column on the same line
    (40, 787, "Compras à vista 3.105,00"),
    (300, 787.8, "Taxa de liquidação 1,65 D"),  # a baseline 0.8 pt off: still one line
    (40, 774, "Emolu"),
    (66.7, 774, "mentos 0,30 D"),  # touching runs: one word
    (40, 761, "Líquido "),
    (78, 761, "para 04/03/2026 106,95 D"),  # a space at the end of a run
    (40, 748, "Nota em negrito"),
    (40.4, 748.3, "Nota em negrito"),  # fake bold: the same run printed again 0.4 pt away
    (40, 735, "Linha"),
    (40, 730, "logo abaixo"),  # 5 pt below: another line
    (120, 722, "  espaços   no   meio  "),
]


DOCUMENTS: list[tuple[str, Any]] = [
    ("positioned.pdf", lambda: positioned_pdf(POSITIONED)),
    ("nubank_card.pdf", docs.nubank_card_pdf),
    ("nubank_card_divergent.pdf", lambda: docs.nubank_card_pdf(total="999,99")),
    ("itau_card.pdf", docs.itau_card_pdf),
    ("bradesco_card.pdf", docs.bradesco_card_pdf),
    ("itau_bank.pdf", docs.itau_bank_pdf),
    ("sinacor_note.pdf", docs.sinacor_note_pdf),
    ("bank_income_report.pdf", docs.bank_income_report_pdf),
    ("unknown_layout.pdf", lambda: make_pdf(["Documento qualquer sem layout conhecido 123"])),
    ("scanned.pdf", lambda: make_pdf([])),
    ("nubank_account.csv", docs.nubank_account_csv),
    ("nubank_card.csv", docs.nubank_card_csv),
    ("bank.ofx", docs.ofx_bank),
    (
        "card.ofx",
        lambda: (
            docs.ofx_bank("C")
            .replace(b"<BANKMSGSRSV1><STMTTRNRS><STMTRS>", b"<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>")
            .replace(b"</STMTRS></STMTTRNRS></BANKMSGSRSV1>", b"</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>")
        ),
    ),
    (
        "card_payment.csv",
        lambda: b"date,title,amount\n2026-01-20,Pagamento recebido,-1680.00\n2026-01-22,Uber *Trip,10.00\n",
    ),
    ("savings.csv", lambda: "Data,Valor,Identificador,Descrição\n15/01/2026,500.00,x1,TED recebida\n".encode()),
    ("cp1252.csv", lambda: "Data;Valor;Identificador;Descrição\n01/02/2026;-12.00;z;Pão de Açúcar\n".encode("cp1252")),
    ("quoted.csv", lambda: b'date,title,amount\n2026-02-03,"Loja ""X"", centro",23.45\r\n2026-02-30,Bad date,1.00\n'),
]


def line_json(line: Line) -> dict[str, Any]:
    return {"page": line.page, "text": line.text, "bbox": list(line.bbox) if line.bbox else None, "number": line.number}


def source_json(source: Source) -> dict[str, Any]:
    ofx = source.ofx
    return {
        "name": source.name,
        "format": source.format.value,
        "pages": source.pages,
        "producer": source.producer,
        "lines": [line_json(line) for line in source.lines],
        "rows": [[n, cells] for n, cells in source.rows],
        "ofx": None
        if ofx is None
        else {
            "kind": ofx.kind,
            "account_id": ofx.account_id,
            "bank_id": ofx.bank_id,
            "currency": ofx.currency,
            "ledger_balance": ofx.ledger_balance,
            "ledger_balance_date": ofx.ledger_balance_date,
            "start": ofx.start,
            "end": ofx.end,
            "transactions": [
                {"line": t.line, "fields": [[k, v] for k, v in t.fields.items()]} for t in ofx.transactions
            ],
        },
    }


def header_json(header: StatementHeader) -> dict[str, Any]:
    return {name: j(getattr(header, name)) for name in StatementHeader.model_fields}


def item_json(item: ParsedItem) -> dict[str, Any]:
    return {
        "kind": item.kind.value,
        "occurred_on": j(item.occurred_on),
        "description": item.description,
        "amount": j(item.amount),
        "lines": [line_json(line) for line in item.lines],
        "installment": list(item.installment) if item.installment else None,
        "card_last4": item.card_last4,
        "bank_id": item.bank_id,
        "foreign_amount": j(item.foreign_amount),
        "foreign_currency": item.foreign_currency,
        "quantity": j(item.quantity),
        "unit_price": j(item.unit_price),
        "ticker": item.ticker,
        "credit": item.credit,
        "warnings": list(item.warnings),
    }


def result_json(result: ParseResult) -> dict[str, Any]:
    return {
        "header": header_json(result.header),
        "items": [item_json(i) for i in result.items],
        "warnings": list(result.warnings),
        "unmapped": [line_json(line) for line in result.unmapped],
    }


def parse_outcome(parser: Any, source: Source) -> dict[str, Any]:
    """Every parser forced on the source: its result, or that it failed (any exception)."""
    try:
        return {"ok": result_json(parser.parse(source))}
    except Exception as exc:
        return {"error": type(exc).__name__}


def run_outcome(parser: Any, source: Source) -> dict[str, Any]:
    try:
        return {"ok": result_json(run_parser(parser, source))}
    except ParseFailed as exc:
        return {"error": "ParseFailed", "message": str(exc)}


def analysis(source: Source) -> dict[str, Any]:
    parser, candidates = choose_parser(source)
    return {
        "detect": {p.id: p.detect(source) for p in PARSERS},
        "choice": {"parser": parser.id if parser else None, "candidates": candidates},
        "results": {p.id: run_outcome(p, source) for p in PARSERS},
    }


def load(name: str, data: bytes, password: str | None = None) -> dict[str, Any]:
    try:
        source = load_source(name, data, password)
    except SourceError as exc:
        return {"problem": exc.problem.value}
    return {"source": source_json(source), **analysis(source)}


def documents() -> list[dict[str, Any]]:
    out = []
    for name, build in DOCUMENTS:
        data = build()
        out.append({"name": name, "bytes": base64.b64encode(data).decode(), **load(name, data)})
    return out


def text_fuzz() -> list[dict[str, Any]]:
    out = []
    pdfs = {name: build() for name, build in DOCUMENTS if name.endswith(".pdf") and name != "scanned.pdf"}
    for name, data in pdfs.items():
        base = load_source(name, data)
        rng = random.Random(f"golden-pdf-text-{name}")
        for _ in range(FUZZ_TEXT_ITERATIONS):
            text = _mutate_text(rng, base.text)
            lines = [Line(page=1, text=t, number=n) for n, t in enumerate(text.splitlines(), 1)]
            source = replace(base, lines=lines)
            out.append(
                {
                    "doc": name,
                    "lines": [line.text for line in lines],
                    "detect": {p.id: p.detect(source) for p in PARSERS},
                    "results": {p.id: parse_outcome(p, source) for p in PARSERS if p.doc_format is source.format},
                }
            )
    return out


def bytes_fuzz() -> list[dict[str, Any]]:
    out = []
    for name, build in DOCUMENTS:
        if name.endswith(".pdf"):
            continue
        original = (
            build().decode("utf-8", errors="replace") if not name.startswith("cp1252") else build().decode("cp1252")
        )
        rng = random.Random(f"golden-text-{name}")
        for i in range(FUZZ_BYTES_ITERATIONS):
            mutated = _mutate_text(rng, original)
            data = mutated.encode("utf-8" if i % 3 else "cp1252", errors="replace")
            out.append({"name": name, "bytes": base64.b64encode(data).decode(), **load(f"{i}-{name}", data)})
    degenerate = [
        b"",
        b"%PDF",
        b"OFXHEADER:100\n",
        b"<OFX>" + b"<STMTTRN>" * 50,
        b"\xff\xfe\x00\x00" * 10,
        b"a;b;c\n" * 100,
        "Data,Valor,Identificador,Descrição\n".encode() + b"x,y,z,w\n" * 10,
        b"\x00" * 64,
        b"\x81\x8d\x8f",
        b'a,b\r\nc,"d\ne"\rf',
        b"x" * 131073,
    ]
    for data in degenerate:
        if data.startswith(b"%PDF"):
            continue
        out.append({"name": "degenerate", "bytes": base64.b64encode(data).decode(), **load("x", data)})
    return out


def encrypted() -> list[dict[str, Any]]:
    """The keys, salts and IVs pypdf draws come from a seeded generator, so the file is reproducible."""
    import secrets
    from unittest import mock

    rng = random.Random("golden-encryption")
    with mock.patch.object(secrets, "token_bytes", lambda n=32: rng.randbytes(n)):
        return _encrypted()


def _encrypted() -> list[dict[str, Any]]:
    from pypdf import PdfReader, PdfWriter

    out = []
    for algorithm, user in (("AES-256", PASSWORD), ("AES-128", PASSWORD), ("RC4-128", PASSWORD), ("AES-256", "")):
        writer = PdfWriter(clone_from=PdfReader(io.BytesIO(docs.nubank_card_pdf())))
        writer.encrypt(user_password=user, owner_password="proprietario", algorithm=algorithm)  # noqa: S106
        buffer = io.BytesIO()
        writer.write(buffer)
        data = buffer.getvalue()
        cases = {}
        for label, password in (("none", None), ("wrong", "errada"), ("right", PASSWORD)):
            try:
                source = load_source("fatura.pdf", data, password)
                cases[label] = {"lines": [line.text for line in source.lines]}
            except SourceError as exc:
                cases[label] = {"problem": exc.problem.value}
        out.append({"algorithm": algorithm, "user": user, "bytes": base64.b64encode(data).decode(), "cases": cases})
    return out


def generate() -> dict[str, Any]:
    return {
        "parsers": [
            {
                "id": p.id,
                "version": p.version,
                "institution": p.institution,
                "product": p.product,
                "doc_type": p.doc_type.value,
                "doc_format": p.doc_format.value,
                "validated_with_real_documents": p.validated_with_real_documents,
                "limitations": p.limitations,
            }
            for p in PARSERS
        ],
        "documents": documents(),
        "text_fuzz": text_fuzz(),
        "bytes_fuzz": bytes_fuzz(),
        "encrypted": encrypted(),
    }
