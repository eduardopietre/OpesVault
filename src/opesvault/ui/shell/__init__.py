"""The main window's parts: sidebar, welcome screen, vault commands, backups, lock and recents.

`opesvault.ui.main_window.MainWindow` assembles them. Widgets with their own state (the
sidebar, the welcome screen) are classes the window holds; command groups that act on the
window's session are mixins typed against `contract.WindowParts`.
"""
