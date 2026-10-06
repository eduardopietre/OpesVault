import { dom, makeDate, ym, type IsoDate } from "@opesvault/domain";
import { describe, expect, it } from "vitest";
import { alertLink, encodeRef, eventLink, filterRef, refParts } from "../../src/data/links.ts";
import { PAGES } from "../../src/pages.tsx";

const { Severity, Target } = dom.alerts;
const day = (d: number): IsoDate => makeDate(2026, 10, d);

function alert(severity: dom.alerts.Severity, target: dom.alerts.Target, ref: unknown): dom.alerts.Alert {
  return { severity, title: "t", detail: "d", target, dueOn: null, ref };
}

describe("the ref and act that the notices send (the contract of the target screens)", () => {
  it("encodes the domain's references as text the URL can carry", () => {
    expect(encodeRef(null)).toBeUndefined();
    expect(encodeRef("batch-1")).toBe("batch-1");
    expect(encodeRef(["card-1", ym(2026, 10)])).toBe("card-1:2026-10");
    expect(encodeRef(["rule-1", day(10)])).toBe("rule-1:2026-10-10");
    expect(encodeRef(["loan", "plan-1", 9])).toBe("loan:plan-1:9");
    expect(encodeRef(["filter", "acc", [day(3), day(6)]])).toBe("filter:acc:2026-10-03..2026-10-06");
    expect(encodeRef(["filter", "acc", ym(2026, 10), null])).toBe("filter:acc:2026-10");
    expect(encodeRef(["filter", "acc", ym(2026, 10), "m1"])).toBe("filter:acc:2026-10:m1");
    expect(filterRef("acc", ym(2026, 10), "m1")).toBe("filter:acc:2026-10:m1");
    expect(refParts("filter:acc:2026-10")).toEqual(["filter", "acc", "2026-10"]);
    expect(refParts(undefined)).toEqual([]);
  });

  it("sends each kind of notice to its page, with the action when one command resolves it", () => {
    const cases: [dom.alerts.Alert, string, string | undefined, string | undefined, string][] = [
      [alert(Severity.URGENT, Target.ACCOUNTS, ["card-1", ym(2026, 9)]), "contas", "card-1:2026-09", "pagar", "Pagar…"],
      [alert(Severity.SOON, Target.ACCOUNTS, ["loan", "plan-1", 9]), "contas", "loan:plan-1:9", "pagar", "Pagar…"],
      [alert(Severity.INFO, Target.ACCOUNTS, ["check", "acc-1"]), "contas", "check:acc-1", undefined, "Ver conta"],
      [
        alert(Severity.URGENT, Target.RECURRENCES, ["rule-1", day(1)]),
        "recorrencias",
        "rule-1:2026-10-01",
        "vincular",
        "Vincular…",
      ],
      [
        alert(Severity.SOON, Target.RECURRENCES, ["rule-1", day(10)]),
        "recorrencias",
        "rule-1:2026-10-10",
        undefined,
        "Ver previsão",
      ],
      [
        alert(Severity.INFO, Target.RECURRENCES, ["rule", "rule-1"]),
        "recorrencias",
        "rule:rule-1",
        undefined,
        "Ver previsão",
      ],
      [alert(Severity.INFO, Target.IMPORT, "batch-1"), "importar", "batch-1", undefined, "Revisar"],
      [
        alert(Severity.URGENT, Target.BUDGET, ["cat-1", ym(2026, 10)]),
        "orcamento",
        "cat-1:2026-10",
        undefined,
        "Ver no orçamento",
      ],
      [
        alert(Severity.SOON, Target.REPORTS, "projected_balance"),
        "relatorios",
        "projected_balance",
        undefined,
        "Ver projeção",
      ],
      [
        alert(Severity.INFO, Target.LEDGER, ["filter", "acc", [day(3), day(6)]]),
        "livro",
        "filter:acc:2026-10-03..2026-10-06",
        undefined,
        "Ver lançamentos",
      ],
      [alert(Severity.INFO, Target.SETTINGS, null), "configuracoes", undefined, undefined, "Abrir Configurações"],
      [
        alert(Severity.URGENT, Target.TAX, ["variable_income", ym(2026, 9)]),
        "imposto",
        "variable_income:2026-09",
        "darf",
        "Registrar DARF…",
      ],
      [
        alert(Severity.SOON, Target.TAX, ["carne_leao", ym(2026, 9), "m1"]),
        "imposto",
        "carne_leao:2026-09:m1",
        "darf",
        "Registrar DARF…",
      ],
      [alert(Severity.INFO, Target.TAX, ["year", 2025]), "imposto", "year:2025", undefined, "Ver pendências"],
      [alert(Severity.SOON, Target.INVESTMENTS, "pos-1"), "investimentos", "pos-1", undefined, "Ver investimento"],
    ];
    for (const [input, page, ref, act, label] of cases) {
      const link = alertLink(input);
      expect(link, `${input.target} ${JSON.stringify(input.ref)}`).toEqual({
        page,
        ...(ref ? { ref } : {}),
        ...(act ? { act } : {}),
        label,
      });
      expect(PAGES.some((p) => p.id === link.page)).toBe(true);
    }
  });

  it("sends each kind of calendar entry to its page: pending bills ready to pay, late recurrences ready to link", () => {
    const { EventState } = dom.agenda;
    const event = (target: string, state: dom.agenda.EventState, ref: unknown) =>
      ({ on: day(1), title: "t", amount: undefined as never, kind: "x", state, target, ref }) as dom.agenda.AgendaEvent;
    expect(eventLink(event("accounts", EventState.PENDING, ["card-1", ym(2026, 10)]))).toEqual({
      page: "contas",
      ref: "card-1:2026-10",
      act: "pagar",
      label: "Pagar…",
    });
    expect(eventLink(event("accounts", EventState.DONE, ["card-1", ym(2026, 9)]))).toEqual({
      page: "contas",
      ref: "card-1:2026-09",
      label: "Abrir",
    });
    expect(eventLink(event("recurrences", EventState.LATE, ["rule-1", day(1)])).act).toBe("vincular");
    expect(eventLink(event("recurrences", EventState.PENDING, ["rule-1", day(1)])).act).toBeUndefined();
    expect(eventLink(event("investments", EventState.PENDING, "pos-1"))).toEqual({
      page: "investimentos",
      ref: "pos-1",
      label: "Abrir",
    });
  });
});
