/**
 * Values that are slow on a big project (notices, the sidebar's counts) are computed after the screen is
 * painted, not before it: opening the project, or saving a change, shows the page first. Small projects get
 * the value at once, in the same render, so nothing about them changes.
 */
import type { Ledger } from "@opesvault/domain";
import { useEffect, useMemo, useState } from "react";
import type { Workspace } from "./workspace.ts";

/** From this many operations on, `useLater` defers. Computing the notices of 5 000 takes a few milliseconds. */
export const BIG_PROJECT = 5000;

/** Runs `work` after the browser has painted the current frame. */
export function afterPaint(work: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(work, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
  };
}

export function isBig(ledger: Ledger): boolean {
  return ledger.operations.size > BIG_PROJECT;
}

/**
 * `select(ledger)` for `workspace` at `version` (and `key`): at once for a small project; after the paint for a
 * big one. Until the first value arrives it is `fallback`; while a newer one is being computed the previous
 * value stays (a count that is one change behind for a moment, never a blank).
 */
export function useLater<T>(
  workspace: Workspace | null,
  version: number,
  key: string | number | null,
  select: (ledger: Ledger) => T,
  fallback: T,
): T {
  const big = workspace !== null && isBig(workspace.ledger);
  const now = useMemo(
    () => (workspace !== null && !big ? select(workspace.ledger) : fallback),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `select` depends only on the ledger and `key`
    [workspace, version, key, big],
  );
  const [later, setLater] = useState<{ workspace: Workspace; value: T } | null>(null);
  useEffect(() => {
    if (workspace === null || !big) return;
    return afterPaint(() => setLater({ workspace, value: select(workspace.ledger) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `select` depends only on the ledger and `key`
  }, [workspace, version, key, big]);
  if (!big) return now;
  return later !== null && later.workspace === workspace ? later.value : fallback;
}
