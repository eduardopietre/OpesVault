/**
 * Persisted tax entities: who is who (CPF/CNPJ), how income is declared, assets, statements.
 * Port of `tax/model.py`.
 *
 * Classification is the user's: the app never decides that an income is exempt or taxable.
 * Every rate, table and limit is informed by the user for the year it applies to (docs/00 §5).
 * Classification lives beside the operations, never inside them (CLAUDE.md, "Classificação
 * não é fato financeiro").
 */
import { z } from "zod";

import { GROUPS } from "../catalogs/irpf.ts";
import { DomainError, Ledger } from "../domain/ledger.ts";
import { zEntityId } from "../domain/model.ts";
import { zDate, zDec, zId, zYearMonth, zEnumOf } from "../lib/schema.ts";

const YEAR = () => z.number().int().min(1990).max(2999);
const CODE = () => z.string().regex(/^\d{2}$/);
const TAX_ID = () => z.string().regex(/^\d{11}$|^\d{14}$/);

// ── tax ids of the people and companies around the money ──────────

export const TaxSubject = {
  MERCHANT: "merchant", // ref: merchant key (domain/merchants keyOf): doctor, school, health plan
  ACCOUNT: "account", // ref: account id: bank, broker, lender
  CATEGORY: "category", // ref: income category id: employer, tenant, client
} as const;
export type TaxSubject = (typeof TaxSubject)[keyof typeof TaxSubject];

export const TaxIdentitySchema = z.strictObject({
  id: zEntityId,
  subject: zEnumOf(TaxSubject),
  ref: z.string().min(1).max(120),
  tax_id: TAX_ID(),
  name: z.string().max(150).nullable().default(null), // name as it goes in the return
});
export type TaxIdentity = Readonly<z.output<typeof TaxIdentitySchema>>;

export const MemberTaxInfoSchema = z.strictObject({
  id: zEntityId,
  member_id: zId,
  cpf: z
    .string()
    .regex(/^\d{11}$/)
    .nullable()
    .default(null),
  birth_date: zDate.nullable().default(null),
  declared_by: zId.nullable().default(null), // null: files their own return (or is not declared)
  relation: z.string().max(60).nullable().default(null), // "Filho(a)", "Cônjuge"
});
export type MemberTaxInfo = Readonly<z.output<typeof MemberTaxInfoSchema>>;

// ── how each income is declared (the user's choice) ──────────

export const IncomeNature = {
  TAXABLE_PJ: "taxable_pj",
  CARNE_LEAO: "carne_leao",
  EXEMPT: "exempt",
  EXCLUSIVE: "exclusive",
  IGNORED: "ignored",
} as const;
export type IncomeNature = (typeof IncomeNature)[keyof typeof IncomeNature];

export const NATURE_LABELS: Readonly<Record<IncomeNature, string>> = {
  taxable_pj: "Tributável recebido de pessoa jurídica",
  carne_leao: "Tributável recebido de pessoa física ou do exterior (Carnê-Leão)",
  exempt: "Isento e não tributável",
  exclusive: "Tributação exclusiva ou definitiva",
  ignored: "Não entra na declaração",
};
export const NATURE_SHORT: Readonly<Record<IncomeNature, string>> = {
  taxable_pj: "Tributável (PJ)",
  carne_leao: "Carnê-Leão",
  exempt: "Isento",
  exclusive: "Exclusiva",
  ignored: "Não declarar",
};

export const NatureSubject = {
  CATEGORY: "category", // an income category
  POSITION: "position", // an investment: its proventos and redemption gains
} as const;
export type NatureSubject = (typeof NatureSubject)[keyof typeof NatureSubject];

export const IncomeClassificationSchema = z.strictObject({
  id: zEntityId,
  subject: zEnumOf(NatureSubject),
  ref: zId,
  nature: zEnumOf(IncomeNature),
});
export type IncomeClassification = Readonly<z.output<typeof IncomeClassificationSchema>>;

export const IncomeKind = { SALARY: "salary", THIRTEENTH: "thirteenth", OTHER: "other" } as const;
export type IncomeKind = (typeof IncomeKind)[keyof typeof IncomeKind];

export const INCOME_KIND_LABELS: Readonly<Record<IncomeKind, string>> = {
  salary: "Salário, férias e outros",
  thirteenth: "13º salário",
  other: "Outro rendimento do trabalho",
};

/** What the payslip says about a deposit: the gross, the tax withheld, the INSS. */
export const IncomeDetailSchema = z.strictObject({
  id: zEntityId,
  operation_id: zId,
  kind: zEnumOf(IncomeKind).default(IncomeKind.SALARY),
  gross: zDec.nullable().default(null),
  withheld: zDec.nullable().default(null),
  social_security: zDec.nullable().default(null),
});
export type IncomeDetail = Readonly<z.output<typeof IncomeDetailSchema>>;

// ── assets (Bens e Direitos) ──────────

export const FilingSubject = { ACCOUNT: "account", POSITION: "position" } as const;
export type FilingSubject = (typeof FilingSubject)[keyof typeof FilingSubject];

/** The IRPF table (catalogs/irpf). */
export const ASSET_GROUPS = GROUPS;

/** How an account or an investment is described in Bens e Direitos. */
export const AssetFilingSchema = z.strictObject({
  id: zEntityId,
  subject: zEnumOf(FilingSubject),
  ref: zId,
  group: CODE(),
  code: CODE(),
  description: z.string().max(512).default(""),
});
export type AssetFiling = Readonly<z.output<typeof AssetFilingSchema>>;

/** A good that is not an account: a house, a car. Declared at acquisition cost. */
export const DeclaredAssetSchema = z.strictObject({
  id: zEntityId,
  name: z.string().min(1).max(120),
  group: CODE(),
  code: CODE(),
  description: z.string().max(512).default(""),
  owner_id: zId.nullable().default(null),
  acquired_on: zDate,
  cost: zDec,
  sold_on: zDate.nullable().default(null),
  sale_value: zDec.nullable().default(null),
});
export type DeclaredAsset = Readonly<z.output<typeof DeclaredAssetSchema>>;

// ── statements from the institutions (informes de rendimentos) ──────────

export const ReportField = {
  BALANCE_PREVIOUS: "balance_previous",
  BALANCE_END: "balance_end",
  TAXABLE: "taxable",
  THIRTEENTH: "thirteenth",
  SOCIAL_SECURITY: "social_security",
  WITHHELD: "withheld",
  EXEMPT: "exempt",
  EXCLUSIVE: "exclusive",
} as const;
export type ReportField = (typeof ReportField)[keyof typeof ReportField];

export const FIELD_LABELS: Readonly<Record<ReportField, string>> = {
  balance_previous: "Saldo no fim do ano anterior",
  balance_end: "Saldo no fim do ano",
  taxable: "Rendimentos tributáveis",
  thirteenth: "13º salário",
  social_security: "Contribuição previdenciária oficial",
  withheld: "Imposto retido na fonte",
  exempt: "Rendimentos isentos",
  exclusive: "Tributação exclusiva",
};

export const ReportLineSchema = z.strictObject({
  field: zEnumOf(ReportField),
  amount: zDec,
  label: z.string().max(200).default(""), // the line as printed
});
export type ReportLine = Readonly<z.output<typeof ReportLineSchema>>;

export const ReportSource = {
  ACCOUNT: "account", // bank, broker
  CATEGORY: "category", // employer or other payer, by its income category
} as const;
export type ReportSource = (typeof ReportSource)[keyof typeof ReportSource];

export const IncomeReportSchema = z.strictObject({
  id: zEntityId,
  year: YEAR(),
  source: zEnumOf(ReportSource),
  source_id: zId,
  payer_tax_id: TAX_ID().nullable().default(null),
  payer_name: z.string().max(150).nullable().default(null),
  document_id: zId.nullable().default(null), // the original file, kept encrypted in the vault
  lines: z.array(ReportLineSchema).readonly().default([]),
  note: z.string().max(500).nullable().default(null),
});
export type IncomeReport = Readonly<z.output<typeof IncomeReportSchema>>;

// ── parameters informed by the user ──────────

export const BracketSchema = z.strictObject({
  up_to: zDec.nullable(), // null: the last bracket
  rate: zDec, // 0.075
  deduction: zDec, // parcela a deduzir
});
export type Bracket = Readonly<z.output<typeof BracketSchema>>;

/** The annual table and limits of one year, copied by the user from the official source. */
export const TaxParametersSchema = z.strictObject({
  id: zEntityId,
  year: YEAR(),
  brackets: z.array(BracketSchema).readonly().default([]),
  simplified_rate: zDec.nullable().default(null), // desconto simplificado (0.20)
  simplified_cap: zDec.nullable().default(null),
  dependent_deduction: zDec.nullable().default(null), // per dependent, per year
  education_cap: zDec.nullable().default(null), // per person, per year
  pension_cap_rate: zDec.nullable().default(null), // PGBL: share of the taxable income (0.12)
  source: z.string().max(300).default("informado pelo usuário"),
});
export type TaxParameters = Readonly<z.output<typeof TaxParametersSchema>>;

export const Bucket = {
  COMMON: "common", // stocks and ETFs, swing trade
  DAY_TRADE: "day_trade",
  REIT: "reit", // fundos imobiliários
} as const;
export type Bucket = (typeof Bucket)[keyof typeof Bucket];

export const BUCKET_LABELS: Readonly<Record<Bucket, string>> = {
  common: "Operações comuns (ações e ETF)",
  day_trade: "Day trade",
  reit: "Fundos imobiliários",
};

export const BucketRuleSchema = z.strictObject({
  bucket: zEnumOf(Bucket),
  rate: zDec.nullable().default(null),
  exempt_sales_limit: zDec.nullable().default(null), // monthly stock sales up to this are exempt (stocks only)
});
export type BucketRule = Readonly<z.output<typeof BucketRuleSchema>>;

export const VariableIncomeRulesSchema = z.strictObject({
  id: zEntityId,
  valid_from: zDate,
  rules: z.array(BucketRuleSchema).readonly().default([]),
  source: z.string().max(300).default("informado pelo usuário"),
});
export type VariableIncomeRules = Readonly<z.output<typeof VariableIncomeRulesSchema>>;

/** Python's `VariableIncomeRules.rule(bucket)`. */
export function ruleOf(rules: VariableIncomeRules, bucket: Bucket): BucketRule | null {
  return rules.rules.find((r) => r.bucket === bucket) ?? null;
}

// ── what was paid and what was received ──────────

export const PaymentPurpose = { VARIABLE_INCOME: "variable_income", CARNE_LEAO: "carne_leao" } as const;
export type PaymentPurpose = (typeof PaymentPurpose)[keyof typeof PaymentPurpose];

export const PURPOSE_LABELS: Readonly<Record<PaymentPurpose, string>> = {
  variable_income: "DARF de renda variável",
  carne_leao: "DARF do Carnê-Leão",
};

export const TaxPaymentSchema = z.strictObject({
  id: zEntityId,
  purpose: zEnumOf(PaymentPurpose),
  month: zYearMonth, // the month the tax refers to (apuração)
  amount: zDec,
  paid_on: zDate,
  operation_id: zId.nullable().default(null),
  member_id: zId.nullable().default(null),
});
export type TaxPayment = Readonly<z.output<typeof TaxPaymentSchema>>;

export const ChecklistMarkSchema = z.strictObject({
  id: zEntityId,
  year: YEAR(),
  key: z.string().min(1).max(200),
  received: z.boolean().default(true),
  note: z.string().max(300).nullable().default(null),
});
export type ChecklistMark = Readonly<z.output<typeof ChecklistMarkSchema>>;

export const KINDS = {
  tax_identity: TaxIdentitySchema,
  member_tax_info: MemberTaxInfoSchema,
  income_classification: IncomeClassificationSchema,
  income_detail: IncomeDetailSchema,
  asset_filing: AssetFilingSchema,
  declared_asset: DeclaredAssetSchema,
  income_report: IncomeReportSchema,
  tax_parameters: TaxParametersSchema,
  variable_income_rules: VariableIncomeRulesSchema,
  tax_payment: TaxPaymentSchema,
  tax_checklist_mark: ChecklistMarkSchema,
} as const;
for (const [kind, schema] of Object.entries(KINDS)) Ledger.registerKind(kind, schema);

export function collection<T>(ledger: Ledger, kind: string) {
  return ledger.entities<T>(kind);
}

export function requireYear(year: number): void {
  if (!(year >= 1990 && year <= 2999)) throw new DomainError("Ano inválido.");
}
