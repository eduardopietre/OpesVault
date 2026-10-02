"""DEVELOPMENT ONLY: vault worker that takes a throwaway password from the environment.

Lets tests and phase 0 measurements drive the real worker protocol without a
dialog. It lives outside the package so it can never ship in the executable.
Never use it with a real vault or a real password.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from opesvault.vault import sqlcipher_store
from opesvault.vault.errors import ErrorCode
from opesvault.vault.worker import Purpose, serve, take_protocol_streams

PASSWORD_ENV = "OPV_DEV_PASSWORD"
FAULT_ENV = "OPV_DEV_FAULT_STAGE"


class EnvPasswordProvider:
    def __init__(self) -> None:
        self._password = os.environ.pop(PASSWORD_ENV, None)

    def ask(self, purpose: Purpose, previous_error: ErrorCode | None) -> str | None:
        # Retries repeat the same password, so a wrong one ends as WRONG_PASSWORD.
        return self._password


def _fault_hook() -> sqlcipher_store.FaultHook | None:
    stage = os.environ.get(FAULT_ENV)
    if not stage:
        return None

    def hook(current: str) -> None:
        if current == stage:
            os._exit(99)  # Simulates the process dying (power loss, kill) at this stage.

    return hook


if __name__ == "__main__":
    proto_in, proto_out = take_protocol_streams()
    with proto_in, proto_out:
        sys.exit(serve(proto_in, proto_out, EnvPasswordProvider(), _fault_hook()))
