"""catalogs (banks, irpf), tax/ids.py and the pure helpers of investments/profile.py.

The embedded lists are compared whole; lookups, searches, CPF/CNPJ checks over seeded digit
strings and the profile labels are compared output by output.
"""

import random
from decimal import Decimal
from typing import Any

from opesvault.catalogs import bank, banks, search
from opesvault.catalogs.irpf import ASSET_CODES, EXCLUSIVE_CODES, EXEMPT_CODES, GROUPS, asset_label, is_asset_code
from opesvault.investments import profile as prof
from opesvault.tax import ids
from scripts.golden.common import outcome


def _ids_cases() -> list[dict[str, Any]]:
    rng = random.Random(77)
    texts = [
        "529.982.247-25",
        "529.982.247-24",
        "111.111.111-11",
        "11.222.333/0001-81",
        "11.222.333/0001-80",
        "00000000000000",
        "60701190000104",
        "",
        "abc",
        "  12345678909 ",
        "CNPJ 11.222.333/0001-81 e 60.701.190/0001-04",
        "conta 11222333000181x",
        "Banco - CNPJ 11222333/0001-81",
    ]
    for _ in range(80):
        n = rng.choice([11, 14, 10, 13])
        digits = "".join(str(rng.randint(0, 9)) for _ in range(n))
        texts.append(digits)
    # valid ones: complete random bases with their check digits
    for _ in range(20):
        base = "".join(str(rng.randint(0, 9)) for _ in range(9))
        for d1 in range(10):
            for d2 in range(10):
                if ids.is_cpf(base + f"{d1}{d2}"):
                    texts.append(base + f"{d1}{d2}")
    out = []
    for text in texts:
        out.append(
            {
                "text": text,
                "digits": ids.digits(text),
                "is_cpf": ids.is_cpf(text),
                "is_cnpj": ids.is_cnpj(text),
                "kind": ids.kind_of(text),
                "normalize": outcome(ids.normalize, text),
                "normalize_cpf": outcome(ids.normalize, text, (ids.TaxIdKind.CPF,)),
                "display": ids.display(text),
                "find_cnpj": ids.find_cnpj(text),
            }
        )
    return out


def generate() -> dict[str, Any]:
    queries = ["", "  ", "nu pagamentos", "341", "itau", "ITAÚ", "banco do brasil", "caixa", "001", "0", "xyz", "s.a."]
    codes = ["1", "001", " 341 ", "999", "", None, "0001", "260", "77"]
    groups = [*GROUPS, "00", None]
    labels = []
    for group in groups:
        for code in [None, "", "01", "02", "03", "06", "09", "12", "77"]:
            labels.append([group, code, asset_label(group, code), is_asset_code(group or "", code or "")])
    classes = []
    for group in [*GROUPS, "00"]:
        for code in ["01", "02", "03", "06", "08", "09", "99", "77"]:
            treatment = prof.tax_for(group, code)
            classes.append([group, code, prof.class_for(group, code).value, treatment.value if treatment else None])
    yields = []
    for indexer in [None, *prof.Indexer]:
        for rate in [None, "110", "6.5", "12.40", "-1", "1234.5678"]:
            profile = prof.InvestmentProfile(
                position_id="6b3d6a0e-0000-4000-8000-0000000000aa",  # type: ignore[arg-type]
                indexer=indexer,
                rate=Decimal(rate) if rate is not None else None,
            )
            yields.append([indexer.value if indexer else None, rate, prof.yield_text(profile)])
    income_labels = [
        [code, prof.income_code_label(code)]
        for code in [None, "", "isento:09", "isento:12", "isento:99", "exclusivo:06", "exclusivo:12", "exclusivo:77"]
    ]
    return {
        "banks": [[b.code, b.ispb, b.cnpj, b.short_name, b.name, b.label] for b in banks()],
        "lookups": [[code, (lambda b: b.code if b else None)(bank(code))] for code in codes],
        "searches": [[q, [b.code for b in search(q)], [b.code for b in search(q, 3)]] for q in queries],
        # lists of pairs: the order of the IRPF tables is part of what is compared
        "asset_codes": [[g, name, list(codes.items())] for g, (name, codes) in ASSET_CODES.items()],
        "exempt_codes": list(EXEMPT_CODES.items()),
        "exclusive_codes": list(EXCLUSIVE_CODES.items()),
        "labels": labels,
        "classes": classes,
        "yields": yields,
        "income_labels": income_labels,
        "ids": _ids_cases(),
    }
