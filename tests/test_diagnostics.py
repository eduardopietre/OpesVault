import json
import sys
import threading
from pathlib import Path

import pytest

from opesvault import diagnostics

SECRET = "PADARIA_SECRETA 1.234,56 CPF 123.456.789-00"


@pytest.fixture(autouse=True)
def log_here(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("OPV_LOG_DIR", str(tmp_path / "logs"))
    return tmp_path / "logs"


def _fail() -> None:
    from opesvault.domain.money import parse_brl

    try:
        parse_brl(SECRET)
    except ValueError as exc:
        raise RuntimeError(SECRET) from exc


def test_record_keeps_only_codes_and_locations(log_here: Path) -> None:
    with pytest.raises(RuntimeError) as info:
        _fail()
    incident = diagnostics.record("TEST", info.value)
    text = (log_here / "opesvault.log").read_text("utf-8")
    assert "PADARIA" not in text and "1.234" not in text and "123.456" not in text
    entry = json.loads(text)
    assert entry["code"] == "TEST" and entry["incident"] == incident and entry["type"] == "RuntimeError"
    assert all(w.startswith("opesvault.") for w in entry["where"])


def test_location_is_module_function_line() -> None:
    from opesvault.domain.money import parse_brl

    with pytest.raises(ValueError) as info:
        parse_brl("x")
    where = diagnostics.code_locations(info.value.__traceback__)
    assert where and where[-1].startswith("opesvault.domain.money.parse_brl:")


def test_hooks_replace_default_printing(log_here: Path, capsys: pytest.CaptureFixture[str]) -> None:
    old_hook, old_thread_hook = sys.excepthook, threading.excepthook
    seen: list[str] = []
    try:
        diagnostics.install(seen.append)
        try:
            _fail()
        except RuntimeError:
            sys.excepthook(*sys.exc_info())  # type: ignore[arg-type]
        thread = threading.Thread(target=_fail)
        thread.start()
        thread.join()
    finally:
        sys.excepthook, threading.excepthook = old_hook, old_thread_hook
    lines = [json.loads(line) for line in (log_here / "opesvault.log").read_text("utf-8").splitlines()]
    assert [entry["code"] for entry in lines] == ["UNHANDLED", "UNHANDLED_THREAD"]
    assert seen == [lines[0]["incident"]]
    captured = capsys.readouterr()
    assert SECRET not in captured.err and SECRET not in captured.out


def test_rotation_and_unwritable_dir(log_here: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diagnostics, "MAX_BYTES", 200)
    for _ in range(10):
        diagnostics.record("X")
    assert (log_here / "opesvault.log.1").exists()
    assert (log_here / "opesvault.log").stat().st_size < 400
    blocker = tmp_path / "file"
    blocker.write_text("x")
    monkeypatch.setenv("OPV_LOG_DIR", str(blocker / "sub"))
    assert diagnostics.record("Y")  # still returns an incident id
