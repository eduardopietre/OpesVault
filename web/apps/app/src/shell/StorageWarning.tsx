/**
 * Under the top bar while changes made here wait to be sent and the browser said it may erase this site's data
 * (persistent storage denied, docs/19 §8): if it does, those changes are lost. It goes away once they are sent.
 */
import { TriangleAlert } from "lucide-react";

export function storageWarningText(pending: number): string {
  const changes =
    pending === 1
      ? "Há 1 alteração ainda não enviada"
      : `Há ${pending.toLocaleString("pt-BR")} alterações ainda não enviadas`;
  return `O navegador pode apagar os dados deste aparelho. ${changes}; conecte-se para enviá-las.`;
}

export function StorageWarning({ pending, atRisk }: { pending: number; atRisk: boolean }) {
  if (!atRisk || pending <= 0) return null;
  return (
    <p
      role="status"
      className="flex items-start gap-2 border-b border-separator bg-warning-soft px-4 py-2 text-caption text-text tablet:px-6"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <span className="min-w-0">{storageWarningText(pending)}</span>
    </p>
  );
}

export function saveWarningText(unsaved: number, reason: string): string {
  const changes = unsaved === 1 ? "1 alteração está" : `${unsaved.toLocaleString("pt-BR")} alterações estão`;
  return `${changes} só nesta aba e se perde${unsaved === 1 ? "" : "m"} se você fechá-la ou bloquear o projeto. ${reason} O app tenta de novo quando a conexão ou a edição voltarem.`;
}

/**
 * Under the top bar while changes made here could not be stored in the browser nor sent (a hand-over to the vault
 * or an upload failed): unlike pending changes, they exist only in this tab's memory.
 */
export function SaveWarning({ unsaved, reason }: { unsaved: number; reason: string | null }) {
  if (reason === null || unsaved <= 0) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-2 border-b border-separator bg-warning-soft px-4 py-2 text-caption text-text tablet:px-6"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <span className="min-w-0">{saveWarningText(unsaved, reason)}</span>
    </p>
  );
}
