/**
 * Which columns of a table fit the room it has. `DataTable` hides columns by fixed widths (720 and 960 px), which
 * cannot know that a table of ten columns needs more than a table of five: here each column has a tier (1 always
 * shows, a higher tier is dropped first) and a tier is shown only when the minimum widths of everything up to it
 * add up to the container's width, so a table never scrolls sideways inside its box. On a phone the table is a
 * list of cards, which grow downward: more tiers are shown there.
 */
import { CARDS_BELOW, type DataColumn } from "@opesvault/ui";

export interface TierColumn<T> extends Omit<DataColumn<T>, "priority"> {
  /** 1: always; higher tiers are dropped first when the table is narrow. */
  tier?: number;
}

/** The highest tier a card shows. */
export const CARD_TIERS = 3;

const minWidth = (column: { width?: number | undefined }) => column.width ?? 120;

/** The columns to draw in `width` px (0: not measured yet, every column), in their own order. */
export function fitColumns<T>(columns: readonly TierColumn<T>[], width: number): DataColumn<T>[] {
  const strip = (list: readonly TierColumn<T>[]): DataColumn<T>[] =>
    list.map(({ tier: _tier, ...column }) => column as DataColumn<T>);
  if (width <= 0) return strip(columns);
  const tiers = [...new Set(columns.map((c) => c.tier ?? 1))].sort((a, b) => a - b);
  if (width < CARDS_BELOW) return strip(columns.filter((c) => (c.tier ?? 1) <= CARD_TIERS));
  let shown = 0;
  for (const tier of tiers) {
    const total = columns.filter((c) => (c.tier ?? 1) <= tier).reduce((sum, c) => sum + minWidth(c), 0);
    if (total > width && shown > 0) break;
    shown = tier;
  }
  return strip(columns.filter((c) => (c.tier ?? 1) <= shown));
}
