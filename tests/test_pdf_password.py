"""Password-protected PDFs (docs/05 §3): asked once, used in memory, never stored.

The encrypted documents are built here from the synthetic Nubank bill with pypdf (a test
dependency only), in the ciphers Brazilian banks use: AES-256, AES-128 and RC4-128, plus
PDFs with only an owner password, which open without asking anything.
"""

import io
from pathlib import Path

import pytest
from PySide6.QtWidgets import QApplication

from opesvault.importing import pipeline
from opesvault.importing.model import BatchStatus
from opesvault.importing.pipeline import ImportRequest
from opesvault.importing.source import SourceError, SourceProblem, load_source
from opesvault.pdf_render import PdfPasswordRequired, page_count, render_page
from opesvault.session import Session

from . import synthetic_docs as docs

PASSWORD = "12345678900"  # banks often use the holder's CPF digits


def encrypted(algorithm: str, user: str = PASSWORD, data: bytes | None = None) -> bytes:
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(data or docs.nubank_card_pdf())))
    writer.encrypt(user_password=user, owner_password="proprietario", algorithm=algorithm)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


@pytest.mark.parametrize("algorithm", ["AES-256", "AES-128", "RC4-128"])
def test_protected_pdf_asks_then_reads_with_the_password(algorithm: str) -> None:
    data = encrypted(algorithm)
    with pytest.raises(SourceError) as missing:
        load_source("fatura.pdf", data)
    assert missing.value.problem is SourceProblem.PASSWORD_REQUIRED
    with pytest.raises(SourceError) as wrong:
        load_source("fatura.pdf", data, "errada")
    assert wrong.value.problem is SourceProblem.WRONG_PASSWORD
    source = load_source("fatura.pdf", data, PASSWORD)
    assert any("Mercado Bom Preço" in line.text for line in source.lines)


def test_owner_only_password_opens_without_asking() -> None:
    data = encrypted("AES-256", user="")
    assert load_source("fatura.pdf", data).lines
    assert page_count(data) == 1  # the viewer opens it too


def test_import_with_password_keeps_the_original_and_not_the_password(tmp_path: Path) -> None:
    data = encrypted("AES-256")
    session = Session.new(tmp_path / "f.opesvault")
    with pytest.raises(SourceError):
        pipeline.import_document(session, ImportRequest("fatura.pdf", data))
    assert not session.documents  # nothing stored before the password is right
    batch = pipeline.import_document(session, ImportRequest("fatura.pdf", data, password=PASSWORD))
    assert batch.status is BatchStatus.IN_REVIEW
    [document] = session.documents
    assert document.data == data  # the evidence is the bank's file, still encrypted
    stored = repr(session.ledger.to_records()) + repr(batch)
    assert PASSWORD not in stored


def test_choosing_a_layout_again_needs_the_password(tmp_path: Path) -> None:
    data = encrypted("AES-128")
    session = Session.new(tmp_path / "f.opesvault")
    batch = pipeline.import_document(
        session, ImportRequest("fatura.pdf", data, password=PASSWORD, parser_id="nubank-cartao-pdf")
    )
    pipeline.batches(session.ledger)[batch.id] = batch.model_copy(update={"status": BatchStatus.AMBIGUOUS})
    with pytest.raises(SourceError) as missing:
        pipeline.reparse_with(session, batch.id, "nubank-cartao-pdf")
    assert missing.value.problem is SourceProblem.PASSWORD_REQUIRED
    redone = pipeline.reparse_with(session, batch.id, "nubank-cartao-pdf", PASSWORD)
    assert redone.status is BatchStatus.IN_REVIEW


def test_renderer_reports_the_password_instead_of_failing() -> None:
    data = encrypted("RC4-128")
    with pytest.raises(PdfPasswordRequired):
        page_count(data)
    with pytest.raises(PdfPasswordRequired):
        render_page(data, password="errada")
    assert not render_page(data, password=PASSWORD).isNull()


def test_viewer_asks_once_and_keeps_the_document_open(monkeypatch: pytest.MonkeyPatch) -> None:
    app = QApplication.instance() or QApplication([])
    assert app is not None
    from PySide6.QtWidgets import QInputDialog

    from opesvault.ui.pages.documents_page import PdfView

    data = encrypted("AES-256")
    view = PdfView()
    view.show_pdf(data)
    assert "protegido por senha" in view.image.text() and not view.unlock_button.isHidden()
    asked: list[str] = []

    def answer(*_args: object, **_kwargs: object) -> tuple[str, bool]:
        asked.append("senha")
        return PASSWORD, True

    monkeypatch.setattr(QInputDialog, "getText", answer)
    view.ask_password()
    assert view.image.pixmap() is not None and not view.image.pixmap().isNull()
    assert view.unlock_button.isHidden()
    view.show_pdf(data, page=1, highlight=(10.0, 10.0, 50.0, 20.0))  # another item of the same document
    assert asked == ["senha"]  # no second prompt
    assert not hasattr(view, "password")
    view.show_pdf(None)
    view.deleteLater()
