"""Sanity checks for the third-party brokerage note fixtures (docs/12 §4).

Skipped until the PDFs are added (see the README next to them).
"""

import re
from pathlib import Path

import pdfplumber
import pytest

ROOT = Path(__file__).parent / "fixtures" / "terceiros" / "notas_corretagem"

FIXTURES: dict[str, str | None] = {
    "leitor-de-notas-de-corretagem/clear_multi_page.pdf": None,
    "leitor-de-notas-de-corretagem/clear_single_page_sell.pdf": None,
    "leitor-de-notas-de-corretagem/clear_single_page_sell_pwd.pdf": "456",
    "leitor-de-notas-de-corretagem/rico_multi_page.pdf": None,
    "leitor-de-notas-de-corretagem/rico_single_page.pdf": None,
    "leitor-de-notas-de-corretagem/rico_single_page_pwd.pdf": "123",
    "leitor-de-notas-de-corretagem/nubank_single_page.pdf": None,
    "correpy/b3_one_page.pdf": None,
}

CPF = re.compile(r"\d{3}\.\d{3}\.\d{3}-\d{2}")


def _path(name: str) -> Path:
    path = ROOT / name
    if not path.is_file():
        pytest.skip("third-party fixtures not added yet (see their README)")
    return path


@pytest.mark.parametrize(("name", "password"), FIXTURES.items())
def test_opens_and_has_no_personal_data(name: str, password: str | None) -> None:
    with pdfplumber.open(_path(name), password=password) as pdf:
        text = "\n".join(page.dedupe_chars().extract_text() or "" for page in pdf.pages)
    assert "Nota" in text or "NOTA" in text
    assert set(CPF.findall(text)) <= {"000.000.000-00"}


@pytest.mark.parametrize("name", [n for n, pw in FIXTURES.items() if pw])
def test_protected_notes_need_their_password(name: str) -> None:
    with pytest.raises(Exception), pdfplumber.open(_path(name)) as pdf:  # noqa: B017 - pdfminer raises several types
        pdf.pages[0].extract_text()


def test_licenses_accompany_the_files() -> None:
    _path("correpy/b3_one_page.pdf")
    assert (ROOT / "correpy" / "LICENSE").is_file()
    assert (ROOT / "leitor-de-notas-de-corretagem" / "LICENSE").is_file()
