/**
 * Bank statements exported as CSV by any bank (docs/05 §3, exportações estruturadas), when no layout of its
 * own (such as Nubank's) recognizes the file.
 *
 * The columns are found by their names in a header row, which may come after a few lines about the account
 * ("Conta: 12345-6", "Período: 01/02/2026 a 28/02/2026"). A statement needs a date, a description and either
 * one signed amount (optionally with a D/C column) or separate debit and credit columns; a balance and a
 * document number are used when present. Amounts may be Brazilian ("R$ 1.234,56", "1.234,56 D", "(12,00)") or
 * dotted ("-1234.56"); the convention is decided once for the whole file. Balance and total lines are not
 * operations: an opening balance ("Saldo anterior") is kept for the reconciliation, the rest goes to the
 * unmapped lines. Dates without a year take it from the document's own dates, never from the clock (docs/05
 * §4); a value or date that cannot be read is a warning, never zero.
 */
import { compareDates, type IsoDate } from "../../lib/dates.ts";
import { Dec } from "../../lib/dec.ts";
import { DocFormat, DocType, ItemKind, StatementHeaderSchema } from "../model.ts";
import { line, type Line, type Source } from "../source.ts";
import { type Parser, type ParseResult, parsedItem, pyStrip, resolveYear, safeDate } from "./base.ts";

/** How far down the file the header row may be. */
const HEADER_SEARCH = 30;

type Role = "date" | "description" | "amount" | "debit" | "credit" | "balance" | "document" | "direction";

/** Header names (without accents, lower case, punctuation as spaces) and the role of their column. */
const NAMES: Readonly<Record<Role, readonly string[]>> = {
  date: ["data", "data lancamento", "data do lancamento", "data movimento", "data da movimentacao", "dt", "date"],
  description: [
    "descricao",
    "historico",
    "lancamento",
    "lancamentos",
    "descricao do lancamento",
    "historico do lancamento",
    "detalhes",
    "memo",
    "description",
  ],
  amount: ["valor", "valor r", "valor rs", "valor em r", "montante", "amount"],
  debit: ["debito", "debitos", "saida", "saidas", "valor debito", "debito r"],
  credit: ["credito", "creditos", "entrada", "entradas", "valor credito", "credito r"],
  balance: ["saldo", "saldo r", "saldos", "saldos r", "saldo do dia", "saldo apos lancamento", "balance"],
  document: ["documento", "doc", "docto", "n documento", "no documento", "numero do documento", "identificador", "id"],
  direction: ["d c", "c d", "tipo", "natureza", "debito credito", "credito debito"],
};

/** "Saldo anterior", "SALDO DO DIA", "Total": lines about the account, not operations. */
const BALANCE_LINE = /^(saldo|s a l d o|total)\b/;
const OPENING_LINE = /^saldo (anterior|inicial)\b/;

/** Lower case, no accents, punctuation as single spaces: "Valor (R$)" → "valor r". */
export function headerKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type Columns = Partial<Record<Role, number>>;

function columnsOf(cells: readonly string[]): Columns {
  const found: Columns = {};
  cells.forEach((cell, index) => {
    const key = headerKey(cell);
    for (const role of Object.keys(NAMES) as Role[]) {
      if (found[role] === undefined && NAMES[role].includes(key)) {
        found[role] = index;
        return;
      }
    }
  });
  return found;
}

function usable(columns: Columns): boolean {
  const money = columns.amount !== undefined || (columns.debit !== undefined && columns.credit !== undefined);
  return columns.date !== undefined && columns.description !== undefined && money;
}

/** The header row and its columns, among the first rows of the file; null when there is none. */
function findHeader(source: Source): { at: number; columns: Columns } | null {
  for (const [at, [, cells]] of source.rows.slice(0, HEADER_SEARCH).entries()) {
    const columns = columnsOf(cells);
    if (usable(columns)) return { at, columns };
  }
  return null;
}

// ── amounts ─────────────────────────────────────────

type Convention = "comma" | "dot";

/** A cell without currency, spaces, sign and D/C marks: what is left must be digits and separators. */
function bare(text: string): string {
  return text
    .replace(/R\$/gi, "")
    .replace(/[\s\u00a0]/g, "")
    .replace(/[−-]/g, "")
    .replace(/[()+]/g, "")
    .replace(/[DC]$/i, "");
}

/** Comma decimals when any amount ends in ",dd" (or ",d"); dotted when one ends in ".dd" and none uses a comma. */
function conventionOf(cells: readonly string[]): Convention {
  let dot = false;
  for (const cell of cells) {
    const text = bare(cell);
    if (/,\d{1,2}$/.test(text)) return "comma";
    if (/\.\d{1,2}$/.test(text) && !text.includes(",")) dot = true;
  }
  return dot ? "dot" : "comma";
}

/** A signed amount, or null when the cell is not one. A "D" or a minus or parentheses make it negative. */
export function readAmount(cell: string, convention: Convention): Dec | null {
  const text = cell.replace(/\u00a0/g, " ").trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || /^[−-]|[−-]$|R\$\s*[−-]/.test(text) || /\s*D$/i.test(text);
  const digits = bare(text);
  let plain: string;
  if (convention === "comma") {
    if (!/^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+(,\d+)?$/.test(digits)) return null;
    plain = digits.replaceAll(".", "").replace(",", ".");
  } else {
    if (!/^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(digits)) return null;
    plain = digits.replaceAll(",", "");
  }
  const value = Dec.parse(plain);
  return negative ? value.negate() : value;
}

// ── dates ───────────────────────────────────────────

/** "31/01/2026", "31/01/26", "31-01-2026", "31.01.2026" or "2026-01-31"; null when impossible or not a date. */
export function readDate(cell: string): IsoDate | null {
  const text = cell.trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(text);
  if (m) {
    const year = Number(m[3]) < 100 ? Number(m[3]) + 2000 : Number(m[3]);
    return safeDate(year, Number(m[2]), Number(m[1]));
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(text);
  return m ? safeDate(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

/** "31/01": a date printed without its year. */
function dayMonth(cell: string): [number, number] | null {
  const m = /^(\d{1,2})[/.-](\d{1,2})$/.exec(cell.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Account and period written above the header ("Conta: 12345-6", "Período: 01/02/2026 a 28/02/2026"). */
function preamble(rows: readonly (readonly string[])[]): { account: string | null; dates: IsoDate[] } {
  let account: string | null = null;
  const dates: IsoDate[] = [];
  for (const cells of rows) {
    const text = cells.join(" ");
    const found = /conta(?:\s+corrente)?\s*[:-]?\s*(\d[\d.\-/]*\d)/i.exec(text);
    if (found && account === null) account = found[1]!;
    for (const raw of text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/g) ?? []) {
      const d = readDate(raw);
      if (d !== null) dates.push(d);
    }
  }
  return { account, dates };
}

const latest = (dates: readonly IsoDate[]): IsoDate | null =>
  dates.reduce<IsoDate | null>((a, b) => (a === null || compareDates(b, a) > 0 ? b : a), null);
const earliest = (dates: readonly IsoDate[]): IsoDate | null =>
  dates.reduce<IsoDate | null>((a, b) => (a === null || compareDates(b, a) < 0 ? b : a), null);

// ── the parser ──────────────────────────────────────

interface Row {
  line: Line;
  cells: readonly string[];
}

export class GenericStatementCsv implements Parser {
  readonly id = "csv-extrato-generico";
  readonly version = "1";
  readonly institution = "Qualquer banco (CSV)";
  readonly product = "Conta";
  readonly doc_type = DocType.BANK_STATEMENT;
  readonly doc_format = DocFormat.CSV;
  readonly validated_with_real_documents = false;
  readonly limitations =
    "Colunas reconhecidas pelo nome (data, descrição ou histórico, valor ou débito e crédito; saldo, documento e D/C " +
    "opcionais). Só extrato de conta: CSV de cartão precisa de layout próprio. Linhas de saldo e total não viram " +
    "lançamentos.";

  /** Below the layouts of a bank (0.9), so that those win; above the detection threshold (0.6). */
  detect(source: Source): number {
    if (source.format !== DocFormat.CSV) return 0.0;
    const found = findHeader(source);
    if (found === null) return 0.0;
    const dateAt = found.columns.date!;
    const anyDated = source.rows
      .slice(found.at + 1)
      .some(([, cells]) => readDate(cells[dateAt] ?? "") !== null || dayMonth(cells[dateAt] ?? "") !== null);
    return anyDated ? 0.7 : 0.0;
  }

  parse(source: Source): ParseResult {
    const found = findHeader(source);
    if (found === null) throw new Error("ValueError: no statement header");
    const { at, columns } = found;
    const cellOf = (cells: readonly string[], role: Role): string =>
      columns[role] === undefined ? "" : pyStrip(cells[columns[role]] ?? "");
    const rows: Row[] = source.rows.slice(at + 1).map(([number, cells]) => ({
      line: line(0, cells.join(","), null, number),
      cells,
    }));
    const moneyCells = rows.flatMap((r) => [
      cellOf(r.cells, "amount"),
      cellOf(r.cells, "debit"),
      cellOf(r.cells, "credit"),
      cellOf(r.cells, "balance"),
    ]);
    const convention = conventionOf(moneyCells.filter(Boolean));
    const above = preamble(source.rows.slice(0, at).map(([, cells]) => cells));
    // Dates without a year are placed before the latest full date the document itself prints.
    const fullDates = rows.map((r) => readDate(cellOf(r.cells, "date"))).filter((d): d is IsoDate => d !== null);
    const reference = latest([...fullDates, ...above.dates]);

    const result: ParseResult = { header: StatementHeaderSchema.parse({}), items: [], warnings: [], unmapped: [] };
    let opening: Dec | null = null;
    /** Each operation with its balance as printed, in file order (for the running-balance check). */
    const balances: { index: number; value: Dec; balance: Dec | null; date: IsoDate | null }[] = [];

    for (const row of rows) {
      const description = cellOf(row.cells, "description");
      const key = headerKey(description);
      if (BALANCE_LINE.test(key)) {
        if (OPENING_LINE.test(key) && opening === null) {
          opening =
            readAmount(cellOf(row.cells, "balance"), convention) ?? readAmount(cellOf(row.cells, "amount"), convention);
        }
        result.unmapped.push(row.line);
        continue;
      }
      const value = this.#value(row.cells, cellOf, convention);
      if (value === "both") {
        result.unmapped.push(row.line);
        continue;
      }
      if (value === null || value.isZero() || !description) {
        result.unmapped.push(row.line);
        continue;
      }
      const rawDate = cellOf(row.cells, "date");
      let when = readDate(rawDate);
      const partial = when === null ? dayMonth(rawDate) : null;
      if (partial !== null && reference !== null) when = resolveYear(partial[0], partial[1], reference);
      const item = parsedItem({
        kind: value.isPositive() ? ItemKind.CREDIT : ItemKind.DEBIT,
        occurred_on: when,
        description,
        amount: value.abs(),
        lines: [row.line],
        bank_id: cellOf(row.cells, "document") || null,
      });
      if (when === null) item.warnings.push(partial ? "Data sem ano e sem outra data no documento." : "Data inválida.");
      const balance = readAmount(cellOf(row.cells, "balance"), convention);
      balances.push({ index: result.items.length, value, balance, date: when });
      result.items.push(item);
    }

    const closingAndOpening = this.#balances(balances, opening, result);
    const dates = result.items.map((i) => i.occurred_on).filter((d): d is IsoDate => d !== null);
    const periodFrom = above.dates.length >= 2 ? earliest(above.dates) : earliest(dates);
    const periodTo = above.dates.length >= 2 ? latest(above.dates) : latest(dates);
    result.header = StatementHeaderSchema.parse({
      account_hint: above.account,
      period_start: periodFrom,
      period_end: periodTo,
      opening_balance: closingAndOpening.opening,
      closing_balance: closingAndOpening.closing,
    });
    if (!result.items.length) result.warnings.push("Nenhuma operação reconhecida no arquivo.");
    return result;
  }

  /** The signed value of a line: the amount column (with D/C when there is one) or debit/credit columns. */
  #value(
    cells: readonly string[],
    cellOf: (cells: readonly string[], role: Role) => string,
    convention: Convention,
  ): Dec | null | "both" {
    const amountCell = cellOf(cells, "amount");
    if (amountCell) {
      const value = readAmount(amountCell, convention);
      if (value === null) return null;
      const direction = headerKey(cellOf(cells, "direction"));
      if (/^(d|debito|saida)$/.test(direction)) return value.abs().negate();
      if (/^(c|credito|entrada)$/.test(direction)) return value.abs();
      return value;
    }
    const debit = readAmount(cellOf(cells, "debit"), convention);
    const credit = readAmount(cellOf(cells, "credit"), convention);
    const hasDebit = debit !== null && !debit.isZero();
    const hasCredit = credit !== null && !credit.isZero();
    if (hasDebit && hasCredit) return "both";
    if (hasDebit) return debit.abs().negate();
    if (hasCredit) return credit.abs();
    return null;
  }

  /**
   * Opening and closing balances from the balance column, read in date order (a file may list the newest
   * first). Each printed balance is checked against the one before plus the line's value.
   */
  #balances(
    rows: { index: number; value: Dec; balance: Dec | null; date: IsoDate | null }[],
    printedOpening: Dec | null,
    result: ParseResult,
  ): { opening: Dec | null; closing: Dec | null } {
    const withBalance = rows.filter((r) => r.balance !== null);
    if (!withBalance.length || withBalance.length !== rows.length) return { opening: printedOpening, closing: null };
    const first = rows[0]!.date;
    const last = rows.at(-1)!.date;
    const newestFirst = first !== null && last !== null && compareDates(first, last) > 0;
    const ordered = newestFirst ? [...rows].reverse() : rows;
    const opening = printedOpening ?? ordered[0]!.balance!.sub(ordered[0]!.value);
    let running = opening;
    for (const row of ordered) {
      running = running.add(row.value);
      if (!running.eq(row.balance!)) {
        result.items[row.index]!.warnings.push(
          `O saldo da linha (${row.balance!.toFixed()}) não confere com o saldo anterior mais o valor (${running.toFixed()}).`,
        );
        running = row.balance!;
      }
    }
    return { opening, closing: ordered.at(-1)!.balance };
  }
}
