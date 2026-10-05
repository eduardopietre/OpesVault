/**
 * Parity with scripts/golden/cases_notes.py: brokerage notes imported from synthetic PDFs and
 * approved into the portfolio. Steps are replayed on the TS pipeline; after each one the outcome
 * and a snapshot of names and numbers (balances, operations, positions, events, items) must equal
 * the desktop's, including the state left behind by an approval that fails half way.
 */
import { describe, expect, it } from "vitest";

import { DomainError } from "../src/domain/ledger.ts";
import { AccountSubtype, AccountType, dump, LedgerAccountSchema } from "../src/domain/model.ts";
import * as queries from "../src/domain/queries.ts";
import { type IsoDate } from "../src/lib/dates.ts";
import type { Id } from "../src/lib/ids.ts";
import * as pipeline from "../src/importing/pipeline.ts";
import { approveNote, guessClass } from "../src/investments/notes.ts";
import { assets, createPosition, eventsOf, positions } from "../src/investments/service.ts";
import { type AssetClass, TrackingMode } from "../src/investments/model.ts";
import { averagePrice, holding, lotsOf, openingLot } from "../src/investments/trades.ts";
import { Session } from "../src/session.ts";
import { golden, j } from "./golden.ts";
import { bytesOf, extractor, headerJson } from "./importing_helpers.ts";
import { norm } from "./w5_golden.ts";

type Step = Record<string, unknown> & { op: string };
interface Scenario {
  name: string;
  steps: Step[];
  results: { outcome: { ok?: unknown; error?: string; message?: string }; snapshot: unknown }[];
}
const data = golden<{
  scenarios: Scenario[];
  guess_class: { spec: string; ticker: string | null; class: string }[];
}>("notes");

const NONE: ReadonlySet<string> = new Set();
const s = (v: unknown) => v as string;

function byName(session: Session, name: string): Id {
  return [...session.ledger.accounts.values()].find((a) => a.name === name)!.id;
}

function positionNamed(session: Session, name: string): Id {
  const known = assets(session.ledger);
  return [...positions(session.ledger).values()].find((p) => known.get(p.asset_id)!.name === name)!.id;
}

function batchAt(session: Session, index: number) {
  return [...pipeline.batches(session.ledger).values()][index]!;
}

async function runStep(session: Session, step: Step): Promise<unknown> {
  const ledger = session.ledger;
  switch (step.op) {
    case "account":
      ledger.addAccount(
        LedgerAccountSchema.parse({ name: step["name"], type: AccountType.ASSET, subtype: step["subtype"] }),
      );
      return null;
    case "opening":
      ledger.recordOpeningBalance(byName(session, s(step["account"])), step["amount"], step["on"] as IsoDate);
      return null;
    case "position":
      createPosition(ledger, s(step["name"]), step["class"] as AssetClass, step["on"] as IsoDate, {
        mode: TrackingMode.QUANTITY,
        ticker: (step["ticker"] as string | null | undefined) ?? null,
      });
      return null;
    case "lot":
      openingLot(ledger, positionNamed(session, s(step["position"])), step["on"] as IsoDate, step["qty"], step["cost"]);
      return null;
    case "import": {
      const account = step["account"] as string | null;
      const batch = await pipeline.importDocument(
        session,
        {
          name: s(step["name"]),
          data: bytesOf(s(step["pdf"])),
          parser_id: null,
          account_id: account ? byName(session, account) : null,
          card_id: null,
        },
        extractor,
      );
      return [...pipeline.batches(ledger).keys()].indexOf(batch.id);
    }
    case "set_target":
      pipeline.setBatchTarget(
        ledger,
        batchAt(session, step["batch"] as number).id,
        byName(session, s(step["account"])),
        null,
      );
      return null;
    case "approve": {
      const batch = batchAt(session, step["batch"] as number);
      const items = pipeline.itemsOf(ledger, batch.id);
      const ids = step["items"] == null ? null : (step["items"] as number[]).map((i) => items[i]!.id);
      const r = pipeline.approve(ledger, batch.id, ids, {
        partialReason: (step["partial"] as string | undefined) ?? null,
      });
      return [r.created, r.linked, r.skipped];
    }
    case "direct": {
      const batch = batchAt(session, step["batch"] as number);
      const items = pipeline.itemsOf(ledger, batch.id);
      const chosen = step["items"] != null ? (step["items"] as number[]).map((i) => items[i]!) : items;
      const r = approveNote(ledger, batch, chosen);
      return [r.created, r.linked, r.skipped];
    }
  }
  throw new Error(step.op);
}

function snapshot(session: Session): unknown {
  const ledger = session.ledger;
  const names = new Map([...ledger.accounts.values()].map((a) => [a.id, a.name]));
  const known = assets(ledger);
  return {
    balances: [...ledger.accounts.values()].map((a) => [a.name, j(queries.balance(ledger, a.id))]),
    operations: [...ledger.operations.values()].map((op) => ({
      kind: op.kind,
      description: op.description,
      occurred_on: op.occurred_on,
      settled_on: op.settled_on,
      notes: op.notes,
      postings: op.postings.map((p) => [names.get(p.account_id), j(p.amount)]),
      status: op.status,
    })),
    positions: [...positions(ledger).values()].map((pos) => {
      const asset = known.get(pos.asset_id)!;
      const h = holding(ledger, pos.id);
      return {
        name: asset.name,
        ticker: asset.ticker,
        class: asset.asset_class,
        mode: pos.mode,
        closed: pos.closed,
        opened_on: pos.opened_on,
        holder: pos.holder_id !== null,
        quantity: j(h.quantity),
        cost: j(h.cost),
        average_price: j(averagePrice(h)),
        events: eventsOf(ledger, pos.id).map((e) => norm(dump(e), NONE)),
        lots: lotsOf(ledger, pos.id).map((lot) => norm(dump(lot), NONE)),
      };
    }),
    batches: [...pipeline.batches(ledger).values()].map((batch) => ({
      status: batch.status,
      account: batch.account_id ? (names.get(batch.account_id) ?? null) : null,
      header: norm(headerJson(batch.header), NONE),
      warnings: [...batch.warnings],
      items: pipeline.itemsOf(ledger, batch.id).map((i) => ({
        kind: i.kind,
        description: i.description,
        amount: j(i.amount),
        quantity: j(i.quantity),
        unit_price: j(i.unit_price),
        ticker: i.ticker,
        credit: i.credit,
        status: i.status,
        operation: i.operation_id !== null,
        warnings: [...i.warnings],
      })),
    })),
    history: [...ledger.history].filter((h) => h.action === "approve_import").map((h) => [h.action, h.reason]),
  };
}

describe("brokerage notes replayed from the desktop", () => {
  for (const scenario of data.scenarios) {
    it(scenario.name, async () => {
      const session = Session.new("Teste");
      for (const [n, step] of scenario.steps.entries()) {
        const expected = scenario.results[n]!;
        const label = `${scenario.name} step ${n} (${step.op})`;
        try {
          const result = await runStep(session, step);
          expect(expected.outcome, label).toEqual({ ok: result });
        } catch (error) {
          if (expected.outcome.error === undefined) throw error;
          expect((error as Error).name, label).toBe(expected.outcome.error);
          if (error instanceof DomainError) expect((error as Error).message, label).toBe(expected.outcome.message);
        }
        expect(snapshot(session), label).toEqual(expected.snapshot);
      }
    });
  }

  it("guesses the asset class from the specification", () => {
    for (const c of data.guess_class) expect(guessClass(c.spec, c.ticker), `${c.spec}/${c.ticker}`).toBe(c.class);
  });
});
