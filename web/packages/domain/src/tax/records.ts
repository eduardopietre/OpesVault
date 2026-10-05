/** Reading and changing the tax entities (tax/model). Every change goes through `Ledger.put`. Port of `tax/records.py`. */
import { DomainError, type Ledger } from "../domain/ledger.ts";
import { AccountSubtype, AccountType, isActive, isLiquid } from "../domain/model.ts";
import { isCents, toDecimal, ZERO } from "../domain/money.ts";
import { type IsoDate, type YearMonth, ymEq } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import { type Id, isId } from "../lib/ids.ts";
import { casefold, sortedBy } from "../lib/text.ts";
import { isAssetCode } from "../catalogs/irpf.ts";
import { AssetClass } from "../investments/model.ts";
import { profileOf, TaxTreatment } from "../investments/profile.ts";
import { category, positions, TAX_CATEGORY } from "../investments/service.ts";
import { collapseSpaces, getOrKeyError, head, pyEquals } from "../lib/py.ts";
import * as ids from "./ids.ts";
import {
  ASSET_GROUPS,
  type AssetFiling,
  AssetFilingSchema,
  type BucketRule,
  type ChecklistMark,
  ChecklistMarkSchema,
  type DeclaredAsset,
  type FilingSubject,
  type IncomeClassification,
  IncomeClassificationSchema,
  type IncomeDetail,
  IncomeDetailSchema,
  IncomeKind,
  IncomeNature,
  type IncomeReport,
  IncomeReportSchema,
  type MemberTaxInfo,
  MemberTaxInfoSchema,
  NatureSubject,
  type PaymentPurpose,
  PURPOSE_LABELS,
  type ReportLine,
  ReportSource,
  type TaxIdentity,
  TaxIdentitySchema,
  type TaxParameters,
  type TaxPayment,
  TaxPaymentSchema,
  TaxSubject,
  type VariableIncomeRules,
  VariableIncomeRulesSchema,
  requireYear,
} from "./model.ts";

/** Python's `str.capitalize()`: the first character upper case, the rest lower case. */
function capitalize(text: string): string {
  const [first = "", ...rest] = [...text];
  return first.toUpperCase() + rest.join("").toLowerCase();
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

function money(value: unknown, label: string, allowNone = true): Dec | null {
  if (isBlank(value)) {
    if (allowNone) return null;
    throw new DomainError(`Informe ${label}.`);
  }
  const amount = value instanceof Dec ? value : toDecimal(value);
  if (amount.isNegative() || !isCents(amount)) {
    throw new DomainError(`${capitalize(label)}: informe um valor positivo em reais e centavos.`);
  }
  return amount;
}

function rate(value: unknown, label: string): Dec | null {
  if (isBlank(value)) return null;
  const r = value instanceof Dec ? value : toDecimal(value);
  if (!(ZERO.lte(r) && r.lte(1))) throw new DomainError(`${label}: informe uma alíquota entre 0% e 100%.`);
  return r;
}

// ── CPF / CNPJ ──────────────────────────────────

export function identities(ledger: Ledger) {
  return ledger.entities<TaxIdentity>("tax_identity");
}

export function identity(ledger: Ledger, subject: TaxSubject, ref: string): TaxIdentity | null {
  return [...identities(ledger).values()].find((i) => i.subject === subject && i.ref === ref) ?? null;
}

/** Records the CPF or CNPJ of a payee (merchant), an institution (account) or a payer (category). */
export function setIdentity(
  ledger: Ledger,
  subject: TaxSubject,
  ref: string,
  taxId: string,
  name: string | null = null,
): TaxIdentity {
  if (subject === TaxSubject.ACCOUNT || subject === TaxSubject.CATEGORY) {
    if (!isId(ref) || !ledger.accounts.has(ref)) throw new DomainError("Escolha a conta ou a categoria.");
  } else if (!ref.trim()) {
    throw new DomainError("Escolha o estabelecimento.");
  }
  const number = ids.normalize(taxId);
  const label = head(collapseSpaces(name ?? ""), 150) || null;
  const current = identity(ledger, subject, ref);
  if (current === null) {
    return ledger.put("tax_identity", TaxIdentitySchema.parse({ subject, ref, tax_id: number, name: label }));
  }
  if (current.tax_id === number && current.name === label) return current;
  return ledger.put("tax_identity", { ...current, tax_id: number, name: label }, { reason: "CPF/CNPJ alterado" });
}

export function clearIdentity(ledger: Ledger, subject: TaxSubject, ref: string): void {
  const current = identity(ledger, subject, ref);
  if (current !== null) identities(ledger).delete(current.id);
}

// ── people: CPF, birth date, who declares whom ──────────

export function memberInfos(ledger: Ledger) {
  return ledger.entities<MemberTaxInfo>("member_tax_info");
}

export function memberInfo(ledger: Ledger, memberId: Id): MemberTaxInfo | null {
  return [...memberInfos(ledger).values()].find((i) => i.member_id === memberId) ?? null;
}

export interface MemberInfoFields {
  readonly cpf: string | null;
  readonly birth_date: IsoDate | null;
  readonly declared_by: Id | null;
  readonly relation?: string | null;
}

/** `today` replaces Python's `date.today()` (a birth date in the future is refused). */
export function setMemberInfo(ledger: Ledger, memberId: Id, fields: MemberInfoFields, today: IsoDate): MemberTaxInfo {
  if (!ledger.members.has(memberId)) throw new DomainError("Integrante inexistente.");
  const number = fields.cpf && fields.cpf.trim() ? ids.normalize(fields.cpf, [ids.TaxIdKind.CPF]) : null;
  let declaredBy = fields.declared_by;
  if (declaredBy !== null) {
    if (!ledger.members.has(declaredBy)) throw new DomainError("Escolha quem declara este integrante.");
    if (declaredBy === memberId) {
      declaredBy = null;
    } else {
      const above = memberInfo(ledger, declaredBy);
      if (above !== null && above.declared_by !== null) {
        throw new DomainError("Quem declara não pode ser dependente na declaração de outra pessoa.");
      }
      if ([...memberInfos(ledger).values()].some((i) => i.declared_by === memberId)) {
        throw new DomainError("Este integrante declara outras pessoas; não pode ser dependente.");
      }
    }
  }
  if (number !== null) {
    const other = [...memberInfos(ledger).values()].find((i) => i.cpf === number && i.member_id !== memberId);
    if (other !== undefined) throw new DomainError("Este CPF já pertence a outro integrante.");
  }
  if (fields.birth_date !== null && fields.birth_date > today) {
    throw new DomainError("A data de nascimento está no futuro.");
  }
  const update = {
    cpf: number,
    birth_date: fields.birth_date,
    declared_by: declaredBy,
    relation: head((fields.relation ?? "").trim(), 60) || null,
  };
  const current = memberInfo(ledger, memberId);
  if (current === null)
    return ledger.put("member_tax_info", MemberTaxInfoSchema.parse({ member_id: memberId, ...update }));
  const updated: MemberTaxInfo = { ...current, ...update };
  if (pyEquals(updated, current)) return current;
  return ledger.put("member_tax_info", updated, { reason: "dados fiscais do integrante alterados" });
}

/** Members who file a return: everyone active who is not declared by someone else. */
export function declarants(ledger: Ledger): Id[] {
  const dependents = new Set(
    [...memberInfos(ledger).values()].filter((i) => i.declared_by !== null).map((i) => i.member_id),
  );
  return sortedBy([...ledger.members.values()], (m) => casefold(m.name))
    .filter((m) => m.active && !dependents.has(m.id))
    .map((m) => m.id);
}

export function dependentsOf(ledger: Ledger, declarantId: Id): Id[] {
  return [...memberInfos(ledger).values()].filter((i) => i.declared_by === declarantId).map((i) => i.member_id);
}

/** The declarant and their dependents; null is the whole project (nobody filtered). */
export function peopleOf(ledger: Ledger, declarantId: Id | null): Set<Id> | null {
  if (declarantId === null) return null;
  return new Set([declarantId, ...dependentsOf(ledger, declarantId)]);
}

// ── income classification ──────────

export function classifications(ledger: Ledger) {
  return ledger.entities<IncomeClassification>("income_classification");
}

export function natureOf(ledger: Ledger, subject: NatureSubject, ref: Id): IncomeNature | null {
  const found = [...classifications(ledger).values()].find((c) => c.subject === subject && c.ref === ref);
  if (found !== undefined) return found.nature;
  if (subject === NatureSubject.CATEGORY) {
    const account = ledger.accounts.get(ref);
    if (account !== undefined && account.parent_id !== null) {
      return natureOf(ledger, subject, account.parent_id); // a subcategory follows its parent
    }
    return null;
  }
  return profileNature(ledger, ref);
}

/** Built on first use: `investments/profile` and this module import each other (through `domain/banking`). */
let natureByTreatment: ReadonlyMap<TaxTreatment, IncomeNature> | null = null;
function treatmentNature(tax: TaxTreatment): IncomeNature | null {
  natureByTreatment ??= new Map([
    [TaxTreatment.EXEMPT, IncomeNature.EXEMPT],
    [TaxTreatment.WITHHELD, IncomeNature.EXCLUSIVE],
    [TaxTreatment.COME_COTAS, IncomeNature.EXCLUSIVE],
  ]);
  return natureByTreatment.get(tax) ?? null;
}

/** An investment's characteristics (income code, tax treatment) say how its income is declared. */
function profileNature(ledger: Ledger, positionId: Id): IncomeNature | null {
  const profile = profileOf(ledger, positionId);
  if (profile === null) return null;
  if (profile.income_code !== null) {
    return profile.income_code.startsWith("isento") ? IncomeNature.EXEMPT : IncomeNature.EXCLUSIVE;
  }
  return profile.tax ? treatmentNature(profile.tax) : null;
}

/** The IRPF line code of an investment's income ('12'), from its characteristics. */
export function incomeCodeOf(ledger: Ledger, positionId: Id): string | null {
  const profile = profileOf(ledger, positionId);
  return profile !== null && profile.income_code ? profile.income_code.split(":")[1]! : null;
}

export function classify(ledger: Ledger, subject: NatureSubject, ref: Id, nature: IncomeNature | null): void {
  if (subject === NatureSubject.CATEGORY) {
    const account = ledger.accounts.get(ref);
    if (account === undefined || account.type !== AccountType.INCOME) {
      throw new DomainError("Só categorias de receita têm natureza fiscal.");
    }
  } else if (!positions(ledger).has(ref)) {
    throw new DomainError("Investimento inexistente.");
  }
  const current = [...classifications(ledger).values()].find((c) => c.subject === subject && c.ref === ref);
  if (nature === null) {
    if (current !== undefined) classifications(ledger).delete(current.id);
    return;
  }
  if (current === undefined) {
    ledger.put("income_classification", IncomeClassificationSchema.parse({ subject, ref, nature }));
  } else if (current.nature !== nature) {
    ledger.put("income_classification", { ...current, nature }, { reason: "natureza alterada" });
  }
}

// ── payslip detail of a deposit ──────────

export function incomeDetails(ledger: Ledger) {
  return ledger.entities<IncomeDetail>("income_detail");
}

export function detailOf(ledger: Ledger, operationId: Id): IncomeDetail | null {
  return [...incomeDetails(ledger).values()].find((d) => d.operation_id === operationId) ?? null;
}

export function receivedAmount(ledger: Ledger, operationId: Id): Dec {
  const op = getOrKeyError(ledger.operations, operationId);
  return Dec.sum(
    op.postings.filter((p) => ledger.account(p.account_id).type === AccountType.INCOME).map((p) => p.amount.negate()),
    ZERO,
  );
}

/** Gross, IRRF and INSS of a salary deposit. Empty fields stay unknown, never zero. */
export function setIncomeDetail(
  ledger: Ledger,
  operationId: Id,
  kind: IncomeKind,
  gross: unknown = null,
  withheld: unknown = null,
  socialSecurity: unknown = null,
): IncomeDetail | null {
  const op = ledger.operations.get(operationId);
  if (op === undefined || !isActive(op)) throw new DomainError("Escolha um lançamento ativo.");
  const received = receivedAmount(ledger, operationId);
  if (!received.isPositive()) throw new DomainError("Só receitas têm detalhamento de rendimento.");
  const values = {
    gross: money(gross, "o valor bruto"),
    withheld: money(withheld, "o imposto retido"),
    social_security: money(socialSecurity, "a contribuição ao INSS"),
  };
  if (values.gross !== null && values.gross.lt(received)) {
    throw new DomainError("O bruto não pode ser menor que o valor recebido.");
  }
  const current = detailOf(ledger, operationId);
  if (Object.values(values).every((v) => v === null) && kind === IncomeKind.SALARY) {
    if (current !== null) incomeDetails(ledger).delete(current.id);
    return null;
  }
  const detail = IncomeDetailSchema.parse({ operation_id: operationId, kind, ...values });
  if (current === null) return ledger.put("income_detail", detail);
  const updated: IncomeDetail = { ...detail, id: current.id };
  if (pyEquals(updated, current)) return current;
  return ledger.put("income_detail", updated, { reason: "detalhamento do rendimento alterado" });
}

// ── Bens e Direitos ──────────

export function filings(ledger: Ledger) {
  return ledger.entities<AssetFiling>("asset_filing");
}

export function filingOf(ledger: Ledger, subject: FilingSubject, ref: Id): AssetFiling | null {
  return [...filings(ledger).values()].find((f) => f.subject === subject && f.ref === ref) ?? null;
}

function checkCode(group: string, code: string): void {
  if (!ASSET_GROUPS.has(group)) throw new DomainError("Escolha o grupo do bem.");
  if (!isAssetCode(group, code)) throw new DomainError("Escolha o código na tabela de Bens e Direitos do IRPF.");
}

export function setFiling(
  ledger: Ledger,
  subject: FilingSubject,
  ref: Id,
  group: string,
  code: string,
  description: string,
): AssetFiling {
  checkCode(group, code);
  const text = head(collapseSpaces(description), 512);
  const current = filingOf(ledger, subject, ref);
  if (current === null) {
    return ledger.put("asset_filing", AssetFilingSchema.parse({ subject, ref, group, code, description: text }));
  }
  const updated: AssetFiling = { ...current, group, code, description: text };
  if (pyEquals(updated, current)) return current;
  return ledger.put("asset_filing", updated, { reason: "bem alterado" });
}

export const GROUP_BY_SUBTYPE: ReadonlyMap<AccountSubtype, string> = new Map([
  [AccountSubtype.CHECKING, "06"],
  [AccountSubtype.CASH, "06"],
  [AccountSubtype.BROKERAGE_CASH, "06"],
  [AccountSubtype.SAVINGS, "04"],
]);
export const GROUP_BY_CLASS: ReadonlyMap<AssetClass, string> = new Map([
  [AssetClass.FIXED_INCOME, "04"],
  [AssetClass.TREASURY, "04"],
  [AssetClass.STOCK, "03"],
  [AssetClass.REIT, "07"],
  [AssetClass.FUND, "07"],
  [AssetClass.ETF, "07"],
  [AssetClass.CRYPTO, "08"],
]);

/** A starting point for the user to confirm; never filed on its own. */
export function suggestedGroup(
  subtype: AccountSubtype | null = null,
  assetClass: AssetClass | null = null,
): string | null {
  if (subtype !== null) return GROUP_BY_SUBTYPE.get(subtype) ?? null;
  if (assetClass !== null) return GROUP_BY_CLASS.get(assetClass) ?? null;
  return null;
}

export function declaredAssets(ledger: Ledger) {
  return ledger.entities<DeclaredAsset>("declared_asset");
}

export function saveDeclaredAsset(ledger: Ledger, asset: DeclaredAsset, reason: string | null = null): DeclaredAsset {
  checkCode(asset.group, asset.code);
  money(asset.cost, "o custo de aquisição", false);
  if (asset.sale_value !== null) money(asset.sale_value, "o valor de venda");
  if (asset.sold_on !== null && asset.sold_on < asset.acquired_on) {
    throw new DomainError("A venda não pode ser antes da aquisição.");
  }
  if (asset.owner_id !== null && !ledger.members.has(asset.owner_id)) throw new DomainError("Escolha o dono do bem.");
  if (declaredAssets(ledger).has(asset.id))
    return ledger.put("declared_asset", asset, { reason: reason || "bem alterado" });
  return ledger.put("declared_asset", asset);
}

export function removeDeclaredAsset(ledger: Ledger, assetId: Id): void {
  if (declaredAssets(ledger).has(assetId)) declaredAssets(ledger).delete(assetId);
}

// ── informes ──────────

export function reports(ledger: Ledger) {
  return ledger.entities<IncomeReport>("income_report");
}

export function reportsOf(ledger: Ledger, year: number): IncomeReport[] {
  return sortedBy(
    [...reports(ledger).values()].filter((r) => r.year === year),
    (r) => [r.source, r.source_id],
  );
}

export interface SaveReportOptions {
  readonly payer_tax_id?: string | null;
  readonly payer_name?: string | null;
  readonly document_id?: Id | null;
  readonly report_id?: Id | null;
  readonly note?: string | null;
}

export function saveReport(
  ledger: Ledger,
  year: number,
  source: ReportSource,
  sourceId: Id,
  lines: readonly ReportLine[],
  options: SaveReportOptions = {},
): IncomeReport {
  requireYear(year);
  const account = ledger.accounts.get(sourceId);
  if (account === undefined) throw new DomainError("Escolha de quem é o informe.");
  if (source === ReportSource.ACCOUNT && account.type !== AccountType.ASSET && account.type !== AccountType.LIABILITY) {
    throw new DomainError("Escolha a conta do banco ou da corretora.");
  }
  if (source === ReportSource.CATEGORY && account.type !== AccountType.INCOME) {
    throw new DomainError("Escolha a categoria de receita da fonte pagadora.");
  }
  for (const line of lines) if (!isCents(line.amount)) throw new DomainError("Use valores em reais e centavos.");
  const number = options.payer_tax_id ? ids.normalize(options.payer_tax_id) : null;
  const fields = {
    year,
    source,
    source_id: sourceId,
    payer_tax_id: number,
    payer_name: head((options.payer_name ?? "").trim(), 150) || null,
    document_id: options.document_id ?? null,
    lines: [...lines],
    note: head((options.note ?? "").trim(), 500) || null,
  };
  const reportId = options.report_id ?? null;
  const current = reportId !== null ? (reports(ledger).get(reportId) ?? null) : null;
  if (current === null) {
    const duplicate = reportsOf(ledger, year).find((r) => r.source === source && r.source_id === sourceId);
    if (duplicate !== undefined) throw new DomainError("Já há um informe desta fonte neste ano; abra-o para corrigir.");
    return ledger.put("income_report", IncomeReportSchema.parse(fields));
  }
  return ledger.put("income_report", { ...current, ...fields }, { reason: "informe corrigido" });
}

export function removeReport(ledger: Ledger, reportId: Id): void {
  if (reports(ledger).has(reportId)) reports(ledger).delete(reportId);
}

// ── parameters informed by the user ──────────

function allParameters(ledger: Ledger) {
  return ledger.entities<TaxParameters>("tax_parameters");
}

export function parameters(ledger: Ledger, year: number): TaxParameters | null {
  return [...allParameters(ledger).values()].find((p) => p.year === year) ?? null;
}

export function setParameters(ledger: Ledger, params: TaxParameters): TaxParameters {
  requireYear(params.year);
  let last: Dec | null = null;
  params.brackets.forEach((bracket, index) => {
    if (bracket.up_to === null && index !== params.brackets.length - 1) {
      throw new DomainError("Só a última faixa fica sem limite.");
    }
    if (bracket.up_to !== null) {
      if (last !== null && bracket.up_to.lte(last)) throw new DomainError("Os limites das faixas precisam crescer.");
      last = bracket.up_to;
    }
    rate(bracket.rate, "Alíquota da faixa");
    money(bracket.deduction, "a parcela a deduzir", false);
  });
  rate(params.simplified_rate, "Desconto simplificado");
  rate(params.pension_cap_rate, "Limite da previdência privada");
  for (const [value, label] of [
    [params.simplified_cap, "o teto do desconto simplificado"],
    [params.dependent_deduction, "a dedução por dependente"],
    [params.education_cap, "o limite de educação"],
  ] as const) {
    money(value, label);
  }
  const current = parameters(ledger, params.year);
  if (current === null) return ledger.put("tax_parameters", params);
  const updated: TaxParameters = { ...params, id: current.id };
  return pyEquals(updated, current) ? current : ledger.put("tax_parameters", updated, { reason: "tabela alterada" });
}

function allVariableRules(ledger: Ledger) {
  return ledger.entities<VariableIncomeRules>("variable_income_rules");
}

/** The rules in force on a date (the most recent `valid_from` not after it). */
export function variableRules(ledger: Ledger, on: IsoDate | null = null): VariableIncomeRules | null {
  let found = sortedBy([...allVariableRules(ledger).values()], (r) => r.valid_from);
  if (on !== null) found = found.filter((r) => r.valid_from <= on);
  return found[found.length - 1] ?? null;
}

export function setVariableRules(
  ledger: Ledger,
  validFrom: IsoDate,
  rules: readonly BucketRule[],
  source: string,
): VariableIncomeRules {
  for (const rule of rules) {
    rate(rule.rate, "Alíquota");
    money(rule.exempt_sales_limit, "o limite de vendas isentas");
  }
  const current = [...allVariableRules(ledger).values()].find((r) => r.valid_from === validFrom);
  const text = head((source || "").trim(), 300) || "informado pelo usuário";
  if (current === undefined) {
    return ledger.put(
      "variable_income_rules",
      VariableIncomeRulesSchema.parse({ valid_from: validFrom, rules: [...rules], source: text }),
    );
  }
  const updated: VariableIncomeRules = { ...current, rules: [...rules], source: text };
  return pyEquals(updated, current)
    ? current
    : ledger.put("variable_income_rules", updated, { reason: "regras alteradas" });
}

// ── DARF payments ──────────

export function payments(ledger: Ledger) {
  return ledger.entities<TaxPayment>("tax_payment");
}

export function paid(ledger: Ledger, purpose: PaymentPurpose, month: YearMonth, memberId: Id | null = null): Dec {
  return Dec.sum(
    [...payments(ledger).values()]
      .filter(
        (p) =>
          p.purpose === purpose &&
          ymEq(p.month, month) &&
          (memberId === null || p.member_id === null || p.member_id === memberId),
      )
      .map((p) => p.amount),
    ZERO,
  );
}

/** A DARF paid: the money leaves the account as a tax expense and the month is marked as paid. */
export function recordPayment(
  ledger: Ledger,
  purpose: PaymentPurpose,
  month: YearMonth,
  amount: unknown,
  paidOn: IsoDate,
  fromAccount: Id,
  memberId: Id | null = null,
): TaxPayment {
  const value = money(amount, "o valor pago", false)!;
  if (value.isZero()) throw new DomainError("Informe o valor pago.");
  const account = ledger.accounts.get(fromAccount);
  if (account === undefined || !isLiquid(account)) throw new DomainError("Escolha a conta de onde saiu o pagamento.");
  const tax = category(ledger, AccountType.EXPENSE, TAX_CATEGORY);
  const op = ledger.recordExpense(
    fromAccount,
    tax,
    value,
    paidOn,
    `${PURPOSE_LABELS[purpose]} — ${String(month.month).padStart(2, "0")}/${month.year}`,
    { member_id: memberId },
  );
  return ledger.put(
    "tax_payment",
    TaxPaymentSchema.parse({
      purpose,
      month,
      amount: value,
      paid_on: paidOn,
      operation_id: op.id,
      member_id: memberId,
    }),
  );
}

// ── documents checklist ──────────

export function marks(ledger: Ledger) {
  return ledger.entities<ChecklistMark>("tax_checklist_mark");
}

export function markOf(ledger: Ledger, year: number, key: string): ChecklistMark | null {
  return [...marks(ledger).values()].find((m) => m.year === year && m.key === key) ?? null;
}

/**
 * Marks a document of the checklist as received (or not) by hand; null returns to automatic.
 * Like the desktop, changing an existing mark goes through `put` without a reason, which the
 * ledger refuses ("Alterações exigem um motivo.").
 */
export function setMark(
  ledger: Ledger,
  year: number,
  key: string,
  received: boolean | null,
  note: string | null = null,
): void {
  const current = markOf(ledger, year, key);
  if (received === null) {
    if (current !== null) marks(ledger).delete(current.id);
    return;
  }
  const text = head((note ?? "").trim(), 300) || null;
  if (current === null) {
    ledger.put("tax_checklist_mark", ChecklistMarkSchema.parse({ year, key, received, note: text }));
  } else if (current.received !== received || current.note !== text) {
    ledger.put("tax_checklist_mark", { ...current, received, note: text });
  }
}
