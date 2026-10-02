import sys

__version__ = "0.1.0"


def main() -> int:
    args = sys.argv[1:]
    if args[:1] == ["--vault-worker"]:
        from opesvault.vault.worker import worker_main

        return worker_main()
    if args[:1] == ["--self-test"]:
        from opesvault.selftest import selftest_main

        return selftest_main()

    from PySide6.QtWidgets import QApplication, QMessageBox

    from opesvault import diagnostics
    from opesvault.ui.main_window import MainWindow
    from opesvault.ui.theme import apply_theme, follow_system

    app = QApplication(sys.argv)
    app.setApplicationName("OpesVault")
    apply_theme(app)
    follow_system(app)

    def report(incident: str) -> None:
        QMessageBox.critical(
            None,
            "OpesVault",
            f"Ocorreu um erro inesperado (ocorrência {incident}).\n"
            "Os dados abertos continuam na memória: salve assim que possível.\n"
            "O registro técnico guarda só códigos, sem dados financeiros.",
        )

    diagnostics.install(report)
    window = MainWindow()
    window.show()
    # Double-clicking a .opesvault file (optional installer association) opens it.
    vault_args = [a for a in args if a.lower().endswith(".opesvault")]
    if vault_args:
        from pathlib import Path

        window.open_path(Path(vault_args[0]))
    return app.exec()
