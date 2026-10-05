/**
 * Review flows (golden/import.json, scripts/golden/cases_import.py): the same steps replayed on
 * the TS pipeline give the same outcome and the same state after every step. Ids are random on
 * both sides, so states name accounts, items and operations instead of using ids.
 */
import { describe, expect, it } from "vitest";

import { DomainError, type Ledger } from "../src/domain/ledger.ts";
import { AccountSubtype, AccountType, CardSchema, LedgerAccountSchema, type Operation } from "../src/domain/model.ts";
import * as queries from "../src/domain/queries.ts";
import type { IsoDate } from "../src/lib/dates.ts";
import { Dec } from "../src/lib/dec.ts";
import type { Id } from "../src/lib/ids.ts";
import { type ImportBatch, StatementHeaderSchema } from "../src/importing/model.ts";
import * as pipeline from "../src/importing/pipeline.ts";
import { addRule, rules } from "../src/importing/rules.ts";
import { Session } from "../src/session.ts";
import { golden, j } from "./golden.ts";
import { bytesOf, extractor } from "./importing_helpers.ts";

type Step = Record<string, unknown> & { op: string };
interface Scenario {
  steps: Step[];
  results: { outcome: { ok?: unknown; error?: string; message?: string }; snapshot: unknown }[];
}

const { scenarios } = golden<{ scenarios: Record<string, Scenario> }>("import");

function newSession(): Session {
  const session = Session.new("Teste");
  const ledger = session.ledger;
  const ana = ledger.addMember("Ana").id;
  const add = (fields: Record<string, unknown>) => ledger.addAccount(LedgerAccountSchema.parse(fields));
  const bank = add({
    name: "Itaú CC",
    type: AccountType.ASSET,
    subtype: AccountSubtype.CHECKING,
    masked_number: "56789-0",
    holders: [ana],
  });
  add({ name: "Poupança", type: AccountType.ASSET, subtype: AccountSubtype.SAVINGS });
  const liability = add({ name: "Nubank", type: AccountType.LIABILITY, subtype: AccountSubtype.CREDIT_CARD });
  ledger.addCard(
    CardSchema.parse({
      name: "Nubank",
      liability_account_id: liability.id,
      holder_id: ana,
      last4: "0001",
      closing_day: 3,
      due_day: 10,
      settlement_account_id: bank.id,
    }),
  );
  return session;
}

// ── naming, as in cases_import.py ───────────────────

const accountName = (ledger: Ledger, id: Id | null) => (id === null ? null : ledger.accounts.get(id)!.name);
const accountId = (ledger: Ledger, name: unknown) =>
  name === null || name === undefined ? null : [...ledger.accounts.values()].find((a) => a.name === name)!.id;
const cardId = (ledger: Ledger, name: unknown) =>
  name ? ([...ledger.cards.values()].find((c) => c.name === name)?.id ?? null) : null;

function opLabel(ledger: Ledger, id: Id | null): string | null {
  if (id === null) return null;
  const op = ledger.operations.get(id)!;
  return `${op.description}|${op.occurred_on ?? "None"}|${[...ledger.operations.keys()].indexOf(id)}`;
}

function sourceLabel(ledger: Ledger, source: string | null): string | null {
  if (source !== null && source.startsWith("user_rule:"))
    return "user_rule:" + rules(ledger).get(source.slice("user_rule:".length))!.pattern;
  return source;
}

/** Python's round(v, 6) for the boxes (pdf.js and pdfplumber agree to ~1e-13 pt). */
const box = (bbox: readonly number[] | null) => (bbox === null ? null : bbox.map((v) => Math.round(v * 1e6) / 1e6));

function operationJson(ledger: Ledger, op: Operation): unknown {
  return {
    kind: op.kind,
    description: op.description,
    occurred_on: op.occurred_on,
    settled_on: op.settled_on,
    postings: op.postings.map((p) => [accountName(ledger, p.account_id), j(p.amount)]),
    notes: op.notes,
    origin: [op.origin.kind, op.origin.evidence_ids.length, op.origin.import_id !== null],
    card: op.card_id === null ? null : ledger.cards.get(op.card_id)!.name,
    status: op.status,
    version: op.version,
  };
}

function snapshot(session: Session): unknown {
  const ledger = session.ledger;
  const evidence = pipeline.evidence(ledger);
  const batches = [...pipeline.batches(ledger).values()].map((batch) => ({
    parser_id: batch.parser_id,
    parser_version: batch.parser_version,
    doc_format: batch.doc_format,
    doc_type: batch.doc_type,
    status: batch.status,
    account: accountName(ledger, batch.account_id),
    card: batch.card_id === null ? null : ledger.cards.get(batch.card_id)!.name,
    header: Object.fromEntries(
      Object.keys(StatementHeaderSchema.shape).map((k) => [k, j(batch.header[k as keyof typeof batch.header])]),
    ),
    reconciliations: batch.reconciliations.map((r) => [r.label, j(r.expected), j(r.computed), r.ok]),
    warnings: [...batch.warnings],
    candidates: [...batch.candidates],
    unmapped_lines: batch.unmapped_lines,
    partial_reason: batch.partial_reason,
    document: session.documents.filter((d) => d.meta.id === batch.document_id).map((d) => d.meta.original_name),
    items: pipeline.itemsOf(ledger, batch.id).map((item) => ({
      kind: item.kind,
      occurred_on: item.occurred_on,
      description: item.description,
      amount: j(item.amount),
      installment: item.installment ? [...item.installment] : null,
      card_last4: item.card_last4,
      bank_id: item.bank_id,
      foreign: [j(item.foreign_amount), item.foreign_currency],
      trade: [j(item.quantity), j(item.unit_price), item.ticker],
      credit: item.credit,
      status: item.status,
      warnings: [...item.warnings],
      target: accountName(ledger, item.target_account_id),
      member: item.member_id !== null,
      duplicate_of: opLabel(ledger, item.duplicate_of),
      operation: opLabel(ledger, item.operation_id),
      corrections: item.corrections.map((c) => [
        c.field,
        c.field !== "target_account_id" ? c.before : null,
        c.field !== "target_account_id" ? c.after : null,
        c.operator,
        c.reason,
      ]),
      suggestion_source: sourceLabel(ledger, item.suggestion_source),
      evidence: item.evidence_ids.map((e) => {
        const ev = evidence.get(e)!;
        return [ev.page, box(ev.bbox), ev.line, ev.text];
      }),
    })),
  }));
  return {
    batches,
    operations: [...ledger.operations.values()].map((op) => operationJson(ledger, op)),
    balances: Object.fromEntries([...ledger.accounts.values()].map((a) => [a.name, j(queries.balance(ledger, a.id))])),
    accounts: [...ledger.accounts.values()].map((a) => a.name),
    documents: session.documents.map((d) => d.meta.original_name),
    history: ledger.history.length,
    evidence: evidence.size,
  };
}

// ── steps ───────────────────────────────────────────

/** The fields steps carry (each step uses some of them). */
interface StepArgs {
  name: string;
  bytes: string;
  parser_id?: string | null;
  account?: string | null;
  card?: string | null;
  batch: number;
  items?: unknown[] | null;
  accept?: string | null;
  partial?: string | null;
  item: [number, number];
  field: string;
  value: unknown;
  reason: string;
  pattern: string;
  category: string;
  parser: string;
  amount: string;
  on: IsoDate;
  description: string;
}

class IndexError extends Error {
  override name = "IndexError";
}

function batchAt(session: Session, index: number): ImportBatch {
  const batch = [...pipeline.batches(session.ledger).values()][index];
  if (batch === undefined) throw new IndexError("list index out of range");
  return batch;
}

function itemAt(session: Session, ref: [number, number]) {
  const item = pipeline.itemsOf(session.ledger, batchAt(session, ref[0]).id)[ref[1]];
  if (item === undefined) throw new IndexError("list index out of range");
  return item;
}

function valueOf(session: Session, field: string, value: unknown): unknown {
  if (field === "target_account_id") return accountId(session.ledger, value);
  if (field === "amount" && value !== null) return Dec.parse(value as string);
  return value;
}

async function runStep(session: Session, step: Step): Promise<unknown> {
  const ledger = session.ledger;
  const s = step as unknown as StepArgs;
  switch (step.op) {
    case "import": {
      const batch = await pipeline.importDocument(
        session,
        {
          name: s["name"],
          data: bytesOf(s["bytes"]),
          parser_id: s["parser_id"] ?? null,
          account_id: accountId(ledger, s["account"]),
          card_id: cardId(ledger, s["card"]),
        },
        extractor,
      );
      return [...pipeline.batches(ledger).keys()].indexOf(batch.id);
    }
    case "approve": {
      const batch = batchAt(session, s["batch"]);
      const ids =
        s["items"] === undefined || s["items"] === null
          ? null
          : (s["items"] as number[]).map((i) => itemAt(session, [s["batch"], i]).id);
      const r = pipeline.approve(ledger, batch.id, ids, {
        acceptDivergence: s["accept"] ?? null,
        partialReason: s["partial"] ?? null,
      });
      return [r.created, r.linked, r.skipped];
    }
    case "correct":
      pipeline.correctItem(
        ledger,
        itemAt(session, s["item"]).id,
        s["field"],
        valueOf(session, s["field"], s["value"]),
        (s as { reason?: string | null }).reason ?? null,
      );
      return null;
    case "keep_separate":
      pipeline.keepSeparate(ledger, itemAt(session, s["item"]).id, s["reason"]);
      return null;
    case "reject":
      pipeline.rejectItems(
        ledger,
        (s["items"] as [number, number][]).map((ref) => itemAt(session, ref).id),
        s["reason"],
      );
      return null;
    case "set_target":
      pipeline.setBatchTarget(
        ledger,
        batchAt(session, s["batch"]).id,
        accountId(ledger, s["account"]),
        cardId(ledger, s["card"]),
      );
      return null;
    case "add_rule":
      addRule(ledger, s["pattern"], accountId(ledger, s["category"])!, accountId(ledger, s["account"]));
      return null;
    case "apply_rules":
      return pipeline.applyRules(
        ledger,
        s["batch"] === undefined || s["batch"] === null ? null : batchAt(session, s["batch"]).id,
      );
    case "reparse": {
      const batch = await pipeline.reparseWith(session, batchAt(session, s["batch"]).id, s["parser"], null, extractor);
      return [...pipeline.batches(ledger).keys()].indexOf(batch.id);
    }
    case "operator":
      ledger.operator = s["name"];
      return null;
    case "expense":
      ledger.recordExpense(
        accountId(ledger, s["account"])!,
        accountId(ledger, s["category"])!,
        s["amount"],
        s["on"],
        s["description"],
      );
      return null;
  }
  throw new Error(step.op);
}

describe("review flows replayed from the desktop", () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(name, async () => {
      const session = newSession();
      for (const [n, step] of scenario.steps.entries()) {
        const expected = scenario.results[n]!;
        const label = `${name} step ${n} (${step.op})`;
        try {
          const result = await runStep(session, step);
          expect(expected.outcome, label).toEqual({ ok: result });
        } catch (error) {
          if (expected.outcome.error === undefined) throw error;
          expect((error as Error).name, label).toBe(expected.outcome.error);
          if (error instanceof DomainError)
            expect((error as Error).message, label).toBe(expected.outcome.message);
        }
        if (expected.snapshot !== null) expect(snapshot(session), label).toEqual(expected.snapshot);
      }
    });
  }
});
