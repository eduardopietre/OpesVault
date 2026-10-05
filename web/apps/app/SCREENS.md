# Porting the desktop screens to the web app

Rules for W8–W11 (docs/18 §5–§7). Each desktop screen becomes a web page that does **everything the
Qt page does, the same way**, responsive in four bands, with motion, accessible. Read docs/07, docs/16
(including §8, the web design system) and the CLAUDE.md interface rules before porting a page.

## Where things go

| Desktop                                                                             | Web                                                                                                                         |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/opesvault/ui/pages/<x>_page.py` or `ui/pages/<x>/`                             | `apps/app/src/pages/<page id>/index.tsx` exporting `Page` (ids in `src/pages.tsx`)                                          |
| page tabs, inspector, row commands, models                                          | other files in the same folder (`ledger_table.tsx`, `inspector.tsx`, `rows.ts`…)                                            |
| dialogs (`ui/dialogs.py`, `ui/*_dialogs.py`, `ui/tax_dialogs/`, page-local dialogs) | `apps/app/src/dialogs/<name>.tsx`, shared by every page that opens them                                                     |
| `tests/test_<x>_ui.py`, `test_every_screen.py` cases                                | `apps/app/test/pages/<page id>.test.tsx` (Vitest + Testing Library) and `apps/app/e2e/pages/<page id>.spec.ts` (Playwright) |

The router finds `pages/<id>/index.tsx` by itself (`import.meta.glob`); until a folder exists the
destination shows its placeholder. Pure row/label builders that do not need React go in a `rows.ts`
and get plain unit tests (the desktop's `pages/tax/rows.py` pattern).

## Reading and changing the project

- `useLedger((ledger) => …, key)` reads from the domain and recomputes after every change; `key` names
  everything else the selector reads (a month as `ymStr(month)`, an id, filters joined in a string).
- **Every change is one call to `useAct()`**: `act((ledger) => dom.budget.setBudget(ledger, …), "Orçamento salvo.")`.
  One user action = one `act` = one undo step = one sync. Never mutate an entity object; never call
  domain mutators outside `act`. A `DomainError` is shown to the user by `act` itself.
- `useWorkspace().today()` is the family's calendar date; pass it to domain functions that take `today`.
- `useWorkspace().readOnly`: disable every editing control (with a tooltip saying another tab or device
  is editing). The undo/redo shortcuts already follow it.
- Domain API: `import { dom, importing, investments, tax, catalogs, charts, ai, assistant, queries, search, … } from "@opesvault/domain"`.
  Money is `Dec` (exact). Inputs come as text: `MoneyField` gives the raw Brazilian string; convert with
  `parseBrl`. Display with `formatBrl`/`formatDecimalBr`. Never `Number()` a money value; charts use
  `Dec.toNumberForDisplay()` only to draw.
- Unknown is not zero: a `null` from the domain is shown as "—" or "sem informação" with its reason.

## Interface rules (docs/16, adapted to the web)

- Components from `@opesvault/ui` only: `PageHeader` (title, one context line, at most one primary
  action), `Section`, `Collapsible`, `EmptyState`, `Adaptive` (side by side when there is room),
  `DataTable` (virtualized, selection by id, column priorities for narrow widths, cards on phones),
  `ChartPanel` (chart + the same values in a table, never tabs for the same data), `Dialog` (sheet on
  phones), `decide`/`confirm`, `notify` (short guidance, never a dialog), `Menu`, `Tabs` (only for
  different objects), `Select`/`Combobox` (by id), `MonthPicker`, `NumberTicker`, `Badge`, `Skeleton`,
  `Inspector`, `ElidedText` (any one-line text with a user's name). No hard-coded colors or font sizes:
  tokens and the Tailwind classes mapped to them.
- The shared month: `useSharedMonth()` (`src/data/month.ts`) in Visão geral, Orçamento, Calendário, Livro
  and Relatórios.
- Going to an object: `useGoTo()("contas", { ref: cardId, act: "pagar" })`; the target page handles
  it with `useReveal((ref, act) => …)` (`src/data/navigation.ts`), selecting/scrolling to the object and
  starting the action. Every notice and calendar entry leads to where it is resolved.
- Empty project: every table and chart has an empty state; nothing crashes without data (TA-31).
- Four bands (docs/18 §5.1): ≥1440 wide with inspector; 1024–1439; 640–1023 (drawer); <640 phone
  (cards, sheets, bottom bar). No horizontal overflow at 1920×1080, 1280×800, 900×640, 768×1024, 390×844.
- Motion: page entry is already animated by the shell; animate list insertions/removals, panels and
  dialogs with the motion tokens (`@opesvault/ui` motion helpers). Never animate typing or scrolling;
  `prefers-reduced-motion` keeps only short fades (the provider does it).
- Accessibility: every control has an accessible name; keyboard reaches everything; state never by
  color alone; focus returns where it was after a dialog. Text in Portuguese; the project is "Projeto".

## Tests for each page

1. Component tests (`apps/app/test/pages/<id>.test.tsx`): render the page with the fake services and the
   demo project (see `test/screens.test.tsx` for the setup), exercise every action of the desktop page
   and check the ledger changed as the domain says (and one undo reverts it).
2. e2e (`apps/app/e2e/pages/<id>.spec.ts`): open with `?demo`, click every button and menu item of the
   page, fill and submit every dialog, check no console errors, no horizontal overflow at the five sizes,
   axe without violations, light and dark.
3. Screenshots: add the page to the `screens` project and look at them (Read the PNGs) in light/dark at
   1920, 1280, 900 and 390 wide; fix what looks wrong.

`pnpm check` and `pnpm --filter @opesvault/app e2e` must pass before every commit.
