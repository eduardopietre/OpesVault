"""registry.py: every persisted kind and the number of guards a fresh process knows.

`test_registry_loads_every_kind_in_a_fresh_process` expects a fixed set; this also dumps the whole
set, so the TS port can check it registers at least the same kinds.
"""

import subprocess
import sys
from typing import Any


def generate() -> dict[str, Any]:
    code = (
        "import json;"
        "from opesvault.domain.ledger import Ledger; Ledger();"
        "print(json.dumps({'kinds': sorted(Ledger.KINDS),"
        " 'operation_guards': len(Ledger._operation_guards), 'update_guards': len(Ledger._update_guards)}))"
    )
    out = subprocess.run([sys.executable, "-c", code], check=True, capture_output=True, text=True).stdout
    import json

    fresh = json.loads(out)
    return {
        "expected_by_the_desktop_test": [
            "installment_plan",
            "recurrence_rule",
            "forecast_link",
            "period_close",
            "settings",
            "import_batch",
            "evidence",
            "extracted_item",
            "asset",
            "position",
            "valuation",
            "investment_event",
            "tax_rule",
        ],
        **fresh,
    }
