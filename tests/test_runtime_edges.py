"""Edge cases of the runtime pieces: entry point, undo stack, session documents, technical log,
self-test, background jobs and in-memory PDF rendering."""

import json
import runpy
import sys
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

import opesvault
from opesvault import diagnostics, selftest
from opesvault.session import Session
from opesvault.undo import UndoStack, describe
from opesvault.vault.model import RevisionInfo

SECRET = "PADARIA_SECRETA 1.234,56"


@pytest.fixture
def log_here(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("OPV_LOG_DIR", str(tmp_path / "logs"))
    return tmp_path / "logs"


def _log_entries(log_dir: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in (log_dir / "opesvault.log").read_text("utf-8").splitlines()]


# ── entry point ──────────────────────────────────────


@pytest.mark.parametrize(
    ("flag", "module", "function"),
    [
        ("--vault-worker", "opesvault.vault.worker", "worker_main"),
        ("--self-test", "opesvault.selftest", "selftest_main"),
    ],
)
def test_entry_point_dispatches_special_modes_without_qt(
    monkeypatch: pytest.MonkeyPatch, flag: str, module: str, function: str
) -> None:
    __import__(module)
    monkeypatch.setattr(sys.modules[module], function, lambda: 7)
    monkeypatch.setattr(sys, "argv", ["opesvault", flag, "relatorio.json"])
    assert opesvault.main() == 7


def test_entry_point_opens_the_vault_given_on_the_command_line(monkeypatch: pytest.MonkeyPatch) -> None:
    from PySide6 import QtWidgets

    from opesvault.ui import main_window, theme

    events: list[object] = []

    class FakeApp:
        def __init__(self, argv: list[str]) -> None:
            events.append(("app", argv))

        def setApplicationName(self, name: str) -> None:  # noqa: N802 - Qt's name
            events.append(("name", name))

        def exec(self) -> int:
            return 3

    class FakeWindow:
        def show(self) -> None:
            events.append("show")

        def open_path(self, path: Path) -> None:
            events.append(("open", path))

    reporters: list[Any] = []
    messages: list[str] = []
    monkeypatch.setattr(QtWidgets, "QApplication", FakeApp)
    monkeypatch.setattr(QtWidgets.QMessageBox, "critical", lambda _p, _t, text: messages.append(text))
    monkeypatch.setattr(main_window, "MainWindow", FakeWindow)
    monkeypatch.setattr(theme, "apply_theme", lambda _app: events.append("theme"))
    monkeypatch.setattr(theme, "follow_system", lambda _app: events.append("follow"))
    monkeypatch.setattr(diagnostics, "install", reporters.append)
    monkeypatch.setattr(sys, "argv", ["opesvault", "--outra", "C:\\Familia\\Casa.OPESVAULT", "b.opesvault"])

    assert opesvault.main() == 3
    opened = [e for e in events if isinstance(e, tuple) and e[0] == "open"]
    assert opened == [("open", Path("C:\\Familia\\Casa.OPESVAULT"))]  # only the first vault, any case
    assert events.index("theme") < events.index("show")
    # The crash reporter shows only the incident id.
    (report,) = reporters
    report("abc123")
    assert len(messages) == 1 and "abc123" in messages[0]


def test_module_entry_point_exits_with_main_status(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(opesvault, "main", lambda: 5)
    with pytest.raises(SystemExit) as exc:
        runpy.run_module("opesvault.__main__", run_name="__main__")
    assert exc.value.code == 5


# ── undo stack ───────────────────────────────────────


def _revision(session: Session) -> RevisionInfo:
    return RevisionInfo(
        vault_id=session.vault_id, format_version=1, revision=1, revision_id=uuid4(), saved_at=datetime.now(UTC)
    )


def test_step_labels_name_what_changed() -> None:
    assert describe([("external", None)]) == "documento"
    assert describe([("entity", "operation"), ("entity", "operation")]) == "lançamentos"
    assert describe([("entity", "operation"), ("entity", "account")]) == "lançamento"  # most specific first
    assert describe([("entity", "evidence")]) == "alteração"
    assert describe([]) == "alteração"


def test_empty_stack_does_nothing(tmp_path: Path) -> None:
    session = Session.new(tmp_path / "x.opesvault")
    stack = session.undo_stack()
    assert session.undo_stack() is stack  # one per session
    assert stack.undo() is None and stack.redo() is None
    assert stack.undo_label() is None and stack.redo_label() is None
    assert not stack.can_undo() and not stack.can_redo()


def test_pending_edit_is_undoable_before_it_is_sealed(tmp_path: Path) -> None:
    session = Session.new(tmp_path / "x.opesvault")
    stack = session.undo_stack()
    member = session.ledger.add_member("Carla")
    assert stack.can_undo() and stack.undo_label() == "integrante"  # not sealed yet
    step = stack.undo()
    assert step is not None and member.id not in session.ledger.members


def test_save_keeps_edits_made_while_it_ran(tmp_path: Path) -> None:
    session = Session.new(tmp_path / "x.opesvault")
    stack = session.undo_stack()
    first = session.ledger.add_member("Ana")
    stack.seal()
    steps = stack.checkpoint()  # the save starts with one step
    assert steps == 1
    second = session.ledger.add_member("Bruno")  # typed while the worker writes
    stack.seal()
    stack.undo()
    stack.saved(steps)
    assert not stack.can_redo()  # redo would re-apply on top of another saved state
    assert stack.undo() is None  # Bruno's step was undone before; Ana's is in the vault now
    assert first.id in session.ledger.members and second.id not in session.ledger.members


def test_replaced_ledger_starts_recording_again(tmp_path: Path) -> None:
    from opesvault.domain.ledger import Ledger

    session = Session.new(tmp_path / "x.opesvault")
    stack = UndoStack(session)
    session.ledger = Ledger.new("Outra")  # e.g. reloaded
    assert session.ledger.journal is None
    assert not stack.can_undo()  # asking installs a journal on the new ledger
    member = session.ledger.add_member("Dani")
    assert stack.can_undo()
    stack.undo()
    assert member.id not in session.ledger.members


def test_step_history_is_bounded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from opesvault import undo

    monkeypatch.setattr(undo, "MAX_STEPS", 3)
    session = Session.new(tmp_path / "x.opesvault")
    stack = session.undo_stack()
    for n in range(5):
        session.ledger.add_member(f"Pessoa {n}")
        stack.seal()
    assert len(stack.undo_steps) == 3


# ── session documents ────────────────────────────────


def test_document_removed_and_put_back_before_a_save_is_not_resent(tmp_path: Path) -> None:
    session = Session.new(tmp_path / "x.opesvault")
    stack = session.undo_stack()
    document = session.add_document("a.pdf", b"%PDF a")
    session.mark_saved(session.freeze(), _revision(session))
    stack.clear()

    session.remove_document(document.meta.id)
    stack.seal()
    frozen = session.freeze()
    assert frozen.delta is not None and frozen.delta.documents_removed == (document.meta.id,)
    stack.undo()  # put back
    frozen = session.freeze()
    assert frozen.delta is not None
    assert frozen.delta.documents_removed == () and frozen.delta.documents_added == ()
    assert session.document(document.meta.id).data == b"%PDF a"


def test_unknown_documents(tmp_path: Path) -> None:
    session = Session.new(tmp_path / "x.opesvault")
    session.add_document("a.pdf", b"%PDF a")
    journal_before = len(session.ledger.journal or [])
    session.remove_document(uuid4())  # nothing to remove: nothing to undo
    assert len(session.ledger.journal or []) == journal_before
    with pytest.raises(KeyError):
        session.document(uuid4())
    assert session.find_document_by_hash("0" * 64) is None


# ── technical log ────────────────────────────────────


def test_log_dir_defaults_per_platform(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("OPV_LOG_DIR", raising=False)
    monkeypatch.setattr(diagnostics.sys, "platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    assert diagnostics.log_dir() == tmp_path / "local" / "OpesVault" / "logs"
    monkeypatch.setattr(diagnostics.sys, "platform", "linux")
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    assert diagnostics.log_dir() == tmp_path / "state" / "opesvault" / "logs"
    assert diagnostics.log_path().name == "opesvault.log"


def test_hooks_ignore_ctrl_c_and_survive_a_failing_reporter(log_here: Path) -> None:
    old_hook, old_thread_hook = sys.excepthook, threading.excepthook

    def broken_reporter(_incident: str) -> None:
        raise RuntimeError("o diálogo falhou")

    try:
        diagnostics.install(broken_reporter)
        sys.excepthook(KeyboardInterrupt, KeyboardInterrupt(), None)
        assert not (log_here / "opesvault.log").exists()  # Ctrl+C is not an incident
        error = ValueError(SECRET)
        sys.excepthook(ValueError, error, None)  # the reporter failure does not escape
        threading.excepthook(threading.ExceptHookArgs((SystemExit, None, None, None)))  # nothing to record
        diagnostics.install()
        sys.excepthook(ValueError, error, None)
    finally:
        sys.excepthook, threading.excepthook = old_hook, old_thread_hook
    entries = _log_entries(log_here)
    assert [e["code"] for e in entries] == ["UNHANDLED", "UNHANDLED"]
    assert SECRET not in (log_here / "opesvault.log").read_text("utf-8")


# ── self-test ────────────────────────────────────────


def test_selftest_check_records_failures_and_timing() -> None:
    results: dict[str, Any] = {}

    def fails() -> None:
        raise AssertionError("marker found in vault bytes")

    selftest._check(results, "ok", lambda: "fine")
    selftest._check(results, "bad", fails)
    assert results["ok"]["ok"] is True and results["ok"]["detail"] == "fine"
    assert results["bad"]["ok"] is False and results["bad"]["error"].startswith("AssertionError")
    assert "seconds" in results["bad"] and "trace" in results["bad"]


def test_selftest_temp_listing_tolerates_a_missing_temp_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path / "nao-existe"))
    assert selftest._temp_listing() == set()


@pytest.mark.parametrize("all_ok", [True, False])
def test_selftest_main_writes_the_report(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str], all_ok: bool
) -> None:
    report = tmp_path / "relatorio.json"
    monkeypatch.setattr(selftest, "run_selftest", lambda: {"all_ok": all_ok, "versions": {"ok": all_ok}})
    monkeypatch.setattr(sys, "argv", ["OpesVault.exe", "--self-test", str(report)])
    assert selftest.selftest_main() == (0 if all_ok else 1)
    assert json.loads(report.read_text("utf-8"))["all_ok"] is all_ok
    assert json.loads(capsys.readouterr().out) == {"all_ok": all_ok, "report": str(report)}


def test_selftest_main_default_report_name(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(selftest, "run_selftest", lambda: {"all_ok": True})
    monkeypatch.setattr(sys, "argv", ["OpesVault.exe", "--self-test"])
    monkeypatch.setattr(sys, "stdout", None)  # windowed executable: no console
    assert selftest.selftest_main() == 0
    assert (tmp_path / "opesvault-selftest.json").exists()


# ── background jobs ──────────────────────────────────


def test_background_job_delivers_progress_and_result() -> None:
    from opesvault.ui.background import BackgroundJob

    def work(report: Any) -> str:
        report(1, 2)
        report(2, 2)
        return "pronto"

    job = BackgroundJob(work)
    progress: list[tuple[int, int]] = []
    done: list[object] = []
    job.signals.progress.connect(lambda d, t: progress.append((d, t)))
    job.signals.done.connect(done.append)
    job.run()  # synchronously: the pool's threads are not traced by coverage
    assert progress == [(1, 2), (2, 2)] and done == ["pronto"]


def test_background_job_failure_is_delivered_and_logged_without_message(log_here: Path) -> None:
    from opesvault.ui.background import BackgroundJob

    def work(_report: Any) -> None:
        raise ValueError(SECRET)

    job = BackgroundJob(work)
    done: list[object] = []
    job.signals.done.connect(done.append)
    job.run()
    assert len(done) == 1 and isinstance(done[0], ValueError)  # the caller decides what the user sees
    (entry,) = _log_entries(log_here)
    assert entry["code"] == "BACKGROUND_FAILED" and entry["type"] == "ValueError"
    assert SECRET not in (log_here / "opesvault.log").read_text("utf-8")


def test_background_job_runs_in_the_pool() -> None:
    from PySide6.QtCore import QCoreApplication, QThreadPool
    from PySide6.QtWidgets import QApplication

    from opesvault.ui.background import BackgroundJob

    if not isinstance(QApplication.instance(), QApplication):
        QApplication([])
    caller = threading.get_ident()
    seen: list[int] = []
    done: list[object] = []
    job = BackgroundJob(lambda _report: seen.append(threading.get_ident()) or "ok")
    job.signals.done.connect(done.append)
    job.start()
    assert QThreadPool.globalInstance().waitForDone(5000)
    QCoreApplication.processEvents()
    assert seen and seen[0] != caller  # never on the UI thread
    assert done == ["ok"]


# ── PDF rendering ────────────────────────────────────


def test_broken_pdf_is_not_mistaken_for_a_password_prompt() -> None:
    import pypdfium2 as pdfium

    from opesvault.pdf_render import PdfPasswordRequired, open_document

    with pytest.raises(pdfium.PdfiumError) as exc:
        open_document(b"%PDF-1.4 quebrado")
    assert not isinstance(exc.value, PdfPasswordRequired)
