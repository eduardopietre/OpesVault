/**
 * Incorporating approved brokerage notes into the portfolio (docs/05 §2, nota de negociação).
 * Port of `investments/notes.py`.
 *
 * Note costs are allocated to trades in proportion to their value (exactly, in cents): they raise
 * the cost of buys and reduce the proceeds of sells.
 */
import { DomainError, type Ledger } from "../domain/ledger.ts";
import { HistoryAction } from "../domain/model.ts";
import { allocate, ZERO } from "../domain/money.ts";
import type { IsoDate } from "../lib/dates.ts";
import type { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { type ApprovalResult, approvalResult, updateBatchStatus } from "../importing/approval.ts";
import { type ExtractedItem, type ImportBatch, ItemKind, ItemStatus } from "../importing/model.ts";
import { items as itemStore } from "../importing/store.ts";
import { AssetClass, type Position, TrackingMode } from "./model.ts";
import { assets, createPosition, positions } from "./service.ts";
import { buy, sell } from "./trades.ts";

/** Python's `IndexError` (`description.split(" ", 1)[1]` of a description without a space). */
export class IndexError extends Error {
  override name = "IndexError";
}

const WORD = "[\\p{L}\\p{N}_]";
const REIT = new RegExp(`(?<!${WORD})(?:FII|CI)(?!${WORD})`, "u");
const ETF = new RegExp(`(?<!${WORD})(?:ETF|CI\\s+ER)(?!${WORD})`, "u");

export function guessClass(spec: string, ticker: string | null): AssetClass {
  const upper = spec.toUpperCase();
  if (REIT.test(upper)) return AssetClass.REIT;
  if (ETF.test(upper)) return AssetClass.ETF;
  return ticker ? AssetClass.STOCK : AssetClass.OTHER;
}

/** `description.split(" ", 1)[1]`: the text after the first space. */
function afterFirstSpace(description: string): string {
  const at = description.indexOf(" ");
  if (at < 0) throw new IndexError("list index out of range");
  return description.slice(at + 1);
}

function positionFor(
  ledger: Ledger,
  ticker: string | null,
  description: string,
  openedOn: IsoDate,
  holder: Id | null = null,
): Position {
  const key = ticker || afterFirstSpace(description);
  const known = assets(ledger);
  for (const pos of positions(ledger).values()) {
    const asset = known.get(pos.asset_id)!;
    if (pos.mode === TrackingMode.QUANTITY && !pos.closed && (asset.ticker || asset.name) === key) return pos;
  }
  const spec = description.includes(" ") ? afterFirstSpace(description) : description;
  return createPosition(ledger, ticker || spec, guessClass(spec, ticker), openedOn, {
    holder_id: holder,
    mode: TrackingMode.QUANTITY,
    ticker,
  });
}

export function approveNote(ledger: Ledger, batch: ImportBatch, selected: readonly ExtractedItem[]): ApprovalResult {
  if (batch.account_id === null)
    throw new DomainError("Escolha a conta (saldo em corretora ou conta corrente) onde a nota liquida.");
  const trades = selected.filter((i) => i.kind === ItemKind.TRADE && i.status !== ItemStatus.APPROVED);
  const fees = selected.filter((i) => i.kind === ItemKind.FEE);
  if (!trades.length) throw new DomainError("Nenhum negócio a incorporar.");
  if (trades.some((i) => i.quantity === null || i.unit_price === null || i.amount === null))
    throw new DomainError("Há negócios sem quantidade, preço ou valor.");
  let costTotal: Dec = ZERO;
  for (const f of fees) {
    if (f.description.includes("IRRF")) continue;
    const value = f.amount ?? ZERO;
    costTotal = costTotal.add(f.credit ? value.negate() : value);
  }
  let irrf: Dec = ZERO;
  for (const f of fees) if (f.description.includes("IRRF")) irrf = irrf.add(f.amount ?? ZERO);
  const shares = !costTotal.isZero()
    ? allocate(
        costTotal,
        trades.map((i) => i.amount ?? ZERO),
      )
    : trades.map(() => ZERO);
  const sells = trades.filter((i) => i.description.startsWith("Venda"));
  const irrfShares =
    !irrf.isZero() && sells.length
      ? allocate(
          irrf,
          sells.map((i) => i.amount ?? ZERO),
        )
      : sells.map(() => ZERO);
  const irrfByItem = new Map<Id, Dec>(sells.map((i, n) => [i.id, irrfShares[n]!]));
  const tradeDate = batch.header.trade_date;
  const settle = batch.header.settlement_date;
  if (tradeDate === null) throw new DomainError("Data do pregão desconhecida.");
  const noteRef = `nota ${batch.header.note_number || "?"}`;
  const result = approvalResult();
  // Buys first, so a same-note buy-and-sell never sells what was not yet bought.
  const ordered = trades
    .map((item, n) => ({ item, share: shares[n]! }))
    .sort((a, b) => Number(a.item.description.startsWith("Venda")) - Number(b.item.description.startsWith("Venda")));
  const store = itemStore(ledger);
  for (const { item, share } of ordered) {
    const pos = positionFor(ledger, item.ticker, item.description, tradeDate, item.member_id);
    const quantity = item.quantity!;
    const unitPrice = item.unit_price!;
    const event = item.description.startsWith("Venda")
      ? sell(ledger, pos.id, tradeDate, quantity, unitPrice, batch.account_id, {
          fees: share,
          tax_withheld: irrfByItem.get(item.id) ?? ZERO,
          settled_on: settle,
          note: noteRef,
        })
      : buy(ledger, pos.id, tradeDate, quantity, unitPrice, batch.account_id, {
          fees: share,
          settled_on: settle,
          note: noteRef,
        });
    ledger.put(
      "extracted_item",
      { ...store.get(item.id)!, status: ItemStatus.APPROVED, operation_id: event.operation_ids[0]! },
      { reason: "incorporado à carteira", action: HistoryAction.APPROVE_IMPORT },
    );
    result.created += 1;
  }
  for (const fee of fees) {
    ledger.put(
      "extracted_item",
      { ...store.get(fee.id)!, status: ItemStatus.APPROVED },
      { reason: "custo rateado entre os negócios", action: HistoryAction.APPROVE_IMPORT },
    );
  }
  updateBatchStatus(ledger, batch.id);
  return result;
}
