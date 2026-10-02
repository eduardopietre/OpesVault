"""Non-interactive checks run *inside the packaged executable* (phase 0 gate).

Usage: OpesVault.exe --self-test <report.json>

Proves that SQLCipher, PDFium, pdfplumber and Qt were bundled correctly and that
the executable can re-launch itself as a vault worker. Uses a random throwaway
password and synthetic data only; the report holds no secrets.
"""

import io
import json
import secrets
import shutil
import sqlite3
import sys
import tempfile
import time
import traceback
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import uuid4

MARKER = "OPESVAULT_SELFTEST_MARKER"


def _check(results: dict[str, Any], name: str, fn: Callable[[], Any]) -> None:
    started = time.perf_counter()
    try:
        detail = fn()
        results[name] = {"ok": True, "detail": detail}
    except Exception as exc:
        results[name] = {"ok": False, "error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc(limit=4)}
    results[name]["seconds"] = round(time.perf_counter() - started, 3)


def _temp_listing() -> set[str]:
    root = Path(tempfile.gettempdir())
    try:
        return {p.name for p in root.iterdir()}
    except OSError:
        return set()


def run_selftest() -> dict[str, Any]:
    from sqlcipher3 import dbapi2 as sqlcipher

    from opesvault.devtools.synthetic_pdf import make_pdf
    from opesvault.vault import sqlcipher_store
    from opesvault.vault.client import default_worker_command, is_compiled
    from opesvault.vault.errors import ErrorCode, VaultError
    from opesvault.vault.model import Document, Record, Snapshot

    results: dict[str, Any] = {
        "platform": sys.platform,
        "python": sys.version.split()[0],
        "compiled": is_compiled(),
        "worker_command": default_worker_command()[1:],
    }
    temp_before = _temp_listing()
    work = Path(tempfile.mkdtemp(prefix="opv-selftest-"))
    vault = work / "selftest.opesvault"
    password = secrets.token_urlsafe(24)
    pdf = make_pdf([MARKER, "Fatura sintetica R$ 123,45"])

    def versions() -> dict[str, Any]:
        import pdfplumber
        import pypdfium2
        import PySide6

        conn = sqlcipher.connect(":memory:")
        conn.execute("PRAGMA key = 'x'")
        info = {
            "sqlite": sqlcipher.sqlite_version,
            "sqlcipher": conn.execute("PRAGMA cipher_version").fetchone()[0],
            "crypto_provider": conn.execute("PRAGMA cipher_provider").fetchone()[0],
            "crypto_provider_version": conn.execute("PRAGMA cipher_provider_version").fetchone()[0],
            "cipher_settings": [r[0] for r in conn.execute("PRAGMA cipher_settings")],
            "pyside6": PySide6.__version__,
            "pypdfium2": str(pypdfium2.PYPDFIUM_INFO),
            "pdfium": str(pypdfium2.PDFIUM_INFO),
            "pdfplumber": pdfplumber.__version__,
        }
        conn.close()
        return info

    def roundtrip() -> dict[str, Any]:
        snap = Snapshot.build(
            uuid4(),
            (Record(id=uuid4(), kind="selftest", payload={"description": MARKER, "amount": "123.45"}),),
            (Document.from_bytes("selftest.pdf", pdf),),
        )
        t0 = time.perf_counter()
        first = sqlcipher_store.save(vault, password, snap, None)
        t1 = time.perf_counter()
        second = sqlcipher_store.save(vault, password, snap, first.revision_id)
        t2 = time.perf_counter()
        _, loaded = sqlcipher_store.load(vault, password)
        t3 = time.perf_counter()
        assert loaded.manifest == snap.manifest and loaded.blobs == snap.blobs, "roundtrip mismatch"
        assert second.revision == 2
        leftovers = sorted(p.name for p in work.iterdir() if p.name != vault.name)
        assert not leftovers, f"unexpected files next to vault: {leftovers}"
        return {"create_s": round(t1 - t0, 3), "save_s": round(t2 - t1, 3), "load_s": round(t3 - t2, 3)}

    def encrypted_at_rest() -> str:
        raw = vault.read_bytes()
        assert MARKER.encode() not in raw, "marker found in vault bytes"
        assert not raw.startswith(sqlcipher_store.PLAIN_SQLITE_HEADER), "plain SQLite header"
        try:
            sqlite3.connect(vault).execute("SELECT * FROM sqlite_master").fetchall()
        except sqlite3.DatabaseError:
            return "plain sqlite3 cannot read the vault"
        raise AssertionError("plain sqlite3 read the vault")

    def wrong_password() -> str:
        try:
            sqlcipher_store.load(vault, password + "x")
        except VaultError as exc:
            assert exc.code is ErrorCode.WRONG_PASSWORD, exc.code
            return "rejected"
        raise AssertionError("wrong password accepted")

    def pdf_render() -> dict[str, Any]:
        from opesvault.pdf_render import render_page

        image = render_page(pdf)
        assert not image.isNull()
        return {"width": image.width(), "height": image.height()}

    def pdf_text() -> str:
        import pdfplumber

        with pdfplumber.open(io.BytesIO(pdf)) as doc:
            text = doc.pages[0].extract_text() or ""
        assert MARKER in text, "marker not extracted"
        return "extracted"

    def worker_launch() -> dict[str, Any]:
        # A malformed request makes the worker answer without asking for a password.
        import subprocess

        t0 = time.perf_counter()
        proc = subprocess.run(default_worker_command(), input=b"garbage", capture_output=True, timeout=60, check=False)
        elapsed = time.perf_counter() - t0
        from opesvault.vault.framing import read_message
        from opesvault.vault.protocol import WorkerResponse

        response, _ = read_message(io.BytesIO(proc.stdout), WorkerResponse)
        assert response.error is ErrorCode.PROTOCOL_ERROR, response
        assert not proc.stderr, "worker wrote to stderr"
        return {"startup_and_exit_s": round(elapsed, 3)}

    def qt_platform() -> str:
        from PySide6.QtGui import QGuiApplication

        app = QGuiApplication.instance() or QGuiApplication([sys.argv[0]])
        assert isinstance(app, QGuiApplication)
        return app.platformName()

    for name, fn in [
        ("versions", versions),
        ("qt_platform", qt_platform),
        ("vault_roundtrip", roundtrip),
        ("encrypted_at_rest", encrypted_at_rest),
        ("wrong_password", wrong_password),
        ("pdf_render_in_memory", pdf_render),
        ("pdf_text_extraction", pdf_text),
        ("worker_relaunch", worker_launch),
    ]:
        _check(results, name, fn)

    shutil.rmtree(work, ignore_errors=True)
    new_temp = sorted(_temp_listing() - temp_before)
    results["new_temp_entries"] = new_temp
    results["all_ok"] = all(v.get("ok") for v in results.values() if isinstance(v, dict) and "ok" in v)
    return results


def selftest_main() -> int:
    target = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("opesvault-selftest.json")
    results = run_selftest()
    target.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    if sys.stdout is not None:
        print(json.dumps({"all_ok": results["all_ok"], "report": str(target)}))
    return 0 if results["all_ok"] else 1
