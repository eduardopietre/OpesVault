"""Vault error codes.

Codes are the only thing that crosses process boundaries or reaches logs when a
vault operation fails: they never carry paths, names, values or document text.
"""

from enum import StrEnum


class ErrorCode(StrEnum):
    CANCELLED = "CANCELLED"
    WRONG_PASSWORD = "WRONG_PASSWORD"
    PASSWORD_MISMATCH = "PASSWORD_MISMATCH"
    NOT_FOUND = "NOT_FOUND"
    ALREADY_EXISTS = "ALREADY_EXISTS"
    NOT_A_VAULT = "NOT_A_VAULT"
    INCOMPATIBLE_FORMAT = "INCOMPATIBLE_FORMAT"
    REVISION_MISMATCH = "REVISION_MISMATCH"
    VERIFY_FAILED = "VERIFY_FAILED"
    REPLACE_FAILED = "REPLACE_FAILED"
    LOCKED = "LOCKED"
    IO_ERROR = "IO_ERROR"
    PROTOCOL_ERROR = "PROTOCOL_ERROR"
    # The worker vanished after it may have started replacing the file: the
    # caller must re-open and inspect the vault before retrying.
    UNCERTAIN = "UNCERTAIN"
    INTERNAL = "INTERNAL"


class VaultError(Exception):
    def __init__(self, code: ErrorCode) -> None:
        super().__init__(code.value)
        self.code = code
