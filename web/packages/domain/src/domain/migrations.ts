/**
 * Domain schema migrations (RNF-07, docs/04 §7). Port of `domain/migrations.py`.
 *
 * Each step takes the meta payload and all rows of version N and returns version N+1.
 * Migrations run in memory after a successful unlock; the migrated rows are synced like any
 * other change.
 */
import { DomainError, type LedgerRecord, SCHEMA_VERSION } from "./ledger.ts";

type Meta = Record<string, unknown>;
type Step = (meta: Meta, rows: LedgerRecord[]) => [Meta, LedgerRecord[]];

/** 1 → 2: every existing member becomes a holder (the only kind there was). */
function membersGetARole(meta: Meta, rows: LedgerRecord[]): [Meta, LedgerRecord[]] {
  return [
    meta,
    rows.map((r) =>
      r.kind === "member" ? { ...r, payload: { ...r.payload, role: r.payload["role"] ?? "holder" } } : r,
    ),
  ];
}

export const STEPS = new Map<number, Step>([[1, membersGetARole]]);

export function migrate(meta: Meta, rows: LedgerRecord[]): [Meta, LedgerRecord[]] {
  let version = Number(meta["schema_version"] ?? 0);
  if (version > SCHEMA_VERSION) throw new DomainError("Cofre criado por uma versão mais nova do OpesVault.");
  let m = meta;
  let r = rows;
  while (version < SCHEMA_VERSION) {
    const step = STEPS.get(version);
    if (step === undefined) throw new DomainError("Não há migração disponível para este cofre.");
    [m, r] = step(m, r);
    version += 1;
    m = { ...m, schema_version: version };
  }
  return [m, r];
}
