/**
 * Counts next to the sidebar names (desktop `MainWindow._update_badges`): Visão geral counts the
 * notices that are not merely informative, Importar e revisar counts the items waiting for review.
 */
import { dom, importing, type Ledger, type IsoDate } from "@opesvault/domain";
import { useOptionalWorkspace } from "./react.tsx";
import { useSyncExternalStore } from "react";

export function attentionCounts(ledger: Ledger, today: IsoDate): Record<string, number> {
  const pending = [...importing.importStore.items(ledger).values()].filter(
    (item) => item.status === "ready" || item.status === "needs_review",
  ).length;
  const notices = dom.alerts.alerts(ledger, today).filter((a) => a.severity !== dom.alerts.Severity.INFO).length;
  return { "visao-geral": notices, importar: pending };
}

const noSubscribe = () => () => undefined;
const noVersion = () => 0;
const cache = new WeakMap<object, { version: number; counts: Record<string, number> }>();

/** The counts of the open project, recomputed after each change; `fallback` without a project. */
export function useAttention(fallback: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const workspace = useOptionalWorkspace();
  const version = useSyncExternalStore(workspace?.subscribe ?? noSubscribe, workspace?.getVersion ?? noVersion);
  if (!workspace) return fallback;
  const hit = cache.get(workspace);
  if (hit && hit.version === version) return hit.counts;
  const counts = attentionCounts(workspace.ledger, workspace.today());
  cache.set(workspace, { version, counts });
  return counts;
}
