"""Python decimal semantics the TypeScript Dec must match digit for digit."""

import random
from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_EVEN, ROUND_HALF_UP, Decimal, localcontext
from typing import Any

ROUNDINGS = [ROUND_HALF_UP, ROUND_HALF_EVEN, ROUND_FLOOR, ROUND_CEILING]


def _rand_dec(rng: random.Random) -> str:
    kind = rng.random()
    if kind < 0.1:
        return rng.choice(["0", "-0", "0.00", "1", "-1", "0.01", "100", "1E+2", "1.50", "-0.005", "0.5", "2.5"])
    digits = rng.randint(1, 30 if kind > 0.9 else 12)
    coef = "".join(rng.choice("0123456789") for _ in range(digits)).lstrip("0") or "0"
    exp = rng.randint(-12, 3)
    sign = "-" if rng.random() < 0.4 else ""
    return f"{sign}{coef}E{exp}"


def _s(d: Decimal) -> list[str]:
    return [str(d), format(d, "f")]


def _try(fn: Any) -> Any:
    try:
        return _s(fn())
    except ArithmeticError as exc:
        return {"error": type(exc).__name__}


def generate() -> dict[str, Any]:
    rng = random.Random(20261005)
    cases: list[dict[str, Any]] = []
    for prec in (28, 40, 6):
        with localcontext() as ctx:
            ctx.prec = prec
            for _ in range(400):
                a, b = Decimal(_rand_dec(rng)), Decimal(_rand_dec(rng))
                rounding = rng.choice(ROUNDINGS)
                q = rng.choice(["0.01", "1", "0.000001", "1E+1", "0.1"])
                cases.append(
                    {
                        "prec": prec,
                        "a": str(a),
                        "b": str(b),
                        "parse": _s(a),
                        "add": _try(lambda a=a, b=b: a + b),
                        "sub": _try(lambda a=a, b=b: a - b),
                        "mul": _try(lambda a=a, b=b: a * b),
                        "div": _try(lambda a=a, b=b: a / b),
                        "divint": _try(lambda a=a, b=b: a // b),
                        "mod": _try(lambda a=a, b=b: a % b),
                        "neg": _try(lambda a=a: -a),
                        "abs": _try(lambda a=a: abs(a)),
                        "cmp": (a > b) - (a < b),
                        "rounding": rounding,
                        "q": q,
                        "quantize": _try(lambda a=a, q=q, r=rounding: a.quantize(Decimal(q), rounding=r)),
                        "floor": _try(lambda a=a: a.to_integral_value(rounding=ROUND_FLOOR)),
                        "normalize": _try(lambda a=a: a.normalize()),
                    }
                )
    transcendental: list[dict[str, Any]] = []
    for prec in (28, 40):
        with localcontext() as ctx:
            ctx.prec = prec
            for _ in range(150):
                x = Decimal(rng.randint(1, 10**9)) / Decimal(10 ** rng.randint(0, 9))
                y = Decimal(rng.randint(-2000, 2000)) / Decimal(rng.choice([1, 12, 365, 1000]))
                n = rng.randint(-5, 400)
                transcendental.append(
                    {
                        "prec": prec,
                        "x": str(x),
                        "y": str(y),
                        "n": n,
                        "ln": _try(lambda x=x: x.ln()),
                        "exp": _try(lambda y=y: y.exp()),
                        "pow_frac": _try(lambda x=x: (1 + x / 1000) ** (Decimal(1) / Decimal(12))),
                        "pow_int": _try(lambda x=x, n=n: (1 + x / 10**6) ** n),
                    }
                )
    return {"arith": cases, "transcendental": transcendental}
