"""investments/{service,performance,returns,trades,simulation}.py: docs/06 examples A-F and seeded portfolios.

Each scenario starts from a base ledger (records), replays a list of commands through the public
API and dumps every outcome (the result without new ids, or the DomainError message) and a
snapshot of every query over the result: balances, operations, lots, valuations, events, period
results, TWR, XIRR, Modified Dietz, unrealized and realized results, value at a date,
composition, proportional cost and simulations. The TS side loads the same records, replays the
same commands and must produce the same JSON. Ids created while replaying are random on both
sides, so the dump writes "<new>" for every id that is not in the base records.
"""

import random
import re
from datetime import date, timedelta
from decimal import Decimal
from itertools import pairwise
from typing import Any
from uuid import UUID

from pydantic import BaseModel

from opesvault.domain import queries
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount
from opesvault.investments import performance, returns, service, simulation, trades
from opesvault.investments.model import AssetClass, TaxRule, TaxRuleKind, TrackingMode, ValueNature
from scripts.golden.common import j, outcome

UUID_TEXT = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
UUID_IN_TEXT = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
MISSING_REF = "00000000-0000-4000-8000-0000000000ff"
START = date(2026, 1, 1)


# ── JSON with the ids of the base records only ──────────


def norm(value: Any, known: set[str]) -> Any:
    """Every id that is not in the base records becomes "<new>" (both sides create random ids), in text too."""
    if isinstance(value, str):
        return UUID_IN_TEXT.sub(lambda m: m.group() if m.group() in known else "<new>", value)
    if isinstance(value, list):
        return [norm(v, known) for v in value]
    if isinstance(value, dict):
        return {k: norm(v, known) for k, v in value.items()}
    return value


def dump(entity: BaseModel | None) -> Any:
    return entity.model_dump(mode="json") if entity is not None else None


def known_ids(ledger: Ledger) -> set[str]:
    out: set[str] = set()
    for i, _kind, payload in ledger.to_records():
        out.add(str(i))
        _collect(payload, out)
    return out


def _collect(value: Any, out: set[str]) -> None:
    if isinstance(value, str) and UUID_TEXT.match(value):
        out.add(value)
    elif isinstance(value, list):
        for v in value:
            _collect(v, out)
    elif isinstance(value, dict):
        for v in value.values():
            _collect(v, out)


def records_of(ledger: Ledger) -> list[dict[str, Any]]:
    return [{"id": str(i), "kind": k, "payload": p} for i, k, p in ledger.to_records()]


# ── commands ──────────


def _d(text: str) -> date:
    return date.fromisoformat(text)


def _maybe_date(text: str | None) -> date | None:
    return date.fromisoformat(text) if text else None


def _opts(options: dict[str, Any]) -> dict[str, Any]:
    out = dict(options)
    for key, kind in (
        ("mode", TrackingMode),
        ("reference_nature", ValueNature),
        ("nature", ValueNature),
        ("method", trades.CostMethod),
    ):
        if out.get(key) is not None:
            out[key] = kind(out[key])
    if "settled_on" in out:
        out["settled_on"] = _maybe_date(out["settled_on"])
    return out


INVESTMENT_COMMANDS: dict[str, Any] = {
    "create_position": lambda led, name, cls, on, **o: service.create_position(
        led, name, AssetClass(cls), _d(on), **_opts(o)
    ),
    "add_valuation": lambda led, pos, on, value, nature, **o: service.add_valuation(
        led, pos, _d(on), value, ValueNature(nature), **o
    ),
    "correct_valuation": lambda led, val, value, reason, nature=None: service.correct_valuation(
        led, val, value, reason, ValueNature(nature) if nature else None
    ),
    "select_valuation": lambda led, val: service.select_valuation(led, val),
    "contribute": lambda led, pos, amount, on, src: service.contribute(led, pos, amount, _d(on), src),
    "distribute": lambda led, pos, gross, on, dst, tax="0": service.distribute(led, pos, gross, _d(on), dst, tax),
    "redeem": lambda led, pos, on, gross, dst, **o: service.redeem(led, pos, _d(on), gross, dst, **o),
    "redeem_net_only": lambda led, pos, on, net, dst: service.redeem_net_only(led, pos, _d(on), net, dst),
    "complete_redemption": lambda led, event, gross, **o: service.complete_redemption(led, event, gross, **o),
    "pay_tax": lambda led, amount, on, src: service.pay_tax(led, amount, _d(on), src),
    "buy": lambda led, pos, on, qty, price, src, **o: trades.buy(led, pos, _d(on), qty, price, src, **_opts(o)),
    "sell": lambda led, pos, on, qty, price, dst, **o: trades.sell(led, pos, _d(on), qty, price, dst, **_opts(o)),
    "split": lambda led, pos, on, factor: trades.split(led, pos, _d(on), factor),
    "bonus": lambda led, pos, on, qty, cost="0": trades.bonus(led, pos, _d(on), qty, cost),
    "opening_lot": lambda led, pos, on, qty, cost: trades.opening_lot(led, pos, _d(on), qty, cost),
    # a simulation writes nothing; its outcome is compared like any command's (RULES by index)
    "simulate": lambda led, pos, on, gross, rule, **o: simulation.simulate(led, pos, _d(on), gross, RULES[rule], **o),
}


def run_commands(
    ledger: Ledger,
    commands: list[dict[str, Any]],
    names: dict[str, str],
    table: dict[str, Any],
    known: set[str],
) -> list[dict[str, Any]]:
    """Replays the commands. "$N" is the id returned by command N, "@name" a base id."""
    refs: dict[str, str] = {}

    def resolve(value: Any) -> Any:
        if isinstance(value, str) and value.startswith("$"):
            return UUID(refs.get(value, MISSING_REF))
        if isinstance(value, str) and value.startswith("@"):
            return UUID(names[value[1:]])
        if isinstance(value, list):
            return [resolve(v) for v in value]
        if isinstance(value, dict):
            return {k: resolve(v) for k, v in value.items()}
        return value

    results: list[dict[str, Any]] = []
    for index, command in enumerate(commands):
        args = [resolve(a) for a in command.get("args", [])]
        options = {k: resolve(v) for k, v in command.get("opts", {}).items()}
        try:
            result = table[command["cmd"]](ledger, *args, **options)
        except DomainError as exc:
            results.append({"error": str(exc)})
            continue
        except Exception:
            results.append({"raised": True})
            continue
        if isinstance(result, BaseModel) and hasattr(result, "id"):
            refs[f"${index}"] = str(getattr(result, "id"))  # noqa: B009
        results.append({"ok": norm(j(result), known)})
    return results


# ── snapshot ──────────


def _result(r: performance.Result) -> Any:
    return j(r)


def _observed(o: performance.Observed | None, known: set[str]) -> Any:
    return None if o is None else {"valuation": norm(dump(o.valuation), known), "age_days": o.age_days}


RULES = [
    TaxRule(
        id=UUID("6b3d6a0e-0000-4000-8000-000000000001"),
        name="Fictícia 15% sobre ganho",
        kind=TaxRuleKind.RATE_ON_POSITIVE_GAIN,
        rate=Decimal("0.15"),
    ),
    TaxRule(
        id=UUID("6b3d6a0e-0000-4000-8000-000000000002"),
        name="Valor fixo",
        version="2",
        kind=TaxRuleKind.FIXED,
        fixed_amount=Decimal("50.00"),
        source="tabela da corretora",
    ),
    TaxRule(
        id=UUID("6b3d6a0e-0000-4000-8000-000000000003"),
        name="Base informada 22,5%",
        kind=TaxRuleKind.RATE_ON_INFORMED_BASE,
        rate=Decimal("0.225"),
    ),
    TaxRule(
        id=UUID("6b3d6a0e-0000-4000-8000-000000000004"),
        name="Vigência 2026",
        kind=TaxRuleKind.RATE_ON_POSITIVE_GAIN,
        rate=Decimal("0.175"),
        valid_from=date(2026, 1, 1),
        valid_to=date(2026, 12, 31),
    ),
    TaxRule(
        id=UUID("6b3d6a0e-0000-4000-8000-000000000005"),
        name="Zero",
        kind=TaxRuleKind.FIXED,
        fixed_amount=Decimal("0.00"),
    ),
]


def _probes(ledger: Ledger, position_id: UUID) -> list[date]:
    pos = service.positions(ledger)[position_id]
    dates = {pos.opened_on, *(v.on for v in service.valuations_of(ledger, position_id))}
    dates |= {e.on for e in service.events_of(ledger, position_id)}
    return sorted(dates)[:10]


def _windows(probes: list[date]) -> list[tuple[date, date]]:
    out = list(pairwise(probes))
    if len(probes) > 2:
        out.append((probes[0], probes[-1]))
        out.append((probes[0], probes[len(probes) // 2]))
    if probes:
        out.append((probes[0], probes[0]))
    return out[:10]


def position_snapshot(ledger: Ledger, position_id: UUID, known: set[str]) -> dict[str, Any]:
    pos = service.positions(ledger)[position_id]
    probes = _probes(ledger, position_id)
    after = [p + timedelta(days=50) for p in probes[-1:]]
    out: dict[str, Any] = {
        "position": norm(dump(pos), known),
        "asset": norm(dump(service.assets(ledger)[pos.asset_id]), known),
        "probes": j(probes),
        "remaining_cost": j(service.remaining_cost(ledger, position_id)),
        "remaining_cost_at": [j(service.remaining_cost(ledger, position_id, p)) for p in probes],
        "valuations": [norm(dump(v), known) for v in service.valuations_of(ledger, position_id)],
        "selected": [norm(str(v.id), known) for v in performance.selected_series(ledger, position_id)],
        "events": [
            {"event": norm(dump(e), known), "realized_gain": j(e.realized_gain)}
            for e in service.events_of(ledger, position_id)
        ],
        "lots": [norm(dump(lot), known) for lot in trades.lots_of(ledger, position_id)],
        "open_lots": len(trades.lots_of(ledger, position_id, open_only=True)),
    }
    h = trades.holding(ledger, position_id)
    out["holding"] = {"quantity": j(h.quantity), "cost": j(h.cost), "average_price": j(h.average_price)}
    out["quantity_on"] = [j(trades.quantity_on(ledger, position_id, p)) for p in probes]
    out["value_at"] = [
        {
            "any": _observed(performance.value_at(ledger, position_id, p), known),
            "gross": _observed(performance.value_at(ledger, position_id, p, ValueNature.GROSS), known),
        }
        for p in [*probes, *after]
    ]
    out["unrealized"] = [_result(performance.unrealized(ledger, position_id, p)) for p in [*probes, *after]]
    out["realized"] = [_result(performance.realized(ledger, position_id, p)) for p in [*probes, None]]
    windows = []
    for a, b in _windows(probes):
        windows.append(
            {
                "start": j(a),
                "end": j(b),
                "flows": [
                    {"on": j(f.on), "amount": j(f.amount), "kind": f.kind.value, "quality": f.event.quality.value}
                    for f in performance.external_flows(ledger, position_id, a, b)
                ],
                "period_result": _result(performance.period_result(ledger, position_id, a, b)),
                "simple_return": _result(performance.simple_return(ledger, position_id, a, b)),
                "simple_return_no_dist": _result(
                    performance.simple_return(ledger, position_id, a, b, include_distributions=False)
                ),
                "all_methods": [_result(r) for r in returns.all_methods(ledger, position_id, a, b)],
            }
        )
    out["windows"] = windows
    sims = []
    for p in [*probes[-1:], *after]:
        for gross in ("2500.50", "999999.99"):
            out_p = outcome(service.proportional_cost, ledger, position_id, Decimal(gross), p)
            sims.append({"on": j(p), "gross": gross, "proportional_cost": out_p})
            for rule in RULES:
                sims.append(
                    {
                        "on": j(p),
                        "gross": gross,
                        "rule": str(rule.id),
                        "plain": _sim(ledger, position_id, p, gross, rule, {}),
                        "informed": _sim(
                            ledger,
                            position_id,
                            p,
                            gross,
                            rule,
                            {"fees": "12.34", "cost_attributed": "800.00", "current_value": "3000"},
                        ),
                        "base": _sim(ledger, position_id, p, gross, rule, {"informed_base": "400.10"}),
                    }
                )
    out["simulations"] = sims
    return out


def _sim(ledger: Ledger, position_id: UUID, on: date, gross: str, rule: TaxRule, options: dict[str, Any]) -> Any:
    try:
        return {"ok": j(simulation.simulate(ledger, position_id, on, gross, rule, **options))}
    except DomainError as exc:
        return {"error": str(exc)}


def snapshot(ledger: Ledger, known: set[str]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "accounts": [[a.name, j(queries.balance(ledger, a.id))] for a in ledger.accounts.values()],
        "operations": [
            {k: v for k, v in norm(dump(op), known).items() if k != "id"} for op in ledger.operations.values()
        ],
        "row_counts": ledger.row_counts(),
        "positions": [position_snapshot(ledger, pid, known) for pid in service.positions(ledger)],
    }
    days = sorted({p for pid in service.positions(ledger) for p in _probes(ledger, pid)})
    out["composition"] = [
        {
            "at": j(c.at),
            "lines": norm(j(c.lines), known),
            "total": j(c.total),
            "partial": c.partial,
        }
        for day in days[:: max(1, len(days) // 6)]
        for c in [performance.composition(ledger, day)]
    ]
    return out


# ── base ledger and scenarios ──────────


def base() -> tuple[Ledger, dict[str, str]]:
    ledger = Ledger.new("Projeto Golden")
    ana = ledger.add_member("Ana").id
    bruno = ledger.add_member("Bruno").id

    def account(name: str, subtype: AccountSubtype, holders: tuple[UUID, ...] = ()) -> UUID:
        return ledger.add_account(LedgerAccount(name=name, type=AccountType.ASSET, subtype=subtype, holders=holders)).id

    names = {
        "ana": ana,
        "bruno": bruno,
        "bank": account("Banco A", AccountSubtype.CHECKING, (ana,)),
        "savings": account("Poupança", AccountSubtype.SAVINGS, (ana,)),
        "broker": account("Corretora", AccountSubtype.BROKERAGE_CASH, (bruno,)),
        "joint": account("Conjunta", AccountSubtype.CHECKING, (ana, bruno)),
    }
    names["loan"] = ledger.add_account(
        LedgerAccount(name="Empréstimo", type=AccountType.LIABILITY, subtype=AccountSubtype.LOAN)
    ).id
    ledger.record_opening_balance(names["bank"], "250000.00", date(2025, 12, 31))
    ledger.record_opening_balance(names["broker"], "80000.00", date(2025, 12, 31))
    return Ledger.from_records(ledger.to_records()), {k: str(v) for k, v in names.items()}


def _examples() -> dict[str, list[dict[str, Any]]]:
    """docs/06 §8 A-F, as tests/test_investments.py builds them."""
    cdb = {
        "cmd": "create_position",
        "args": ["CDB Banco X", "fixed_income", "2026-01-01"],
        "opts": {"initial_cost": "10000.00", "from_account": "@bank"},
    }

    def val(on: str, value: str, nature: str = "gross", **o: Any) -> dict[str, Any]:
        return {"cmd": "add_valuation", "args": ["$0", on, value, nature], "opts": o}

    def val0(on: str, value: str) -> dict[str, Any]:
        return {"cmd": "add_valuation", "args": ["$0", on, value, "gross"], "opts": {}}

    return {
        "A": [cdb, val("2026-01-31", "10100"), val("2026-02-28", "10250"), val("2026-03-31", "10400")],
        "B": [
            cdb,
            {"cmd": "contribute", "args": ["$0", "5000.00", "2026-02-10", "@bank"]},
            val("2026-03-31", "15300"),
        ],
        "C": [
            cdb,
            val("2026-06-30", "12000"),
            {"cmd": "simulate", "args": ["$0", "2026-06-30", "12000", 0], "opts": {"fees": "20"}},
            {
                "cmd": "redeem",
                "args": ["$0", "2026-06-30", "12000", "@bank"],
                "opts": {"tax_withheld": "300", "fees": "20", "final": True},
            },
        ],
        "D": [
            cdb,
            val("2026-06-30", "12000"),
            {
                "cmd": "simulate",
                "args": ["$0", "2026-06-30", "3000", 0],
                "opts": {"fees": "10", "current_value": "12000"},
            },
            {"cmd": "simulate", "args": ["$0", "2027-06-30", "3000", 3]},
            {
                "cmd": "redeem",
                "args": ["$0", "2026-06-30", "3000", "@bank"],
                "opts": {"tax_withheld": "75", "fees": "10"},
            },
        ],
        "E": [
            cdb,
            {"cmd": "distribute", "args": ["$0", "200.00", "2026-02-15", "@bank"]},
            val("2026-03-31", "10100"),
        ],
        "F": [
            {
                "cmd": "create_position",
                "args": ["Fundo antigo", "fund", "2026-06-01"],
                "opts": {"reference_value": "50000.00"},
            },
            val("2026-07-01", "50500"),
            {"cmd": "simulate", "args": ["$0", "2026-07-01", "1000", 0]},
        ],
        "TA-26": [
            cdb,
            val("2026-01-31", "10100", source="extrato banco"),
            val("2026-01-31", "10120", source="app"),
            {"cmd": "select_valuation", "args": ["$2"]},
            val("2026-01-31", "1", source="app"),
        ],
        "TA-28": [
            cdb,
            val("2026-06-30", "12000"),
            {
                "cmd": "redeem",
                "args": ["$0", "2026-06-30", "12000", "@bank"],
                "opts": {"tax_due_later": "300", "final": True},
            },
            {"cmd": "pay_tax", "args": ["300", "2026-07-31", "@bank"]},
        ],
        "net_only": [
            cdb,
            val("2026-06-30", "12000"),
            {"cmd": "redeem_net_only", "args": ["$0", "2026-06-30", "2915.00", "@bank"]},
            {"cmd": "complete_redemption", "args": ["$2", "3000"], "opts": {"tax_withheld": "80", "fees": "10"}},
            {"cmd": "complete_redemption", "args": ["$2", "3000"], "opts": {"tax_withheld": "75", "fees": "10"}},
        ],
        "TWR": [
            {
                "cmd": "create_position",
                "args": ["Fundo", "fund", "2026-01-01"],
                "opts": {"initial_cost": "1000", "from_account": "@bank"},
            },
            val("2026-02-01", "2100"),
            {"cmd": "contribute", "args": ["$0", "1000", "2026-02-01", "@bank"]},
            val("2026-03-01", "1995"),
            {"cmd": "contribute", "args": ["$0", "500", "2026-03-11", "@bank"]},
            val("2026-03-31", "2560"),
            val("2027-01-01", "2800"),
        ],
        "trades": [
            {
                "cmd": "create_position",
                "args": ["PETR4", "stock", "2026-01-02"],
                "opts": {"mode": "quantity", "ticker": "PETR4"},
            },
            {"cmd": "buy", "args": ["$0", "2026-01-02", "100", "10.00", "@bank"], "opts": {"fees": "1.00"}},
            {"cmd": "buy", "args": ["$0", "2026-02-02", "100", "20.00", "@bank"], "opts": {"fees": "1.00"}},
            {"cmd": "sell", "args": ["$0", "2026-03-02", "50", "25.00", "@bank"], "opts": {"fees": "0.50"}},
            {"cmd": "split", "args": ["$0", "2026-04-01", "2"]},
            {"cmd": "bonus", "args": ["$0", "2026-05-01", "20", "0"]},
            {"cmd": "bonus", "args": ["$0", "2026-05-02", "3", "45.30"]},
            {"cmd": "sell", "args": ["$0", "2026-06-01", "1000", "9.00", "@bank"]},
            {"cmd": "sell", "args": ["$0", "2026-06-01", "323", "9.00", "@bank"], "opts": {"tax_withheld": "0.15"}},
            {
                "cmd": "create_position",
                "args": ["Tesouro", "treasury", "2026-01-02"],
                "opts": {"mode": "quantity"},
            },
            {"cmd": "buy", "args": ["$9", "2026-01-02", "1", "1000.00", "@bank"]},
            {"cmd": "buy", "args": ["$9", "2026-02-02", "1.5", "1100.00", "@bank"]},
            {"cmd": "sell", "args": ["$9", "2026-03-02", "1.25", "1200.00", "@bank"]},
            {"cmd": "sell", "args": ["$9", "2026-03-03", "1", "1210.00", "@bank"], "opts": {"method": "average"}},
            {"cmd": "opening_lot", "args": ["$9", "2026-01-01", "3", "2900.00"]},
            {"cmd": "buy", "args": ["$1", "2026-01-03", "1", "1", "@bank"]},
            val0("2026-01-02", "1000.00"),
            val0("2026-03-02", "3100.00"),
            val0("2026-06-01", "400.00"),
        ],
    }


def _money(rng: random.Random, low: int, high: int) -> str:
    return str(Decimal(rng.randint(low, high)) / 100)


def _random_commands(seed: int) -> list[dict[str, Any]]:
    """A seeded mix of every command, valid and invalid, over value and quantity positions."""
    rng = random.Random(seed)
    commands: list[dict[str, Any]] = []
    value_pos: list[str] = []
    qty_pos: list[str] = []
    events: list[str] = []
    valuations: list[str] = []
    cash = ["@bank", "@savings", "@broker", "@joint"]
    classes = ["fixed_income", "treasury", "stock", "reit", "fund", "etf", "pension", "crypto", "other"]
    day = START

    def add(cmd: str, *args: Any, **opts: Any) -> str:
        commands.append({"cmd": cmd, "args": list(args), "opts": opts})
        return f"${len(commands) - 1}"

    for i in range(6):
        cls = rng.choice(classes)
        on = (START + timedelta(days=rng.randint(0, 40))).isoformat()
        if i % 2 == 0:
            options: dict[str, Any] = {}
            roll = rng.random()
            if roll < 0.5:
                options = {"initial_cost": _money(rng, 100_000, 2_000_000), "from_account": rng.choice(cash)}
            elif roll < 0.75:
                options = {"initial_cost": _money(rng, 100_000, 2_000_000)}
            else:
                options = {"reference_value": _money(rng, 100_000, 2_000_000)}
            if rng.random() < 0.5:
                options["holder_id"] = rng.choice(["@ana", "@bruno"])
            value_pos.append(add("create_position", f"Posição {seed}.{i}", cls, on, **options))
        else:
            ref = add("create_position", f"Ativo {seed}.{i}", cls, on, mode="quantity", ticker=f"AT{i}")
            qty_pos.append(ref)
            add("opening_lot", ref, on, str(rng.randint(1, 50)), _money(rng, 0, 500_000))
    for _ in range(70):
        day += timedelta(days=rng.randint(0, 9))
        on = day.isoformat()
        roll = rng.random()
        if roll < 0.45 and value_pos:
            pos = rng.choice(value_pos)
            kind = rng.random()
            if kind < 0.35:
                nature = rng.choice(["gross"] * 6 + ["net_informed", "unspecified"])
                valuations.append(
                    add(
                        "add_valuation",
                        pos,
                        on,
                        _money(rng, 50_000, 3_000_000),
                        nature,
                        source=rng.choice(["manual", "manual", "extrato", "app"]),
                    )
                )
            elif kind < 0.5:
                add("contribute", pos, _money(rng, 1_000, 500_000), on, rng.choice(cash))
                if rng.random() < 0.6:
                    valuations.append(add("add_valuation", pos, on, _money(rng, 50_000, 3_000_000), "gross"))
            elif kind < 0.6:
                add("distribute", pos, _money(rng, 100, 50_000), on, rng.choice(cash), _money(rng, 0, 2_000))
            elif kind < 0.75:
                options = {}
                if rng.random() < 0.3:
                    options["cost_attributed"] = _money(rng, 0, 500_000)
                if rng.random() < 0.5:
                    options["tax_withheld"] = _money(rng, 0, 20_000)
                if rng.random() < 0.3:
                    options["tax_due_later"] = _money(rng, 0, 20_000)
                if rng.random() < 0.4:
                    options["fees"] = _money(rng, 0, 1_000)
                if rng.random() < 0.15:
                    options["final"] = True
                events.append(add("redeem", pos, on, _money(rng, 1_000, 800_000), rng.choice(cash), **options))
                if rng.random() < 0.5:
                    valuations.append(add("add_valuation", pos, on, _money(rng, 0, 3_000_000), "gross"))
            elif kind < 0.82:
                events.append(add("redeem_net_only", pos, on, _money(rng, 1_000, 300_000), rng.choice(cash)))
            elif kind < 0.9 and events:
                add(
                    "complete_redemption",
                    rng.choice(events),
                    _money(rng, 1_000, 300_000),
                    tax_withheld=_money(rng, 0, 5_000),
                )
            elif valuations:
                if rng.random() < 0.5:
                    add("select_valuation", rng.choice(valuations))
                else:
                    add("correct_valuation", rng.choice(valuations), _money(rng, 0, 3_000_000), "conferido")
        elif roll < 0.85 and qty_pos:
            pos = rng.choice(qty_pos)
            kind = rng.random()
            qty = rng.choice([str(rng.randint(1, 40)), f"{rng.randint(1, 9)}.5", "0.125"])
            price = _money(rng, 100, 30_000)
            if kind < 0.45:
                options = {"fees": _money(rng, 0, 900)} if rng.random() < 0.5 else {}
                add("buy", pos, on, qty, price, rng.choice(cash), **options)
            elif kind < 0.85:
                options = {}
                if rng.random() < 0.4:
                    options["fees"] = _money(rng, 0, 900)
                if rng.random() < 0.3:
                    options["tax_withheld"] = _money(rng, 0, 300)
                if rng.random() < 0.25:
                    options["method"] = rng.choice(["average", "fifo"])
                add("sell", pos, on, qty, price, rng.choice(cash), **options)
            elif kind < 0.92:
                add("split", pos, on, rng.choice(["2", "0.5", "3", "0.1", "0"]))
            else:
                add("bonus", pos, on, str(rng.randint(1, 10)), rng.choice(["0", _money(rng, 0, 5000)]))
            if rng.random() < 0.3:
                valuations.append(add("add_valuation", pos, on, _money(rng, 1_000, 900_000), "gross"))
        else:
            add("pay_tax", _money(rng, 100, 30_000), on, rng.choice([*cash, "@loan"]))
    return commands


def _xirr_cases() -> list[dict[str, Any]]:
    rng = random.Random(606)
    cases: list[list[tuple[date, Decimal]]] = [
        [(date(2025, 1, 1), Decimal("-1000")), (date(2026, 1, 1), Decimal("1100"))],
        [(date(2025, 1, 1), Decimal("100")), (date(2026, 1, 1), Decimal("100"))],
        [(date(2024, 1, 1), Decimal("-100")), (date(2025, 1, 1), Decimal("230")), (date(2026, 1, 1), Decimal("-132"))],
        [(date(2026, 1, 1), Decimal("-1000")), (date(2026, 1, 1), Decimal("1000"))],
        [(date(2026, 1, 1), Decimal("-1000")), (date(2026, 1, 31), Decimal("1010.50"))],
        [(date(2026, 1, 1), Decimal("-1000")), (date(2027, 1, 1), Decimal("0.01"))],
    ]
    for _ in range(14):
        start = date(2024, 1, 1) + timedelta(days=rng.randint(0, 400))
        flows = [(start, -Decimal(rng.randint(10_000, 1_000_000)) / 100)]
        for _ in range(rng.randint(0, 4)):
            sign = -1 if rng.random() < 0.6 else 1
            flows.append(
                (start + timedelta(days=rng.randint(1, 700)), sign * Decimal(rng.randint(1_000, 200_000)) / 100)
            )
        flows.append((start + timedelta(days=rng.randint(30, 900)), Decimal(rng.randint(10_000, 2_000_000)) / 100))
        cases.append(flows)
    out = []
    for flows in cases:
        rate, reason = returns.xirr_from_flows(flows)
        out.append({"flows": [[j(d), j(a)] for d, a in flows], "rate": j(rate), "reason": reason})
    return out


def scenario(name: str, commands: list[dict[str, Any]]) -> dict[str, Any]:
    ledger, names = base()
    known = known_ids(ledger)
    records = records_of(ledger)
    results = run_commands(ledger, commands, names, INVESTMENT_COMMANDS, known)
    return {
        "name": name,
        "records": records,
        "names": names,
        "commands": commands,
        "results": results,
        "snapshot": snapshot(ledger, known),
    }


def generate() -> dict[str, Any]:
    scenarios = [scenario(f"example {name}", commands) for name, commands in _examples().items()]
    scenarios += [scenario(f"seed {seed}", _random_commands(seed)) for seed in (11, 12, 13)]
    return {
        "rules": [r.model_dump(mode="json") for r in RULES],
        "brackets": [j(b) for b in returns.XIRR_BRACKETS],
        "xirr": _xirr_cases(),
        "scenarios": scenarios,
    }
