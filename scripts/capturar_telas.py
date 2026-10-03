"""Renders every page with synthetic demo data and saves PNG screenshots (UI review tool).

    uv run python scripts/capturar_telas.py [--out DIR] [--size 1280x800] [--dark]

Development only: the data is synthetic and nothing is saved to a vault.
"""

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
# "offscreen" has no font database on Windows; "minimal:enable_fonts" renders with Segoe UI.
os.environ.setdefault("QT_QPA_PLATFORM", "minimal:enable_fonts" if sys.platform == "win32" else "offscreen")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=ROOT / "build" / "telas")
    parser.add_argument("--size", default="1280x800")
    parser.add_argument("--dark", action="store_true")
    parser.add_argument("--tabs", action="store_true", help="também cada aba das páginas com abas")
    args = parser.parse_args()
    width, height = (int(v) for v in args.size.split("x"))

    from PySide6.QtWidgets import QApplication

    app = QApplication(sys.argv)
    from opesvault.ui.theme import apply_theme

    apply_theme(app, dark=args.dark if args.dark else None)
    from opesvault.ui.main_window import MainWindow

    args.out.mkdir(parents=True, exist_ok=True)
    window = MainWindow()
    window.resize(width, height)
    window.show()
    app.processEvents()  # let layout and styles settle before the first capture
    window.grab().save(str(args.out / "00-sem-cofre.png"))
    from tests.demo_vault import demo_session

    window.session = demo_session(args.out / "demo.opesvault")
    window._refresh()
    from opesvault.ui.common import select_combo

    for page in window.pages:
        if type(page).__name__ == "TaxPage":
            select_combo(page.year, 2026)  # the demo data is from 2026  # type: ignore[attr-defined]
    for index, page in enumerate(window.pages):
        window.show_page(index)
        for _ in range(5):
            app.processEvents()
        slug = page.title.lower().replace(" ", "-")
        window.grab().save(str(args.out / f"{index + 1:02d}-{slug}.png"))
        tabs = getattr(page, "tabs", None)
        if args.tabs and tabs is not None:
            for tab in range(1, tabs.count()):
                tabs.setCurrentIndex(tab)
                for _ in range(3):
                    app.processEvents()
                name = tabs.tabText(tab).lower().replace(" ", "-")
                window.grab().save(str(args.out / f"{index + 1:02d}{chr(96 + tab)}-{slug}-{name}.png"))
            tabs.setCurrentIndex(0)
    window.lock_screen()
    app.processEvents()
    window.grab().save(str(args.out / "99-bloqueado.png"))
    print(f"Telas em {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
