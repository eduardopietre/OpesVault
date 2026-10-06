/**
 * The last backup made on this device and the reminder for it (docs/19 §13.3). The day is a DEVICE preference
 * per project: the file lives on this device, a backup made elsewhere does not protect this copy, and the
 * project's persisted schema stays untouched. The reminder is the domain's `backupAlert` (30 days), with the
 * words of the web (there is no folder to look in) and a link to Configurações › Backup.
 */
import { dom, formatDateBr, isIsoDate, type IsoDate } from "@opesvault/domain";
import { usePreferences, type PreferenceStore } from "@opesvault/ui";
import { useMemo } from "react";
import { lastBackupKey } from "../../data/backup.ts";
import { useLedger } from "../../data/react.tsx";
import { useSession } from "../../session.tsx";

export function readLastBackup(store: PreferenceStore, projectId: string): IsoDate | null {
  const value = store.get(lastBackupKey(projectId));
  return value !== null && isIsoDate(value) ? value : null;
}

export function writeLastBackup(store: PreferenceStore, projectId: string, day: IsoDate): void {
  store.set(lastBackupKey(projectId), day);
}

/** The reminder, or none: a project without any operation has nothing worth a backup yet. */
export function backupNotices(last: IsoDate | null, today: IsoDate, hasData: boolean): dom.alerts.Alert[] {
  if (last === null && !hasData) return [];
  return dom.alerts.backupAlert(last, today, false).map((alert) => ({
    ...alert,
    detail:
      last === null
        ? "nenhum backup foi feito neste aparelho; faça um em Configurações e guarde o arquivo fora dele"
        : `de ${formatDateBr(last)}; faça um novo em Configurações e confira-o com “Verificar arquivo…”`,
    ref: "backup",
  }));
}

/** The reminder of the open project, for the Visão geral's notices. */
export function useBackupAlerts(today: IsoDate): readonly dom.alerts.Alert[] {
  const preferences = usePreferences();
  const projectId = useSession().open?.project.id ?? null;
  const hasData = useLedger((ledger) => ledger.operations.size > 0, "operations");
  return useMemo(
    () => (projectId === null ? [] : backupNotices(readLastBackup(preferences, projectId), today, hasData)),
    [preferences, projectId, today, hasData],
  );
}
