/**
 * The table of goals: progress as a bar and in words ("42%" or "100% · alcançada").
 */
import { formatBrl } from "@opesvault/domain";
import { Badge, DURATION, EASE, ElidedText, useMotionPreset, type DataColumn } from "@opesvault/ui";
import { motion } from "motion/react";
import { nameOf, reachedShort, shareLabel, sortCents, type GoalRow } from "./rows.ts";
import { cents, moneyOr, dateOr } from "../../data/money.ts";

/** The bar fills to the share reached (full and green when reached); the words next to it say the same. */
export function ShareBar({ row, wide = true }: { row: GoalRow; wide?: boolean }) {
  const preset = useMotionPreset();
  const share = Math.min(1, Math.max(0, row.progress.share.toNumberForDisplay()));
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className={`h-1.5 shrink-0 overflow-hidden rounded-full bg-selection-inactive ${wide ? "w-16" : "w-12"}`}
      >
        <motion.span
          className={`block h-full origin-left rounded-full ${row.progress.reached ? "bg-positive" : "bg-accent"}`}
          initial={preset.reduce ? { opacity: 0 } : { scaleX: 0 }}
          animate={preset.reduce ? { opacity: 1 } : { scaleX: share }}
          {...(preset.reduce ? { style: { transform: `scaleX(${share})` } } : {})}
          transition={{ duration: DURATION.slow, ease: EASE.enter }}
        />
      </span>
      <span className="truncate tabular-nums">{shareLabel(row.progress)}</span>
    </span>
  );
}

export const GOAL_COLUMNS: DataColumn<GoalRow>[] = [
  {
    id: "meta",
    header: "Meta",
    cell: (r) => (
      <span className="flex min-w-0 items-center gap-2">
        <ElidedText>{r.goal.name}</ElidedText>
        {r.goal.archived ? <Badge>arquivada</Badge> : null}
      </span>
    ),
    sortValue: (r) => nameOf(r.goal),
    width: 130,
    grow: 2,
  },
  {
    id: "atual",
    header: "Atual",
    cell: (r) => formatBrl(r.progress.current),
    sortValue: (r) => cents(r.progress.current),
    align: "end",
    width: 124,
  },
  {
    id: "alvo",
    header: "Alvo",
    cell: (r) => formatBrl(r.goal.target),
    sortValue: (r) => cents(r.goal.target),
    align: "end",
    width: 124,
  },
  {
    id: "progresso",
    header: "Progresso",
    cell: (r) => <ShareBar row={r} />,
    sortValue: (r) => cents(r.progress.share),
    width: 130,
    grow: 1,
  },
  {
    id: "falta",
    header: "Falta",
    cell: (r) => formatBrl(r.progress.missing),
    sortValue: (r) => cents(r.progress.missing),
    align: "end",
    width: 124,
  },
  {
    id: "prazo",
    header: "Prazo",
    cell: (r) => dateOr(r.goal.target_date),
    sortValue: (r) => r.goal.target_date,
    width: 104,
    priority: 2,
  },
  {
    id: "mes",
    header: "Por mês",
    cell: (r) => moneyOr(r.progress.neededPerMonth),
    sortValue: (r) => sortCents(r.progress.neededPerMonth),
    align: "end",
    width: 116,
    priority: 2,
  },
  {
    id: "ritmo",
    header: "Ritmo recente",
    cell: (r) => moneyOr(r.progress.pace),
    sortValue: (r) => sortCents(r.progress.pace),
    align: "end",
    width: 116,
    priority: 3,
  },
  {
    id: "alcanca",
    header: "Alcança em",
    cell: (r) => reachedShort(r.progress.reachedOnPace),
    sortValue: (r) =>
      r.progress.reachedOnPace ? r.progress.reachedOnPace.year * 12 + r.progress.reachedOnPace.month : null,
    width: 96,
    priority: 3,
  },
];

/** Width from which the table has room for nine columns. */
const WIDE_TABLE = 1120;
const PACE_COLUMNS: ReadonlySet<string> = new Set(["ritmo", "alcanca"]);

/**
 * The table's columns for the room it has: the pace and the month it is reached are in the details of the
 * selected goal, so the table shows them only when it is wide enough for nine columns.
 */
export function goalColumns(width: number): DataColumn<GoalRow>[] {
  return width === 0 || width >= WIDE_TABLE ? GOAL_COLUMNS : GOAL_COLUMNS.filter((c) => !PACE_COLUMNS.has(c.id));
}
