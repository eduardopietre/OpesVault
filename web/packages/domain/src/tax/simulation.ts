/**
 * Simplified or itemized return: which one costs less, with the table the user informed.
 * Port of `tax/simulation.py`.
 *
 * A simulation: it writes nothing and uses only the parameters of the year typed by the user
 * (`TaxParameters`). Missing parameters make the affected result unknown, never zero; donations
 * deducted from the tax itself and any extra reducer of the year are not considered.
 */
import type { Ledger } from "../domain/ledger.ts";
import { roundMoney, ZERO } from "../domain/money.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import * as declaration from "./declaration.ts";
import type { DeductibleKind } from "../domain/deductibles.ts";
import { type Bracket, IncomeNature, PaymentPurpose, type TaxParameters } from "./model.ts";
import * as records from "./records.ts";

export const NOTICE =
  "Simulação com a tabela e os limites que você informou para o ano. Não considera doações deduzidas " +
  "do imposto, redutores extras nem rendimentos que não foram registrados; o programa da Receita decide.";

export interface Model {
  name: string;
  deductions: Dec | null;
  base: Dec | null;
  tax: Dec | null;
}

export interface Comparison {
  year: number;
  taxable: Dec;
  withheld: Dec; // IRRF on salaries plus Carnê-Leão paid
  deductions: Map<string, Dec>; // itemized, by label
  left_out: Map<string, Dec>; // recorded, not deductible from the base
  simplified: Model | null;
  itemized: Model | null;
  missing: string[];
}

/** Python's `Comparison.balance(model)`: positive, to pay; negative, to be refunded. */
export function balanceOf(comparison: Comparison, model: Model | null): Dec | null {
  if (model === null || model.tax === null) return null;
  return model.tax.sub(comparison.withheld);
}

/** Python's `Comparison.best` property: the cheaper model when both are known. */
export function best(comparison: Comparison): Model | null {
  const known = [comparison.simplified, comparison.itemized].filter((m): m is Model => m !== null && m.tax !== null);
  if (known.length !== 2) return null;
  // Python's `min(key=tax)` keeps the first of equal values.
  return known[1]!.tax!.lt(known[0]!.tax!) ? known[1]! : known[0]!;
}

export function tableTax(brackets: readonly Bracket[], base: Dec): Dec {
  if (!base.isPositive() || !brackets.length) return ZERO;
  for (const bracket of brackets) {
    if (bracket.up_to === null || base.lte(bracket.up_to)) {
      return Dec.max(roundMoney(base.mul(bracket.rate).sub(bracket.deduction)), ZERO);
    }
  }
  const last = brackets[brackets.length - 1]!;
  return Dec.max(roundMoney(base.mul(last.rate).sub(last.deduction)), ZERO);
}

export function compare(ledger: Ledger, year: number, declarantId: Id | null): Comparison {
  const people = records.peopleOf(ledger, declarantId);
  const params = records.parameters(ledger, year);
  const found = declaration.income(ledger, year, people);
  let taxable = Dec.sum(
    found.taxable.map((r) => r.taxable),
    ZERO,
  );
  taxable = taxable.add(
    Dec.sum(
      declaration.byNature(found, IncomeNature.CARNE_LEAO).map((r) => r.amount),
      ZERO,
    ),
  );
  let withheld = Dec.sum(
    found.taxable.map((r) => r.withheld),
    ZERO,
  );
  withheld = withheld.add(
    Dec.sum(
      found.carne_leao.map((m) => m.paid),
      ZERO,
    ),
  );
  const out: Comparison = {
    year,
    taxable,
    withheld,
    deductions: new Map(),
    left_out: new Map(),
    simplified: null,
    itemized: null,
    missing: [],
  };
  if (params === null || !params.brackets.length) out.missing.push(`a tabela anual de ${year}`);
  const social = Dec.sum(
    found.taxable.map((r) => r.social_security),
    ZERO,
  );
  if (!social.isZero()) out.deductions.set("Previdência oficial (INSS)", social);
  itemize(ledger, year, people, declarantId, params, taxable, out);
  if (params !== null && params.brackets.length) models(params, taxable, out);
  return out;
}

function itemize(
  ledger: Ledger,
  year: number,
  people: ReadonlySet<Id> | null,
  declarantId: Id | null,
  params: TaxParameters | null,
  taxable: Dec,
  out: Comparison,
): void {
  const rows = declaration.payments(ledger, year, people);
  const byKind = new Map<DeductibleKind, Dec>();
  const education = new Map<Id | null, Dec>();
  for (const row of rows) {
    const net = declaration.paymentNet(row);
    byKind.set(row.kind, (byKind.get(row.kind) ?? ZERO).add(net));
    if (row.kind === "education")
      education.set(row.beneficiary_id, (education.get(row.beneficiary_id) ?? ZERO).add(net));
  }
  const nonZero = (kind: DeductibleKind) => {
    const v = byKind.get(kind);
    return v !== undefined && !v.isZero() ? v : null;
  };
  const health = nonZero("health");
  if (health !== null) out.deductions.set("Despesas médicas", health);
  if (education.size) {
    if (params === null || params.education_cap === null) {
      out.missing.push("o limite anual de educação");
    } else {
      const cap = params.education_cap;
      out.deductions.set(
        "Instrução (até o limite por pessoa)",
        Dec.sum(
          [...education.values()].map((v) => Dec.min(Dec.max(v, ZERO), cap)),
          ZERO,
        ),
      );
    }
  }
  const pension = byKind.get("pension") ?? ZERO;
  if (!pension.isZero()) {
    if (params === null || params.pension_cap_rate === null) {
      out.missing.push("o limite da previdência privada");
    } else {
      out.deductions.set(
        "Previdência privada (até o limite)",
        Dec.min(pension, roundMoney(taxable.mul(params.pension_cap_rate))),
      );
    }
  }
  const alimony = nonZero("alimony");
  if (alimony !== null) out.deductions.set("Pensão alimentícia", alimony);
  const count = declarantId ? records.dependentsOf(ledger, declarantId).length : 0;
  if (count) {
    if (params === null || params.dependent_deduction === null) {
      out.missing.push("a dedução por dependente");
    } else {
      out.deductions.set(`Dependentes (${count})`, params.dependent_deduction.mul(count));
    }
  }
  for (const [kind, label] of [
    ["donation", "Doações (deduzidas do imposto)"],
    ["other", "Outras"],
  ] as const) {
    const value = nonZero(kind);
    if (value !== null) out.left_out.set(label, value);
  }
}

function models(params: TaxParameters, taxable: Dec, out: Comparison): void {
  const deductions = Dec.sum(out.deductions.values(), ZERO);
  const itemizedKnown = ![
    "o limite anual de educação",
    "o limite da previdência privada",
    "a dedução por dependente",
  ].some((m) => out.missing.includes(m));
  if (itemizedKnown) {
    const base = Dec.max(taxable.sub(deductions), ZERO);
    out.itemized = { name: "Completa", deductions, base, tax: tableTax(params.brackets, base) };
  } else {
    out.itemized = { name: "Completa", deductions: null, base: null, tax: null };
  }
  if (params.simplified_rate === null || params.simplified_cap === null) {
    out.missing.push("o desconto simplificado (percentual e teto)");
    out.simplified = { name: "Simplificada", deductions: null, base: null, tax: null };
    return;
  }
  const discount = Dec.min(roundMoney(taxable.mul(params.simplified_rate)), params.simplified_cap);
  const base = Dec.max(taxable.sub(discount), ZERO);
  out.simplified = { name: "Simplificada", deductions: discount, base, tax: tableTax(params.brackets, base) };
}

export function carneLeaoPaid(ledger: Ledger, year: number): Dec {
  return Dec.sum(
    [...records.payments(ledger).values()]
      .filter((p) => p.purpose === PaymentPurpose.CARNE_LEAO && p.month.year === year)
      .map((p) => p.amount),
    ZERO,
  );
}
