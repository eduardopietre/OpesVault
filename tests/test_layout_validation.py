"""Phase 7 tooling: scripts/validar_layouts.py against a throwaway corpus of synthetic files."""

import importlib.util
import json
from pathlib import Path
from types import ModuleType

from . import synthetic_docs as docs

ROOT = Path(__file__).resolve().parents[1]


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("validar", ROOT / "scripts" / "validar_layouts.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def corpus(tmp_path: Path) -> Path:
    for i, closing in enumerate(("1.320,00", "1.320,00", "1.320,00")):
        (tmp_path / f"itau{i}.pdf").write_bytes(docs.itau_bank_pdf(closing))
    (tmp_path / "nu.pdf").write_bytes(docs.nubank_card_pdf())
    return tmp_path


def test_drafts_then_validation(tmp_path: Path) -> None:
    script = load_script()
    folder = corpus(tmp_path)
    for path in sorted(folder.glob("*.pdf")):
        assert script.draft_expected(path) is not None
    assert script.draft_expected(folder / "nu.pdf") is None  # never overwrites a reviewed file

    reports = [script.check_document(p, ask_password=False) for p in sorted(folder.glob("*.pdf"))]
    assert all(r.ok and not r.reviewed for r in reports)
    assert all("faltam 3" in line for line in script.summarize(reports))

    for path in folder.glob("itau*.esperado.json"):
        data = json.loads(path.read_text("utf-8"))
        data["conferido"] = True
        path.write_text(json.dumps(data), "utf-8")
    reports = [script.check_document(p, ask_password=False) for p in sorted(folder.glob("*.pdf"))]
    summary = "\n".join(script.summarize(reports))
    assert "3/3 aprovados — pronto para validated_with_real_documents" in summary


def test_divergences_are_reported_without_values(tmp_path: Path) -> None:
    script = load_script()
    folder = corpus(tmp_path)
    path = folder / "nu.pdf"
    script.draft_expected(path)
    expected_path = folder / "nu.esperado.json"
    data = json.loads(expected_path.read_text("utf-8"))
    data["conferido"] = True
    data["cabecalho"]["total"] = "9999.99"
    data["itens"][0]["valor"] = "123.45"
    data["itens"][1]["descricao"] = "outra coisa"
    expected_path.write_text(json.dumps(data), "utf-8")
    report = script.check_document(path, ask_password=False)
    assert not report.ok
    joined = " ".join(report.problems)
    assert "cabeçalho.total diverge" in joined
    assert "não extraído" in joined and "a mais" in joined
    assert "descrição do item 2 diverge" in joined
    assert "9999" not in joined and "123.45" not in joined and "outra coisa" not in joined
    assert any("9999.99" in d for d in report.details)  # values only with --detalhes


def test_wrong_layout_and_unreadable(tmp_path: Path) -> None:
    script = load_script()
    (tmp_path / "x.pdf").write_bytes(docs.nubank_card_pdf())
    (tmp_path / "x.esperado.json").write_text(json.dumps({"conferido": True, "layout": "itau-extrato-pdf"}))
    report = script.check_document(tmp_path / "x.pdf", ask_password=False)
    assert any("layout" in p for p in report.problems)
    (tmp_path / "y.pdf").write_bytes(b"%PDF-1.4 quebrado")
    report = script.check_document(tmp_path / "y.pdf", ask_password=False)
    assert any("não lido" in p for p in report.problems)
