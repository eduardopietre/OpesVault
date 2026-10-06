"""tax/statements.py: reading an informe de rendimentos and checking it against the records.

Three parts: `parse` over lists of lines (the synthetic informe, hand-written layouts and seeded
mutations of the text); `read` over document bytes (PDF through the desktop's extractor, CSV and
failures); and `check` over ledgers (a base ledger, commands through the public API, then every
saved report compared with what the app recorded for the same source and year: totals,
recorded, checks and differences).
"""

import base64
import random
from dataclasses import dataclass
from typing import Any

from opesvault.devtools.synthetic_pdf import make_pdf
from opesvault.domain.ledger import Ledger
from opesvault.importing.source import load_source
from opesvault.investments.service import positions
from opesvault.tax import records, statements
from scripts.golden.cases_investments import known_ids, norm, records_of, run_commands
from scripts.golden.cases_tax import TAX_COMMANDS, Y, base
from scripts.golden.common import j, outcome
from tests import synthetic_docs as docs
from tests.test_fuzz import _mutate_text

EMPLOYER = [
    "EMPRESA EXEMPLO LTDA - CNPJ 11.222.333/0001-81",
    "COMPROVANTE DE RENDIMENTOS PAGOS E DE IMPOSTO SOBRE A RENDA RETIDO NA FONTE",
    "Exercício de 2026 Ano-calendário de 2025",
    "Beneficiário: Ana Teste - CPF 529.982.247-25",
    "1. Rendimentos tributáveis, deduções e imposto retido na fonte",
    "Total dos rendimentos (inclusive férias) 120.000,00",
    "Contribuição previdenciária oficial 11.000,00",
    "Imposto retido na fonte 12.100,00",
    "2. Rendimentos isentos e não tributáveis",
    "Parcela isenta de aposentadoria 1.000,50",
    "Outros 10,00",
    "3. Rendimentos sujeitos à tributação exclusiva",
    "13º salário 9.500,00",
    "IRRF sobre 13º salário 900,00",
    "Participação nos lucros 3.000,00",
    "4. Informações complementares",
    "Valor R$ 1.234,56",
    "Plano de saúde -R$ 800,00",
]
ODD = [
    "ANO-CALENDARIO 1989",
    "Saldo em 31/12/2024 R$ 100,00",
    "Saldo em 31/12/2025 R$ 200,00",
    "Saldo em 31/12/2023 R$ 1,00",
    "Saldo anterior em 31/12 5,00",
    "Saldo final em 31/12 6,00",
    "Previdência oficial 7,00",
    "Contribuição previdenciária 8,00",
    "Décimo terceiro 9,00",
    "13 salário 10,00",
    "13º salário IRRF 11,00",
    "Imposto de renda retido 12,00",
    "IRRF 13,00",
    "Tributação definitiva 14,00",
    "Rendimentos não tributáveis 15,00",
    "Rendimentos tributáveis 16,00",
    "TOTAL DOS RENDIMENTOS 17,00",
    "Total isento 18,00",
    "R$ 19,00",
    "1. Seção sem campo",
    "Item solto 20,00",
    "CPF 111.444.777-35 21,00",
    "x " * 70 + "99,00",
    "100,00",
    "-1,50",
    "- R$ 2,50",
    "R 3,50",
    "1.234.567,89 isento",
]
HEADINGS = [
    "Informe de rendimentos",
    "1) Rendimentos isentos",
    "Poupança 1,00",
    "Outro 2,00",
    "2- Rendimentos sujeitos à tributação exclusiva",
    "CDB 3,00",
    "Total 4,00",
    "3. Rendimentos tributáveis",
    "x",
    "Item 5,00",
    "Item 6,00",
    "Total dos rendimentos tributáveis 11,00",
]
PAYERS = [
    ["Banco Exemplo - cnpj 11.222.333/0001-81", "Ano-calendário 2025", "Saldo em 31/12/2025 1,00"],
    ["  : - Banco CNPJ: 11.222.333/0001-81", "ano calendario de 2025"],
    ["Fonte,  CNPJ 11222333000181 Ltda", "Exercício 2026"],
    ["CNPJ 00.000.000/0000-00 inválido", "CNPJ 11.222.333/0001-81"],
    ["X" * 400 + " CNPJ 11.222.333/0001-81"],
    ["CNPJ", "CNPJ 11.222.333/0001-81 Empresa"],
    ["Exercício 2200", "Exercício 1990", "Exercício 1991"],
    ["ANO-CALENDARIO: 2999"],
    ["ANO-CALENDARIO: 2998 e depois ANO-CALENDARIO 2020"],
]


def _lines(data: bytes) -> list[str]:
    return [line.text for line in load_source("informe", data).lines]


def _parse(lines: list[str]) -> Any:
    parsed = statements.parse(lines)
    return {
        "year": parsed.year,
        "payer_tax_id": parsed.payer_tax_id,
        "payer_name": parsed.payer_name,
        "lines": [line.model_dump(mode="json") for line in parsed.lines],
        "skipped": parsed.skipped,
    }


def parse_cases() -> list[dict[str, Any]]:
    bank = _lines(docs.bank_income_report_pdf())
    sets = [
        ("synthetic bank", bank),
        ("synthetic bank 2024", _lines(docs.bank_income_report_pdf(2024))),
        ("employer", EMPLOYER),
        ("odd lines", ODD),
        ("headings", HEADINGS),
        ("empty", []),
        ("garbage", ["", "R$ ,00", "Saldo em 31/12/abcd 1,00", "x" * 5000, "CNPJ 00.000.000/0000-00"]),
        ("many lines", [f"Item {n} 1,00" for n in range(450)] + ["Total isento 3,00"]),
        ("totals win", ["Isento 1,00", "Total isento 2,00", "Isento 3,00", "TOTAL de isentos 4,00"]),
    ]
    sets += [(f"payers {n}", p) for n, p in enumerate(PAYERS)]
    rng = random.Random("informe-statements")
    base_text = "\n".join(bank)
    for n in range(80):
        sets.append((f"mutated bank {n}", _mutate_text(rng, base_text).splitlines()))
    employer_text = "\n".join(EMPLOYER)
    for n in range(60):
        sets.append((f"mutated employer {n}", _mutate_text(rng, employer_text).splitlines()))
    return [{"name": name, "lines": lines, "result": _parse(lines)} for name, lines in sets]


def read_cases() -> list[dict[str, Any]]:
    csv_informe = (
        "Descrição;Valor\n"
        "Ano-calendário 2025;\n"
        "Saldo em 31/12/2024;1.000,00\n"
        "Saldo em 31/12/2025;2.000,00\n"
        "Rendimentos isentos;12,34\n"
    ).encode()
    cases = [
        ("synthetic bank pdf", docs.bank_income_report_pdf(2025)),
        ("synthetic bank pdf 2024", docs.bank_income_report_pdf(2024)),
        ("employer pdf", make_pdf(EMPLOYER)),
        ("csv informe", csv_informe),
        ("scanned pdf", make_pdf([])),
        ("not a document", b"\x00\x01\x02"),
        ("pdf without an informe", docs.nubank_card_pdf()),
        ("ofx", docs.ofx_bank()),
    ]
    out = []
    for name, data in cases:
        out.append(
            {
                "name": name,
                "bytes": base64.b64encode(data).decode(),
                "result": outcome(lambda d=data: _parse_read(d)),  # type: ignore[misc]
            }
        )
    return out


def _parse_read(data: bytes) -> Any:
    parsed = statements.read(data)
    return {
        "year": parsed.year,
        "payer_tax_id": parsed.payer_tax_id,
        "payer_name": parsed.payer_name,
        "lines": [line.model_dump(mode="json") for line in parsed.lines],
        "skipped": parsed.skipped,
    }


# ── checks against the records ──────────


@dataclass
class Script:
    commands: list[dict[str, Any]]

    def add(self, cmd: str, *args: Any, **opts: Any) -> str:
        self.commands.append({"cmd": cmd, "args": list(args), "opts": opts})
        return f"${len(self.commands) - 1}"


CMDS: dict[str, Any] = {
    **TAX_COMMANDS,
    "cancel": lambda led, op, reason: led.cancel_operation(op, reason),
    "report_on_position_account": lambda led, year, pos, lines: records.save_report(
        led,
        year,
        records.ReportSource.ACCOUNT,
        positions(led)[pos].account_id,
        [records.ReportLine(**x) for x in lines],
    ),
}


def _line(field: str, amount: str, label: str = "") -> dict[str, Any]:
    return {"field": field, "amount": amount, "label": label}


def _employer() -> list[dict[str, Any]]:
    s = Script([])
    s.add("classify", "category", "@salary", "taxable_pj")
    jan = s.add("income", "@bank", "@salary", "4000.00", f"{Y}-01-05", "Salário", "@ana")
    s.add("set_income_detail", jan, "salary", "5000.00", "450.00", "550.00")
    feb = s.add("income", "@bank", "@salary", "4000.00", f"{Y}-02-05", "Salário", "@ana")
    s.add("set_income_detail", feb, "salary", "5000.00", "450.00", "550.00")
    s.add("income", "@bank", "@salary", "3500.00", f"{Y}-03-05", "Sem detalhe", "@ana")
    dec = s.add("income", "@bank", "@salary", "2000.00", f"{Y}-12-20", "13º", "@ana")
    s.add("set_income_detail", dec, "thirteenth", "2400.00", "150.00", None)
    bonus = s.add("income", "@joint", "@bonus", "1500.00", f"{Y}-07-10", "Bônus", "@bruno")
    s.add("set_income_detail", bonus, "salary", "1500.00", "0.00", "0.00")
    zero = s.add("income", "@joint", "@bonus", "100.00", f"{Y}-08-10", "Bônus 2", "@bruno")
    s.add("set_income_detail", zero, "other", None, "0", "0.00")
    s.add("income", "@bank", "@salary", "900.00", f"{Y - 1}-12-20", "Ano anterior")
    s.add("income", "@bank", "@salary", "900.00", f"{Y + 1}-01-02", "Ano seguinte")
    gone = s.add("income", "@bank", "@salary", "777.00", f"{Y}-05-05", "Cancelado")
    s.add("cancel", gone, "engano")
    s.add("income", "@bank", "@freelance", "100.00", f"{Y}-06-05", "Outra fonte")
    s.add(
        "save_report",
        Y,
        "category",
        "@salary",
        [
            _line("taxable", "17500.00", "Total dos rendimentos"),
            _line("thirteenth", "2400.00"),
            _line("withheld", "900.00"),
            _line("social_security", "1100.00"),
            _line("exempt", "10.00"),
        ],
        payer_tax_id="11.222.333/0001-81",
    )
    s.add("save_report", Y, "category", "@bonus", [_line("taxable", "1500.00"), _line("withheld", "0.00")])
    s.add("save_report", Y, "category", "@freelance", [_line("taxable", "100.01"), _line("withheld", "1.00")])
    s.add("save_report", Y, "category", "@rent", [_line("taxable", "0.00")])
    return s.commands


def _bank() -> list[dict[str, Any]]:
    s = Script([])
    s.add("opening", "@savings", "1000.00", f"{Y - 1}-01-02")
    s.add("income", "@bank", "@other_income", "1400.00", f"{Y}-06-01", "Depósito")
    cdb = s.add(
        "create_position",
        "CDB X",
        "fixed_income",
        f"{Y}-02-01",
        initial_cost="5000",
        from_account="@bank",
        holder_id="@ana",
    )
    s.add("add_valuation", cdb, f"{Y}-12-31", "5400", "gross")
    s.add("classify", "position", cdb, "exclusive")
    s.add("distribute", cdb, "40.00", f"{Y}-08-01", "@bank", "6.00")
    s.add("redeem", cdb, f"{Y}-10-01", "1000.00", "@bank", cost_attributed="900.00", tax_withheld="15.00")
    s.add("redeem", cdb, f"{Y}-11-01", "500.00", "@bank", cost_attributed="600.00")
    s.add("redeem", cdb, f"{Y + 1}-01-15", "100.00", "@bank", cost_attributed="90.00", tax_withheld="2.00")
    lci = s.add("create_position", "LCI Y", "fixed_income", f"{Y - 1}-03-01", initial_cost="8000", from_account="@bank")
    s.add("classify", "position", lci, "exempt")
    s.add("distribute", lci, "120.00", f"{Y}-03-01", "@bank")
    s.add("redeem", lci, f"{Y}-05-01", "2000.00", "@bank", cost_attributed="1900.00", tax_withheld="0.50")
    fund = s.add("create_position", "Fundo Z", "fund", f"{Y - 1}-03-01", reference_value="8000.00", holder_id="@bruno")
    s.add("distribute", fund, "55.55", f"{Y}-09-01", "@bank")
    s.add("distribute", fund, "10.00", f"{Y}-09-02", "@broker", "1.00")
    s.add("distribute", cdb, "7.00", f"{Y}-12-01", "@bank")
    stock = s.add("create_position", "PETR4", "stock", f"{Y}-01-02", mode="quantity", holder_id="@ana")
    s.add("buy", stock, f"{Y}-01-02", "100", "20.00", "@bank")
    s.add("classify", "position", stock, "exempt")
    s.add("sell", stock, f"{Y}-03-10", "50", "25.00", "@bank", fees="1.00", tax_withheld="0.02")
    s.add("sell", stock, f"{Y}-04-10", "50", "10.00", "@bank")
    other = s.add("create_position", "ETF B", "etf", f"{Y}-01-02", mode="quantity")
    s.add("buy", other, f"{Y}-01-02", "10", "100.00", "@broker")
    s.add("classify", "position", other, "exclusive")
    s.add("sell", other, f"{Y}-02-02", "5", "120.00", "@broker")
    s.add(
        "save_report",
        Y,
        "account",
        "@bank",
        [
            _line("balance_previous", "30000.00"),
            _line("balance_end", "1234.56"),
            _line("exempt", "120.00"),
            _line("exclusive", "300.00"),
            _line("withheld", "21.52"),
            _line("taxable", "5.00"),
        ],
    )
    s.add("save_report", Y, "account", "@broker", [_line("balance_end", "200000.00"), _line("withheld", "1.00")])
    s.add(
        "save_report", Y, "account", "@joint", [_line("balance_previous", "5000.00"), _line("balance_end", "5000.01")]
    )
    s.add("save_report", Y, "account", "@loan", [_line("balance_end", "20000.00")])
    s.add("report_on_position_account", Y, cdb, [_line("exempt", "1.00"), _line("exclusive", "2.00")])
    s.add("report_on_position_account", Y, fund, [_line("withheld", "1.00"), _line("exempt", "55.55")])
    s.add("save_report", Y - 1, "account", "@bank", [_line("balance_end", "30000.00")])
    s.add("save_report", Y + 1, "account", "@bank", [_line("balance_previous", "1.00")])
    return s.commands


def _snapshot(ledger: Ledger, known: set[str]) -> dict[str, Any]:
    out = []
    for report in records.reports(ledger).values():
        checks = statements.check(ledger, report)
        out.append(
            {
                "report": norm(j(report), known),
                "totals": {k.value: j(v) for k, v in statements.totals(report).items()},
                "recorded": {k.value: j(v) for k, v in statements.recorded(ledger, report).items()},
                "checks": [
                    {
                        "field": c.field.value,
                        "informed": j(c.informed),
                        "recorded": j(c.recorded),
                        "note": c.note,
                        "difference": j(c.difference),
                        "matches": c.matches,
                    }
                    for c in checks
                ],
                "differences": [c.field.value for c in statements.differences(ledger, report)],
            }
        )
    return {"reports": out}


def _scenario(name: str, commands: list[dict[str, Any]]) -> dict[str, Any]:
    ledger, names = base()
    known = known_ids(ledger)
    return {
        "name": name,
        "records": records_of(ledger),
        "names": names,
        "commands": commands,
        "results": run_commands(ledger, commands, names, CMDS, known),
        "snapshot": _snapshot(ledger, known),
    }


def generate() -> dict[str, Any]:
    return {
        "parse": parse_cases(),
        "read": read_cases(),
        "scenarios": [_scenario("employer informe", _employer()), _scenario("bank and broker informes", _bank())],
    }
