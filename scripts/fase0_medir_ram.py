"""Phase 0 gate: memory and time of the snapshot architecture (docs/01 §4, docs/09 §1).

Creates a vault with N MiB of synthetic, incompressible PDFs through the real
worker protocol and reports peak RSS of the UI-side process and of each worker,
plus save/open durations and the vault size.

    uv run python scripts/fase0_medir_ram.py --mib 50 125 250
"""

import argparse
import contextlib
import json
import os
import secrets
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from datetime import date
from functools import partial
from pathlib import Path
from typing import Any

import psutil

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from opesvault.devtools.synthetic_pdf import make_pdf  # noqa: E402
from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount  # noqa: E402
from opesvault.session import Session  # noqa: E402
from opesvault.vault.client import VaultClient  # noqa: E402

DOC_MIB = 2  # Typical size of a bank statement PDF is far lower; 2 MiB keeps counts manageable.


class PeakSampler:
    """Samples RSS of this process and of all its children every few ms."""

    def __init__(self) -> None:
        self.me = psutil.Process()
        self.peak_self = 0
        self.peak_child = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.peak_self = max(self.peak_self, self.me.memory_info().rss)
                for child in self.me.children(recursive=True):
                    with contextlib.suppress(psutil.Error):
                        self.peak_child = max(self.peak_child, child.memory_info().rss)
            except psutil.Error:
                pass
            time.sleep(0.005)

    def __enter__(self) -> "PeakSampler":
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        self._thread.join()


def measure(label: str, fn: Callable[[], Any]) -> tuple[Any, dict[str, Any]]:
    with PeakSampler() as sampler:
        t0 = time.perf_counter()
        result = fn()
        elapsed = time.perf_counter() - t0
    return result, {
        f"{label}_s": round(elapsed, 2),
        f"{label}_peak_ui_mib": round(sampler.peak_self / 2**20),
        f"{label}_peak_worker_mib": round(sampler.peak_child / 2**20),
    }


def run(total_mib: int, workdir: Path) -> dict[str, Any]:
    os.environ["OPV_DEV_PASSWORD"] = secrets.token_urlsafe(24)
    client = VaultClient([sys.executable, str(ROOT / "scripts" / "dev_worker.py")])
    vault = workdir / f"medicao-{total_mib}.opesvault"

    session = Session.new(vault)
    for i in range(max(1, total_mib // DOC_MIB)):
        session.add_document(f"extrato-{i:04d}.pdf", make_pdf([f"Documento {i}"], padding_bytes=DOC_MIB * 2**20))
    ledger = session.ledger
    bank = ledger.add_account(LedgerAccount(name="Banco", type=AccountType.ASSET, subtype=AccountSubtype.CHECKING))
    category = ledger.categories(AccountType.EXPENSE)[0]
    for i in range(50_000):
        ledger.record_expense(
            bank.id, category.id, f"{i % 500 + 1}.{i % 100:02d}", date(2026, 1, 1 + i % 28), f"Lancamento {i}"
        )
    report: dict[str, Any] = {
        "documents_mib": total_mib,
        "documents": len(session.documents),
        "operations": len(session.ledger.operations),
        "ui_rss_after_building_session_mib": round(psutil.Process().memory_info().rss / 2**20),
    }

    first = session.freeze()
    created, stats = measure("create", partial(client.save, vault, first.snapshot, None))
    report |= stats
    session.mark_saved(first, created)
    second = session.freeze()
    _, stats = measure("save", partial(client.save, vault, second.snapshot, created.revision_id))
    report |= stats
    # Release the UI-side copies before measuring a fresh open.
    session.documents.clear()
    del first, second
    _, stats = measure("open", partial(client.open, vault))
    report |= stats
    report["vault_file_mib"] = round(vault.stat().st_size / 2**20, 1)
    report["overhead_vs_documents"] = round(vault.stat().st_size / (total_mib * 2**20), 3)
    vault.unlink()
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mib", type=int, nargs="+", default=[50, 125, 250])
    parser.add_argument("--out", type=Path, default=Path("fase0-ram.json"))
    args = parser.parse_args()
    results: dict[str, Any] = {
        "platform": sys.platform,
        "cpu_count": os.cpu_count(),
        "total_ram_gib": round(psutil.virtual_memory().total / 2**30, 1),
        "runs": [],
    }
    with tempfile.TemporaryDirectory(prefix="opv-ram-") as tmp:
        for mib in args.mib:
            print(f"medindo {mib} MiB…", flush=True)
            results["runs"].append(run(mib, Path(tmp)))
    args.out.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
