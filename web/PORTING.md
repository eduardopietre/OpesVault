# Porting the desktop domain to TypeScript

Rules for moving `src/opesvault/**` (Python) into `web/packages/domain/src/**` (TypeScript) with
proven parity (docs/18 §4). Read this before porting a module. The CLAUDE.md pitfalls still apply.

## Where things go

| Python                                                                                     | TypeScript                                                                   |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `src/opesvault/domain/x.py`                                                                | `packages/domain/src/domain/x.ts`                                            |
| `src/opesvault/importing/x.py`, `importing/parsers/x.py`                                   | `packages/domain/src/importing/x.ts`, `importing/parsers/x.ts`               |
| `src/opesvault/investments/x.py`, `tax/`, `ai/`, `assistant/`, `charts/data/`, `catalogs/` | same folder name under `packages/domain/src/`                                |
| `src/opesvault/undo.py`, `exports.py`, `registry.py`, `diagnostics.py`                     | `packages/domain/src/undo.ts`, …                                             |
| `tests/test_x.py`                                                                          | `packages/domain/test/x.test.ts` (same cases, same names where possible)     |
| golden generator                                                                           | `scripts/golden/cases_<name>.py`, registered in `scripts/golden/generate.py` |

File names keep the Python module names (snake_case) so each file maps to its origin.
Each ported file starts with a doc comment that says what it is and "Port of `<python path>`".

## Names and shapes

- Functions and methods: camelCase (`record_expense` → `recordExpense`). Constants: UPPER_SNAKE.
- **Persisted fields keep their snake_case names** (`occurred_on`, `liability_account_id`): the
  entity objects are exactly the persisted JSON shape, with no mapping layer.
- No TypeScript `enum` (the build is erasable-only). A Python `StrEnum` becomes:

  ```ts
  export const OperationKind = { INCOME: "income", EXPENSE: "expense" } as const;
  export type OperationKind = (typeof OperationKind)[keyof typeof OperationKind];
  ```

  and its schema `z.enum([...Object.values(OperationKind)] as [OperationKind, ...OperationKind[]])`
  (or list the values literally).

- Entities are zod `z.strictObject` schemas (Pydantic's `extra="forbid"`); the type is
  `z.output<typeof Schema>`. Every optional field is present with `null` (Python `None`), via
  `.nullable().default(null)`. Defaults in the schema match Pydantic defaults.
- Entities are immutable (`Readonly`). `model_copy(update={...})` is `{ ...entity, ...changes }`.
  `model_copy` does not revalidate in Python either; validate with `Schema.parse` where Python
  constructs a new model (`Model(...)`), because construction validates.
- `tuple[...]` fields are `readonly T[]` arrays.
- Parsing stored JSON: `Schema.parse(json)` turns decimal strings into `Dec`. Serializing:
  `JSON.parse(JSON.stringify(entity))` — `Dec.toJSON()` gives the persisted fixed form.

## Values

- **Money and quantities:** `Dec` (`lib/dec.ts`) has Python's `decimal` semantics: same scale,
  same 28-digit context, same rounding. `a + b` → `a.add(b)`, `a * b` → `a.mul(b)`, `a / b` →
  `a.div(b)`, `-a` → `a.negate()`, comparisons with `.lt/.lte/.gt/.gte/.eq/.cmp`, `sum(xs, ZERO)`
  → `Dec.sum(xs)`, `x.quantize(CENT, rounding=ROUND_HALF_UP)` → `x.quantize(CENT, "ROUND_HALF_UP")`,
  `localcontext()` + `ctx.prec = 40` → `withContext({ prec: 40 }, () => ...)`.
  Python `1 + x` with an int is `Dec.from(1).add(x)`. Never `number` for money; `number` is for
  counts, indexes, days and months.
- `x == 0` on Decimal → `x.isZero()`; `x < 0` → `x.isNegative()`; truthiness of a Decimal is
  `!x.isZero()`.
- **Dates:** `IsoDate` strings (`lib/dates.ts`). Compare with `<`/`>` directly. `d + timedelta(days=n)`
  → `addDays(d, n)`, `(a - b).days` → `daysBetween(a, b)`, `d.weekday()` → `weekday(d)`,
  `date.today()` must not be called in the domain: take `today` as a parameter (Python modules that
  call `date.today()` get an explicit parameter with the same default behaviour at the call site).
- **YearMonth:** plain `{year, month}` with `ym*` helpers (`ymAdd`, `ymStr`, `ymLt`, `ymEq`…).
  Never compare two months with `===`; use `ymEq`.
- **Instants (datetime):** `Instant` ISO strings in UTC.
- **Ids:** lowercase UUID strings (`Id`). `uuid4()` → `newId()`, `uuid5()` → `uuid5()`.
- **Dicts keyed by ids or other non-string-literal keys:** use `Map` (keeps insertion order like
  Python dicts). Do not use plain objects for data keyed by user input (prototype keys, numeric
  key reordering).
- **Other Python semantics** live in `lib/py.ts`: `pyEquals` (model `==`), `head` (`text[:n]`), `strip`/`stripChars`,
  `collapseSpaces` (`" ".join(text.split())`), `formatFixed` (`format(Decimal, ".2f")`, half to even), `orDec`
  (`x or ZERO`), `KeyError` and `getOrKeyError` (`mapping[key]`). Reuse them; do not copy them into a module.
- **Sorting:** JavaScript's sort is stable, like Python's. Python orders strings by code point;
  use `cmpStr`/`sortedBy` (`lib/text.ts`) where the order of names is visible or tested, and
  `cmpKeys` for tuple keys. `str.casefold()` → `casefold()`.
- `None` → `null`. "Unknown is not zero": keep `null` with a reason, exactly as Python does.

## Errors

- `DomainError` (user-facing Portuguese message, may cite data) stays a class with the same name
  and messages. Python `ValueError`/`KeyError` raised on purpose map to a named Error subclass.
- Never log `String(error)`; diagnostics record only a code, type and place.

## Proving parity

1. Write `scripts/golden/cases_<name>.py` with `generate()` returning JSON built with
   `scripts/golden/common.py` (`j()` for values, `outcome()` for "result or error type").
   Use fixed seeds and build ledgers through the public Python API (or `tests/demo_vault.py`).
2. Register it in `GENERATORS` and run `uv run python -m scripts.golden.generate <name>`.
3. In `packages/domain/test/<name>.test.ts`, rebuild the same inputs in TS (or load the dumped
   ledger records with `Ledger.fromRecords`) and compare with `j()`/`outcome()` from
   `test/golden.ts`. Decimals compare as text with no tolerance.
4. Port the module's pytest cases too. Golden files are never edited by hand.

## Checks

`pnpm check` (format, lint, typecheck, tests) must pass before every commit. The Python suite
keeps passing until W13 removes it.
