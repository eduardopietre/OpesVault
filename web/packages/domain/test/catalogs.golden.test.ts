/** Parity with scripts/golden/cases_catalogs.py: embedded lists, CPF/CNPJ and the profile labels. */
import { describe, expect, it } from "vitest";

import { bank, bankLabel, banks, search } from "../src/catalogs/catalogs.ts";
import { ASSET_CODES, assetLabel, EXCLUSIVE_CODES, EXEMPT_CODES, isAssetCode } from "../src/catalogs/irpf.ts";
import { Dec } from "../src/lib/dec.ts";
import * as prof from "../src/investments/profile.ts";
import * as ids from "../src/tax/ids.ts";
import { golden, outcome } from "./golden.ts";

interface IdCase {
  text: string;
  [key: string]: unknown;
}

interface File {
  banks: string[][];
  lookups: [string | null, string | null][];
  searches: [string, string[], string[]][];
  asset_codes: [string, string, [string, string][]][];
  exempt_codes: [string, string][];
  exclusive_codes: [string, string][];
  labels: [string | null, string | null, string, boolean][];
  classes: [string, string, string, string | null][];
  yields: [string | null, string | null, string][];
  income_labels: [string | null, string][];
  ids: IdCase[];
}

const data = golden<File>("catalogs");

/** Python's outcome() of a DomainError is the type name; other errors too. */
function domainOutcome(fn: () => unknown) {
  return outcome(fn);
}

describe("catalogs golden", () => {
  it("bank list, lookups and searches", () => {
    expect(banks().map((b) => [b.code, b.ispb, b.cnpj, b.short_name, b.name, bankLabel(b)])).toEqual(data.banks);
    for (const [code, expected] of data.lookups) expect(bank(code)?.code ?? null, String(code)).toBe(expected);
    for (const [query, all, three] of data.searches) {
      expect(
        search(query).map((b) => b.code),
        query,
      ).toEqual(all);
      expect(search(query, 3).map((b) => b.code)).toEqual(three);
    }
  });

  it("IRPF tables and labels", () => {
    expect([...ASSET_CODES].map(([g, [name, codes]]) => [g, name, [...codes]])).toEqual(data.asset_codes);
    expect([...EXEMPT_CODES]).toEqual(data.exempt_codes);
    expect([...EXCLUSIVE_CODES]).toEqual(data.exclusive_codes);
    for (const [group, code, label, valid] of data.labels) {
      expect([assetLabel(group, code), isAssetCode(group ?? "", code ?? "")]).toEqual([label, valid]);
    }
  });

  it("profile helpers", () => {
    for (const [group, code, cls, treatment] of data.classes) {
      expect([prof.classFor(group, code), prof.taxFor(group, code)], `${group}.${code}`).toEqual([cls, treatment]);
    }
    for (const [indexer, rate, text] of data.yields) {
      const profile = prof.InvestmentProfileSchema.parse({
        position_id: "6b3d6a0e-0000-4000-8000-0000000000aa",
        indexer,
        rate: rate === null ? null : Dec.from(rate),
      });
      expect(prof.yieldText(profile)).toBe(text);
    }
    for (const [code, label] of data.income_labels) expect(prof.incomeCodeLabel(code)).toBe(label);
  });

  it("CPF and CNPJ", () => {
    for (const c of data.ids) {
      expect(
        {
          text: c.text,
          digits: ids.digits(c.text),
          is_cpf: ids.isCpf(c.text),
          is_cnpj: ids.isCnpj(c.text),
          kind: ids.kindOf(c.text),
          normalize: domainOutcome(() => ids.normalize(c.text)),
          normalize_cpf: domainOutcome(() => ids.normalize(c.text, [ids.TaxIdKind.CPF])),
          display: ids.display(c.text),
          find_cnpj: ids.findCnpj(c.text),
        },
        c.text,
      ).toEqual(c);
    }
  });
});
