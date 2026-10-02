import sys


def main() -> int:
    args = sys.argv[1:]
    if args[:1] == ["--vault-worker"]:
        from opesvault.vault.worker import worker_main

        return worker_main()
    if args[:1] == ["--self-test"]:
        from opesvault.selftest import selftest_main

        return selftest_main()

    from PySide6.QtWidgets import QApplication

    from opesvault.ui.main_window import MainWindow

    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    return app.exec()
