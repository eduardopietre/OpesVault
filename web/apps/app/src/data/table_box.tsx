/**
 * The room a short `DataTable` gets (docs/16 §4): as a table it is as tall as its rows up to a cap and scrolls
 * inside itself; as cards (when its own container is narrower than `CARDS_BELOW`, which depends on the column it sits
 * in and not on the window) it grows with them, since a card list clipped to a row count would hide cards.
 */
import { CARDS_BELOW, fitHeight, useElementWidth } from "@opesvault/ui";
import type { ReactNode } from "react";

export function TableBox({
  rows,
  cap,
  children,
}: {
  rows: number;
  /** The most rows shown before the table scrolls. */
  cap: number;
  children: (height: string) => ReactNode;
}) {
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const cards = width > 0 && width < CARDS_BELOW;
  return (
    <div ref={measure} className="min-w-0">
      {children(fitHeight(rows, cap, cards))}
    </div>
  );
}
