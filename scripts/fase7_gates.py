"""Phase 7 gates that can run without the packaged executable (docs/11 §4).

    uv run python scripts/fase7_gates.py disco      # G4: no plaintext left on disk after a full session
    uv run python scripts/fase7_gates.py antivirus [--mib 250 --salvamentos 20]   # G5: saves under the antivirus

Both go through the real vault worker (scripts/dev_worker.py, random throwaway password) and
synthetic documents only. Work files live in build/fase7 and are removed at the end; the
reports (build/fase7/*.json) hold no values, names or passwords.

G4 in Python mode does not replace the check on OpesVault.exe; it shows whether the app's
own code leaves anything behind. Other programs also write to %TEMP% while it runs: every
new entry is listed, and the ones that belong to OpesVault are flagged.
"""

import argparse
import io
import json
import os
import secrets
import shutil
import sys
import tempfile
import time
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

WORK = ROOT / "build" / "fase7"
PDF_PASSWORD = "12345678900"  # password of a synthetic test document
PDF_OWNER = "proprietario"


def _client() -> Any:
    from opesvault.vault.client import VaultClient

    os.environ["OPV_DEV_PASSWORD"] = secrets.token_urlsafe(24)
    return VaultClient([sys.executable, str(ROOT / "scripts" / "dev_worker.py")])


def _listing(root: Path, depth: int) -> set[str]:
    """Paths under `root` down to `depth` levels (enough to see what a run leaves behind)."""
    found: set[str] = set()
    if not root.exists():
        return found
    stack = [(root, 0)]
    while stack:
        folder, level = stack.pop()
        try:
            for entry in os.scandir(folder):
                found.add(entry.path)
                if entry.is_dir(follow_symlinks=False) and level + 1 < depth:
                    stack.append((Path(entry.path), level + 1))
        except OSError:
            continue
    return found


def disk(args: argparse.Namespace) -> dict[str, Any]:
    """G4: a full session, then every file that appeared where plaintext could leak."""
    from opesvault.importing import pipeline
    from opesvault.importing.pipeline import ImportRequest
    from opesvault.pdf_render import render_page
    from opesvault.session import Session
    from opesvault.vault.lock import VaultLock
    from tests import synthetic_docs as docs

    folder = WORK / "g4-cofre"
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    places = {
        "TEMP": (Path(tempfile.gettempdir()), 3),
        "LOCALAPPDATA": (Path(os.environ.get("LOCALAPPDATA", tempfile.gettempdir())), 2),
        "pasta do cofre": (folder, 3),
    }
    before = {name: _listing(path, depth) for name, (path, depth) in places.items()}
    started = time.time()

    vault = folder / "familia.opesvault"
    lock = VaultLock(vault)
    lock.acquire()
    client = _client()
    session = Session.new(vault, "Projeto Teste")
    plain = docs.nubank_card_pdf()
    pipeline.import_document(session, ImportRequest("fatura.pdf", plain))
    protected = _protected(plain)
    pipeline.import_document(session, ImportRequest("fatura-protegida.pdf", protected, password=PDF_PASSWORD))
    pipeline.import_document(session, ImportRequest("extrato.csv", docs.nubank_account_csv()))
    render_page(plain)
    render_page(protected, password=PDF_PASSWORD)
    frozen = session.freeze()
    session.mark_saved(frozen, client.save_frozen(frozen))
    reopened = Session.from_opened(vault, client.open_raw(vault))
    reopened.ledger.add_member("Bruno")
    frozen = reopened.freeze()
    reopened.mark_saved(frozen, client.save_frozen(frozen))
    lock.release()

    after = {name: _listing(path, depth) for name, (path, depth) in places.items()}
    expected = {str(vault), str(vault) + ".lock"}
    new: dict[str, list[str]] = {}
    for name in places:
        added = sorted(after[name] - before[name] - expected)
        new[name] = [_describe(Path(p), started) for p in added]
    ours = [
        entry for entries in new.values() for entry in entries if "opesvault" in entry.lower() or "opv" in entry.lower()
    ]
    report = {
        "gate": "G4 (modo Python)",
        "arquivos_do_cofre": sorted(Path(p).name for p in after["pasta do cofre"] if Path(p).is_file()),
        "novos_por_local": new,
        "novos_do_opesvault": ours,
        "aprovado": not ours and not new["pasta do cofre"],
    }
    shutil.rmtree(folder, ignore_errors=True)
    return report


def _describe(path: Path, started: float) -> str:
    try:
        created = path.stat().st_ctime >= started - 1
    except OSError:
        return f"{path} (já removido)"
    return f"{path}{'' if created else ' (mais antigo que o teste)'}"


def _protected(data: bytes) -> bytes:
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(data)))
    writer.encrypt(user_password=PDF_PASSWORD, owner_password=PDF_OWNER, algorithm="AES-256")
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def antivirus(args: argparse.Namespace) -> dict[str, Any]:
    """G5: consecutive saves of a large vault with the antivirus watching every new file."""
    from opesvault.devtools.synthetic_pdf import make_pdf
    from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount
    from opesvault.session import Session
    from opesvault.vault.errors import VaultError

    folder = WORK / "g5-cofre"
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    client = _client()
    vault = folder / "grande.opesvault"
    session = Session.new(vault, "Projeto Teste")
    for i in range(max(1, args.mib // 2)):
        session.add_document(f"extrato-{i:04d}.pdf", make_pdf([f"Documento {i}"], padding_bytes=2 * 2**20))
    ledger = session.ledger
    bank = ledger.add_account(LedgerAccount(name="Banco", type=AccountType.ASSET, subtype=AccountSubtype.CHECKING))
    category = ledger.categories(AccountType.EXPENSE)[0]
    t0 = time.perf_counter()
    frozen = session.freeze()
    session.mark_saved(frozen, client.save_frozen(frozen))
    created_s = time.perf_counter() - t0
    results: list[dict[str, Any]] = []
    for n in range(args.salvamentos):
        session.ledger.record_expense(bank.id, category.id, "9.99", date(2026, 2, 1), f"Lancamento {n}")
        frozen = session.freeze()
        started = time.perf_counter()
        try:
            revision = client.save_frozen(frozen)
            session.mark_saved(frozen, revision)
            results.append({"ok": True, "s": round(time.perf_counter() - started, 2)})
        except VaultError as exc:
            results.append({"ok": False, "erro": exc.code.value, "s": round(time.perf_counter() - started, 2)})
    failures = [r["erro"] for r in results if not r["ok"]]
    times = [r["s"] for r in results if r["ok"]]
    report = {
        "gate": "G5 (modo Python)",
        "documentos_mib": args.mib,
        "criar_s": round(created_s, 1),
        "salvamentos": len(results),
        "falhas": len(failures),
        "codigos_de_falha": sorted(set(failures)),
        "replace_failed": failures.count("replace_failed"),
        "tempo_medio_s": round(sum(times) / len(times), 2) if times else None,
        "tempo_maximo_s": max(times) if times else None,
        "aprovado": not failures,
    }
    shutil.rmtree(folder, ignore_errors=True)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="gate", required=True)
    sub.add_parser("disco", help="G4: nenhum arquivo em claro depois de uma sessão completa")
    av = sub.add_parser("antivirus", help="G5: salvamentos seguidos com o antivírus ativo")
    av.add_argument("--mib", type=int, default=250)
    av.add_argument("--salvamentos", type=int, default=20)
    args = parser.parse_args()
    report = disk(args) if args.gate == "disco" else antivirus(args)
    WORK.mkdir(parents=True, exist_ok=True)
    out = WORK / f"{args.gate}.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"\nRelatório em {out}")


if __name__ == "__main__":
    main()
