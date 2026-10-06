/**
 * `tests/test_domain_ledger.py::test_registry_loads_every_kind_in_a_fresh_process`, for the whole
 * port: in a fresh module graph, importing only `src/index.ts` registers every kind the desktop
 * has (golden/registry.json), every kind a TS module registers, and the closing guards.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { golden } from "./golden.ts";

interface Registry {
  expected_by_the_desktop_test: string[];
  kinds: string[];
  operation_guards: number;
  update_guards: number;
}
const desktop = golden<Registry>("registry");
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = `${dir}${name}`;
    return statSync(path).isDirectory() ? sources(`${path}/`) : path.endsWith(".ts") ? [path] : [];
  });
}

/** Every kind a module of the port registers: `registerKind("x", …)` and the tax `KINDS` table. */
function declaredKinds(): Set<string> {
  const found = new Set<string>();
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf-8");
    for (const m of text.matchAll(/registerKind\(\s*"([a-z_]+)"/g)) found.add(m[1]!);
  }
  const tax = readFileSync(`${SRC}tax/model.ts`, "utf-8");
  const table = /const KINDS[^{]*\{([\s\S]*?)\n\};/.exec(tax);
  for (const m of (table?.[1] ?? "").matchAll(/^\s+([a-z_]+):\s*\w+Schema,?$/gm)) found.add(m[1]!);
  return found;
}

describe("registry in a fresh module graph", () => {
  let mod: typeof import("../src/index.ts");
  beforeAll(async () => {
    vi.resetModules();
    mod = await import("../src/index.ts");
  });

  it("knows every kind the desktop expects", () => {
    const kinds = new Set(mod.Ledger.kinds().keys());
    expect(desktop.expected_by_the_desktop_test.filter((k) => !kinds.has(k))).toEqual([]);
  });

  it("knows every kind the desktop registers", () => {
    const kinds = new Set(mod.Ledger.kinds().keys());
    expect(desktop.kinds.filter((k) => !kinds.has(k))).toEqual([]);
  });

  it("knows every kind a TS module registers, through index.ts alone", () => {
    const kinds = new Set(mod.Ledger.kinds().keys());
    const declared = declaredKinds();
    expect(declared.size).toBeGreaterThan(30);
    expect([...declared].filter((k) => !kinds.has(k))).toEqual([]);
  });

  it("registers the closing guards", () => {
    const ledger = mod.Ledger.new("x");
    const bank = ledger.addAccount(
      mod.LedgerAccountSchema.parse({ name: "Banco", type: "asset", subtype: "checking" }),
    ).id;
    const food = ledger.categories("expense" as never).find((a) => a.name === "Alimentação")!.id;
    mod.dom.periods.closeMonth(ledger, mod.ym(2026, 1));
    expect(() => ledger.recordExpense(bank, food, "1.00", mod.makeDate(2026, 1, 2), "x")).toThrow(mod.DomainError);
  });

  it("opens a demo project in a fresh graph and keeps its kinds", async () => {
    const session = await mod.demoSession({ today: mod.makeDate(2026, 10, 5) });
    const kinds = new Set(mod.Ledger.kinds().keys());
    const used = new Set(session.ledger.toRecords().map((r) => r.kind));
    expect([...used].filter((k) => k !== "ledger.meta" && !kinds.has(k))).toEqual([]);
  });
});
