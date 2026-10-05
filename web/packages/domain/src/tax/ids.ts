/**
 * CPF and CNPJ: check digits, normalization and display. Port of `tax/ids.py`.
 *
 * A tax id is personal data: it lives only inside the vault, is shown only where the user
 * asked for it and never goes to logs or exception messages that could be recorded.
 */
import { DomainError } from "../domain/ledger.ts";

export const TaxIdKind = { CPF: "cpf", CNPJ: "cnpj" } as const;
export type TaxIdKind = (typeof TaxIdKind)[keyof typeof TaxIdKind];

export function digits(text: string | null | undefined): string {
  return (text || "").replace(/\D/g, "");
}

function check(numbers: string, weights: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += Number(numbers[i]) * weights[i]!;
  const rest = total % 11;
  return rest < 2 ? 0 : 11 - rest;
}

const range = (from: number, to: number) => Array.from({ length: from - to }, (_, i) => from - i);

export function isCpf(value: string): boolean {
  const n = digits(value);
  if (n.length !== 11 || n === n[0]!.repeat(11)) return false;
  const first = check(n.slice(0, 9), range(10, 1));
  const second = check(n.slice(0, 10), range(11, 1));
  return n.slice(9) === `${first}${second}`;
}

export function isCnpj(value: string): boolean {
  const n = digits(value);
  if (n.length !== 14 || n === n[0]!.repeat(14)) return false;
  const first = check(n.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = check(n.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return n.slice(12) === `${first}${second}`;
}

export function kindOf(value: string): TaxIdKind | null {
  const n = digits(value);
  if (n.length === 11 && isCpf(n)) return TaxIdKind.CPF;
  if (n.length === 14 && isCnpj(n)) return TaxIdKind.CNPJ;
  return null;
}

/** Only the digits of a valid CPF or CNPJ; a typo is refused, never stored. */
export function normalize(value: string, allowed: readonly TaxIdKind[] = [TaxIdKind.CPF, TaxIdKind.CNPJ]): string {
  const kind = kindOf(value);
  if (kind === null || !allowed.includes(kind)) {
    const names = allowed.map((k) => k.toUpperCase()).join(" ou ");
    throw new DomainError(`${names} inválido: confira os dígitos.`);
  }
  return digits(value);
}

/** 000.000.000-00 or 00.000.000/0000-00; anything else as stored. */
export function display(value: string | null | undefined): string {
  const n = digits(value || "");
  if (n.length === 11) return `${n.slice(0, 3)}.${n.slice(3, 6)}.${n.slice(6, 9)}-${n.slice(9)}`;
  if (n.length === 14) return `${n.slice(0, 2)}.${n.slice(2, 5)}.${n.slice(5, 8)}/${n.slice(8, 12)}-${n.slice(12)}`;
  return value || "";
}

export const CNPJ_IN_TEXT = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
export const CPF_IN_TEXT = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;

/** The first valid CNPJ written in a document line. */
export function findCnpj(text: string): string | null {
  for (const match of text.matchAll(CNPJ_IN_TEXT)) {
    if (isCnpj(match[0])) return digits(match[0]);
  }
  return null;
}
