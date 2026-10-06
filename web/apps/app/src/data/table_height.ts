/**
 * Height of a table of `count` rows, capped at `max` (the table scrolls beyond it). On phones the rows are
 * cards, taller than a row: the list takes the room it needs and the page scrolls.
 */
export function tableHeight(count: number, max: number, cards = false): string {
  if (cards) return "none";
  return `${Math.max(1, Math.min(count, max)) * 36 + 38}px`;
}
