/**
 * What the income tax dialogs share (desktop `ui/tax_dialogs/fields.py`): rates typed as percentages, the
 * CPF/CNPJ field with its mask and its check digits, and the asset code choices of the IRPF table.
 *
 * A CPF or CNPJ is personal data: it only lives in the field the person types it in and in the project.
 * Nothing here logs it, puts it in a message or keeps it anywhere else.
 */
import { Dec, DomainError, catalogs, formatDecimalBr, tax } from "@opesvault/domain";
import { Combobox, TextField, type SelectOption } from "@opesvault/ui";
import { useMemo, type ReactNode } from "react";

// ── rates ────────────────────────────────────────

/** 0.075 becomes "7,5" as typed, not "7,500" (the stored fraction carries extra places). */
export function percentText(rate: Dec | null): string {
  return rate === null ? "" : formatDecimalBr(rate.mul(100).normalize());
}

// ── CPF and CNPJ ─────────────────────────────────

export type TaxIdKinds = "cpf" | "cnpj" | "any";

/** 000.000.000-00 as far as the digits go. */
function cpfMask(digits: string): string {
  let out = digits.slice(0, 3);
  if (digits.length > 3) out += "." + digits.slice(3, 6);
  if (digits.length > 6) out += "." + digits.slice(6, 9);
  if (digits.length > 9) out += "-" + digits.slice(9, 11);
  return out;
}

/** 00.000.000/0000-00 as far as the digits go. */
function cnpjMask(digits: string): string {
  let out = digits.slice(0, 2);
  if (digits.length > 2) out += "." + digits.slice(2, 5);
  if (digits.length > 5) out += "." + digits.slice(5, 8);
  if (digits.length > 8) out += "/" + digits.slice(8, 12);
  if (digits.length > 12) out += "-" + digits.slice(12, 14);
  return out;
}

/**
 * The text of a CPF or CNPJ field as the person types: only digits count and the punctuation is added.
 * With both kinds allowed, up to 11 digits read as a CPF and more as a CNPJ.
 */
export function maskTaxId(text: string, kinds: TaxIdKinds = "any"): string {
  const digits = tax.ids.digits(text);
  if (kinds === "cpf") return cpfMask(digits.slice(0, 11));
  if (kinds === "cnpj") return cnpjMask(digits.slice(0, 14));
  return digits.length <= 11 ? cpfMask(digits) : cnpjMask(digits.slice(0, 14));
}

const KIND_NAMES: Record<TaxIdKinds, string> = { cpf: "CPF", cnpj: "CNPJ", any: "CPF ou CNPJ" };

const ALLOWED: Record<TaxIdKinds, readonly tax.ids.TaxIdKind[]> = {
  cpf: [tax.ids.TaxIdKind.CPF],
  cnpj: [tax.ids.TaxIdKind.CNPJ],
  any: [tax.ids.TaxIdKind.CPF, tax.ids.TaxIdKind.CNPJ],
};

/** What the typed text lacks to be accepted, or null when it is a valid number (or still empty). */
export function taxIdProblem(text: string, kinds: TaxIdKinds): string | null {
  const digits = tax.ids.digits(text);
  if (!digits) return null;
  const complete = kinds === "cpf" ? 11 : kinds === "cnpj" ? 14 : digits.length > 11 ? 14 : 11;
  if (digits.length < complete) return null; // still typing
  const found = tax.ids.kindOf(digits);
  if (found === null || !ALLOWED[kinds].includes(found)) {
    return `${KIND_NAMES[kinds]} inválido: confira os dígitos.`;
  }
  return null;
}

/** Validates what was typed (an empty field is refused unless `optional`); returns only the digits. */
export function readTaxId(text: string, kinds: TaxIdKinds, optional = false): string | null {
  if (!text.trim()) {
    if (optional) return null;
    throw new DomainError(`${KIND_NAMES[kinds]} inválido: confira os dígitos.`);
  }
  return tax.ids.normalize(text, ALLOWED[kinds]);
}

export interface TaxIdFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  kinds?: TaxIdKinds;
  hint?: ReactNode;
  placeholder?: string;
  "data-autofocus"?: string;
}

/** A CPF/CNPJ field: the mask follows the typing and a complete number with a wrong digit says so at once. */
export function TaxIdField({ label, value, onChange, kinds = "any", hint, placeholder, ...rest }: TaxIdFieldProps) {
  const problem = taxIdProblem(value, kinds);
  return (
    <TextField
      label={label}
      value={value}
      onChange={(text) => onChange(maskTaxId(text, kinds))}
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      maxLength={18}
      placeholder={
        placeholder ??
        (kinds === "cpf"
          ? "000.000.000-00"
          : kinds === "cnpj"
            ? "00.000.000/0000-00"
            : "000.000.000-00 ou 00.000.000/0000-00")
      }
      error={problem}
      {...(hint ? { hint } : {})}
      className="tabular-nums"
      {...rest}
    />
  );
}

// ── the IRPF asset table ─────────────────────────

/** "GG.CC — description (group)" for every code of the Bens e Direitos table (or only of `groups`). */
export function assetCodeOptions(groups: readonly string[] | null = null): SelectOption[] {
  const out: SelectOption[] = [];
  for (const [group, [name, codes]] of catalogs.irpf.ASSET_CODES) {
    if (groups !== null && !groups.includes(group)) continue;
    for (const [code, description] of codes) {
      out.push({ id: `${group}.${code}`, label: `${group}.${code} — ${description} (${name})` });
    }
  }
  return out;
}

export function splitCode(id: string): [string, string] {
  const [group = "", code = ""] = id.split(".");
  return [group, code];
}

export interface AssetCodeFieldProps {
  value: string | null;
  onChange: (id: string) => void;
  groups?: readonly string[] | null;
  label?: string;
  error?: string | null;
}

/** The searchable choice of group and code (typing a code or a word narrows the list). */
export function AssetCodeField({
  value,
  onChange,
  groups = null,
  label = "Grupo e código do IRPF",
  error,
}: AssetCodeFieldProps) {
  const options = useMemo(() => assetCodeOptions(groups), [groups]);
  return (
    <Combobox
      label={label}
      options={options}
      value={value}
      onChange={onChange}
      placeholder="Escolha na tabela do IRPF…"
      error={error}
    />
  );
}
