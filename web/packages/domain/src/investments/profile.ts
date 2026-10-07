/**
 * What an investment is: its IRPF type, where it is held, issuer, yield, maturity, liquidity and tax.
 * Port of `investments/profile.py`.
 *
 * Characteristics are kept beside the position (they never change cost, value or flows). The type
 * comes from the IRPF Bens e Direitos table and the tax treatment names how the income is declared;
 * neither carries a rate (docs/00 §5). The value over time stays in the valuations.
 */
import { z } from "zod";

import { EXCLUSIVE_CODES, EXEMPT_CODES, isAssetCode } from "../catalogs/irpf.ts";
import { bankAccounts, where } from "../domain/banking.ts";
import { DomainError, Ledger } from "../domain/ledger.ts";
import { zEntityId } from "../domain/model.ts";
import { formatDecimalBr } from "../domain/money.ts";
import { formatDateBr } from "../lib/dates.ts";
import { indexBy } from "../lib/collections.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { zDate, zDec, zId } from "../lib/schema.ts";
import { display, isCnpj } from "../tax/ids.ts";
import { AssetClass } from "./model.ts";
import { getOrKeyError, pyEquals, pyHead } from "../lib/py.ts";
import { assets, positions } from "./service.ts";

function values<T extends Record<string, string>>(o: T): [T[keyof T], ...T[keyof T][]] {
  return Object.values(o) as [T[keyof T], ...T[keyof T][]];
}

export const Indexer = {
  FIXED: "fixed", // prefixado
  CDI: "cdi",
  SELIC: "selic",
  IPCA: "ipca",
  IGPM: "igpm",
  SAVINGS: "savings", // rendimento da poupança
  VARIABLE: "variable", // renda variável, sem indexador
  OTHER: "other",
} as const;
export type Indexer = (typeof Indexer)[keyof typeof Indexer];

export const INDEXER_LABELS: Readonly<Record<Indexer, string>> = {
  fixed: "Prefixado",
  cdi: "CDI",
  selic: "Selic",
  ipca: "IPCA",
  igpm: "IGP-M",
  savings: "Rendimento da poupança",
  variable: "Renda variável (sem indexador)",
  other: "Outro",
};

export const Liquidity = {
  DAILY: "daily",
  AT_MATURITY: "at_maturity",
  DAYS: "days", // D+N
  NONE: "none", // sem resgate antecipado (só na bolsa, venda)
} as const;
export type Liquidity = (typeof Liquidity)[keyof typeof Liquidity];

export const LIQUIDITY_LABELS: Readonly<Record<Liquidity, string>> = {
  daily: "Diária",
  at_maturity: "No vencimento",
  days: "Em dias (D+N)",
  none: "Só por venda no mercado",
};

export const TaxTreatment = {
  EXEMPT: "exempt", // isento (poupança, LCI/LCA, dividendos)
  WITHHELD: "withheld", // tributação exclusiva na fonte no resgate (CDB, Tesouro)
  COME_COTAS: "come_cotas", // fundos com tributação periódica
  VARIABLE: "variable", // renda variável: apuração mensal (ações, FII, ETF)
  PENSION: "pension", // previdência (PGBL/VGBL)
  OTHER: "other",
} as const;
export type TaxTreatment = (typeof TaxTreatment)[keyof typeof TaxTreatment];

export const TAX_LABELS: Readonly<Record<TaxTreatment, string>> = {
  exempt: "Isento de IR",
  withheld: "Retido na fonte no resgate (tributação exclusiva)",
  come_cotas: "Come-cotas e retenção no resgate",
  variable: "Renda variável: apuração mensal pelo investidor",
  pension: "Previdência privada",
  other: "Outro",
};

export const InvestmentProfileSchema = z.strictObject({
  id: zEntityId,
  position_id: zId,
  bank_account_id: zId.nullable().default(null), // where it is held (domain/banking)
  irpf_group: z
    .string()
    .regex(/^\d{2}$/)
    .nullable()
    .default(null),
  irpf_code: z
    .string()
    .regex(/^\d{2}$/)
    .nullable()
    .default(null),
  issuer: z.string().max(120).nullable().default(null),
  issuer_tax_id: z
    .string()
    .regex(/^\d{14}$/)
    .nullable()
    .default(null),
  indexer: z.enum(values(Indexer)).nullable().default(null),
  rate: zDec.nullable().default(null), // percent: 110 (% do CDI), 6.5 (IPCA + 6,5%), 12.4 (prefixado)
  applied_on: zDate.nullable().default(null),
  maturity: zDate.nullable().default(null),
  liquidity: z.enum(values(Liquidity)).nullable().default(null),
  liquidity_days: z.number().int().min(0).max(3650).nullable().default(null),
  tax: z.enum(values(TaxTreatment)).nullable().default(null),
  income_code: z
    .string()
    .regex(/^(isento|exclusivo):\d{2}$/)
    .nullable()
    .default(null),
  fgc: z.boolean().nullable().default(null), // covered by the Fundo Garantidor de Créditos
  notes: z.string().max(500).nullable().default(null),
});
export type InvestmentProfile = Readonly<z.output<typeof InvestmentProfileSchema>>;

Ledger.registerKind("investment_profile", InvestmentProfileSchema);

export function profiles(ledger: Ledger) {
  return ledger.entities<InvestmentProfile>("investment_profile");
}

export function profileOf(ledger: Ledger, positionId: Id): InvestmentProfile | null {
  const byPosition = ledger.cachedFor("investments.profileOf", ["investment_profile"], () =>
    indexBy(profiles(ledger).values(), (p) => p.position_id),
  );
  return byPosition.get(positionId) ?? null;
}

export function saveProfile(ledger: Ledger, profile: InvestmentProfile): InvestmentProfile {
  if (!positions(ledger).has(profile.position_id)) throw new DomainError("Investimento inexistente.");
  if (
    (profile.irpf_group === null) !== (profile.irpf_code === null) ||
    (profile.irpf_group !== null && !isAssetCode(profile.irpf_group, profile.irpf_code ?? ""))
  ) {
    throw new DomainError("Escolha o tipo na tabela de Bens e Direitos do IRPF.");
  }
  if (profile.income_code !== null) {
    const [table, code] = profile.income_code.split(":") as [string, string];
    if (!(table === "isento" ? EXEMPT_CODES : EXCLUSIVE_CODES).has(code)) {
      throw new DomainError("Escolha o código do rendimento na lista do IRPF.");
    }
  }
  if (profile.bank_account_id !== null && !bankAccounts(ledger).has(profile.bank_account_id)) {
    throw new DomainError("Escolha a conta bancária onde o investimento está.");
  }
  if (profile.rate !== null && !(Dec.from("-100").lt(profile.rate) && profile.rate.lt(Dec.from("10000")))) {
    throw new DomainError("Taxa fora do esperado: use o percentual, como 110 ou 6,5.");
  }
  if (profile.maturity && profile.applied_on && profile.maturity < profile.applied_on) {
    throw new DomainError("O vencimento não pode ser antes da aplicação.");
  }
  if (profile.issuer_tax_id !== null && !isCnpj(profile.issuer_tax_id)) {
    throw new DomainError("CNPJ do emissor inválido: confira os dígitos.");
  }
  const current = profileOf(ledger, profile.position_id);
  if (current === null) return ledger.put("investment_profile", profile);
  const updated: InvestmentProfile = { ...profile, id: current.id };
  return pyEquals(updated, current)
    ? current
    : ledger.put("investment_profile", updated, { reason: "características alteradas" });
}

/** The app's asset class for an IRPF type (the class drives renda variável and lots). */
export function classFor(group: string, code: string): AssetClass {
  if (group === "03") return AssetClass.STOCK;
  if (group === "07") {
    const byCode: Record<string, AssetClass> = {
      "03": AssetClass.REIT,
      "02": AssetClass.REIT,
      "08": AssetClass.ETF,
      "09": AssetClass.ETF,
    };
    return Object.hasOwn(byCode, code) ? byCode[code]! : AssetClass.FUND;
  }
  if (group === "08") return AssetClass.CRYPTO;
  if (group === "99" && code === "06") return AssetClass.PENSION;
  if (group === "04" && (code === "02" || code === "03")) return AssetClass.FIXED_INCOME;
  return AssetClass.OTHER;
}

const TAX_BY_CODE = new Map<string, TaxTreatment>([
  ["04|02", TaxTreatment.WITHHELD],
  ["04|03", TaxTreatment.EXEMPT],
  ["07|01", TaxTreatment.COME_COTAS],
  ["07|03", TaxTreatment.VARIABLE],
  ["07|09", TaxTreatment.VARIABLE],
  ["03|01", TaxTreatment.VARIABLE],
  ["99|06", TaxTreatment.PENSION],
]);

/** A starting point for the tax treatment, shown as a suggestion in the form. Port of `tax_for`. */
export function taxFor(group: string, code: string): TaxTreatment | null {
  return TAX_BY_CODE.get(`${group}|${code}`) ?? null;
}

/** '110% do CDI', 'IPCA + 6,5% a.a.', '12,4% a.a.' or '—'. */
export function yieldText(profile: InvestmentProfile | null): string {
  if (profile === null || profile.indexer === null) return "—";
  const label = INDEXER_LABELS[profile.indexer];
  if (profile.rate === null) return label;
  const rate = formatDecimalBr(profile.rate);
  if (profile.indexer === Indexer.CDI || profile.indexer === Indexer.SELIC) return `${rate}% do ${label}`;
  if (profile.indexer === Indexer.IPCA || profile.indexer === Indexer.IGPM) return `${label} + ${rate}% a.a.`;
  if (profile.indexer === Indexer.FIXED) return `${rate}% a.a.`;
  return `${label} (${rate}%)`;
}

export function incomeCodeLabel(code: string | null): string {
  if (!code) return "—";
  const [table, number] = code.split(":") as [string, string];
  const names = table === "isento" ? EXEMPT_CODES : EXCLUSIVE_CODES;
  const kind = table === "isento" ? "Isentos" : "Tributação exclusiva";
  return `${kind} ${number} — ${names.get(number) ?? "?"}`;
}

/** Discriminação for Bens e Direitos, built from the characteristics (null without a profile). */
export function description(ledger: Ledger, positionId: Id): string | null {
  const profile = profileOf(ledger, positionId);
  if (profile === null) return null;
  const pos = getOrKeyError(positions(ledger), positionId);
  const parts = [getOrKeyError(assets(ledger), pos.asset_id).name];
  if (profile.issuer) {
    parts.push(
      `emitido por ${profile.issuer}` + (profile.issuer_tax_id ? `, CNPJ ${display(profile.issuer_tax_id)}` : ""),
    );
  }
  if (profile.indexer !== null) parts.push(yieldText(profile));
  if (profile.applied_on) parts.push(`aplicado em ${formatDateBr(profile.applied_on)}`);
  if (profile.maturity) parts.push(`vencimento em ${formatDateBr(profile.maturity)}`);
  const bank = profile.bank_account_id ? bankAccounts(ledger).get(profile.bank_account_id) : undefined;
  if (bank !== undefined) parts.push(`custodiado em ${where(bank)}`);
  return pyHead(parts.join("; "), 512);
}
