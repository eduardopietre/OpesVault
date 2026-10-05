/**
 * What needs attention on opening a project. Port of `tests/test_alerts.py`.
 *
 * `test_budget_and_import_alerts` imports a synthetic Nubank PDF through the pipeline and a
 * `Session`; here the import batch and its pending item are written directly, because the pipeline
 * is another area's port (TODO(W6-integration): run it through `importing/pipeline` once ported).
 */
import { describe, expect, it } from "vitest";

import * as alerts from "../src/domain/alerts.ts";
import * as budget from "../src/domain/budget.ts";
import { addRule, realize, RecurrenceRuleSchema } from "../src/domain/recurrence.ts";
import {
  BatchStatus,
  DocFormat,
  ExtractedItemSchema,
  ImportBatchSchema,
  ItemKind,
  ItemStatus,
} from "../src/importing/model.ts";
import type { Instant, IsoDate } from "../src/lib/dates.ts";
import { ymOf } from "../src/lib/dates.ts";
import { newId } from "../src/lib/ids.ts";
import { category, family } from "./fixtures.ts";

const d = (s: string) => s as IsoDate;
const TODAY = d("2026-03-08"); // card X closes on the 3rd and is due on the 10th
const { Severity, Target } = alerts;

describe("alerts", () => {
  it("card bill due soon, then paid", () => {
    const f = family();
    f.ledger.recordCardPurchase(f.card, f.groceries, "300.00", d("2026-02-20"), "Mercado");
    const found = alerts.cardAlerts(f.ledger, TODAY);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe(Severity.SOON);
    expect(found[0]!.detail).toContain("vence em 2 dias");
    expect(found[0]!.detail).toContain("R$ 300,00");
    const late = alerts.cardAlerts(f.ledger, d("2026-03-15"));
    expect(late[0]!.severity).toBe(Severity.URGENT);
    expect(late[0]!.title.startsWith("Fatura vencida")).toBe(true);
    f.ledger.recordCardPayment(f.card, f.bank, "300.00", d("2026-03-09"));
    expect(alerts.cardAlerts(f.ledger, d("2026-03-15"))).toEqual([]);
  });

  it("recurrences late and upcoming", () => {
    const f = family();
    const rent = addRule(
      f.ledger,
      RecurrenceRuleSchema.parse({
        description: "Aluguel",
        account_id: f.bank,
        counterpart_id: category(f.ledger, "Moradia"),
        amount: "2000",
        day: 12,
        start: "2026-01-01",
        window_days: 2,
      }),
    );
    const found = alerts.recurrenceAlerts(f.ledger, TODAY);
    expect(found.map((a) => a.severity)).toEqual([Severity.URGENT, Severity.SOON]); // February late, March soon
    expect(found[1]!.title).toBe("Conta a vencer: Aluguel");
    expect(found[1]!.detail).toContain("vence em 4 dias");
    const op = f.ledger.recordExpense(f.bank, category(f.ledger, "Moradia"), "2000.00", d("2026-02-12"), "Aluguel");
    realize(f.ledger, rent.id, d("2026-02-12"), op.id);
    expect(alerts.recurrenceAlerts(f.ledger, TODAY).map((a) => a.severity)).toEqual([Severity.SOON]);
  });

  it("budget and import alerts", () => {
    const f = family();
    const month = ymOf(TODAY);
    budget.setBudget(f.ledger, f.groceries, month, "100.00");
    f.ledger.recordExpense(f.bank, f.groceries, "120.00", d("2026-03-02"), "Feira");
    const batch = f.ledger.put(
      "import_batch",
      ImportBatchSchema.parse({
        document_id: newId(),
        parser_id: "nubank-fatura",
        parser_version: "1",
        doc_format: DocFormat.PDF,
        status: BatchStatus.IN_REVIEW,
        created_at: "2026-03-05T10:00:00Z" as Instant,
      }),
    );
    f.ledger.put(
      "extracted_item",
      ExtractedItemSchema.parse({
        batch_id: batch.id,
        kind: ItemKind.PURCHASE,
        occurred_on: "2026-03-04",
        description: "MERCADO",
        amount: "10.00",
        status: ItemStatus.READY,
      }),
    );
    const found = alerts.alerts(f.ledger, TODAY);
    expect(found[0]!.severity).toBe(Severity.URGENT);
    expect(found[0]!.target).toBe(Target.BUDGET);
    expect(found.some((a) => a.target === Target.IMPORT && a.title.includes("aguardando revisão"))).toBe(true);
    const order = { urgent: 0, soon: 1, info: 2 } as const;
    const levels = found.map((a) => order[a.severity]);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });

  it("a quiet project has no alerts", () => {
    expect(alerts.alerts(family().ledger, TODAY)).toEqual([]);
  });
});
