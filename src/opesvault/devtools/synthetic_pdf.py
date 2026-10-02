"""Minimal synthetic PDFs for tests and measurements. Never real data."""

import os


def _esc(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_pdf_pages(pages: list[list[str]], padding_bytes: int = 0) -> bytes:
    """PDF with one Helvetica text page per entry (WinAnsi, so Portuguese accents work)."""
    objects: list[bytes] = [b"<< /Type /Catalog /Pages 2 0 R >>", b""]  # pages tree filled below
    font_ref = 3
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    kids: list[int] = []
    for lines in pages:
        ops = ["BT", "/F1 10 Tf", "40 800 Td", "13 TL"]
        ops += [f"({_esc(line)}) Tj T*" for line in lines]
        ops.append("ET")
        content = "\n".join(ops).encode("cp1252")
        objects.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
        content_ref = len(objects)
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents %d 0 R"
            b" /Resources << /Font << /F1 %d 0 R >> >> >>" % (content_ref, font_ref)
        )
        kids.append(len(objects))
    objects[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % k for k in kids), len(kids))
    if padding_bytes:
        pad = os.urandom(padding_bytes)
        objects.append(b"<< /Length %d >>\nstream\n" % len(pad) + pad + b"\nendstream")

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def make_pdf(lines: list[str], padding_bytes: int = 0) -> bytes:
    return make_pdf_pages([lines], padding_bytes)
