/**
 * "Avisos recentes": the toasts this tab showed, newest first, with the time. The list lives only in the tab's
 * memory (docs/19 §12) and is forgotten on lock. A toast's action (Desfazer) is not offered again: by now the
 * undo history may have moved on; Ctrl+Z still undoes the last action.
 */
import { Button, Dialog, EmptyState, ToastIcon, useToastHistory } from "@opesvault/ui";
import { BellOff } from "lucide-react";

const TIME = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });

/** "14:05", or "12/10 14:05" for a toast of another day. */
export function noticeTime(at: number, now: number = Date.now()): string {
  const when = new Date(at);
  const sameDay = new Date(now).toDateString() === when.toDateString();
  return sameDay ? TIME.format(when) : `${DAY.format(when)} ${TIME.format(when)}`;
}

export function RecentNotices({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const items = useToastHistory();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Avisos recentes"
      description="Os avisos desta aba, do mais novo ao mais antigo. Somem ao bloquear ou fechar o projeto."
      footer={
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          Fechar
        </Button>
      }
    >
      {items.length ? (
        <ol aria-label="Avisos recentes" className="flex flex-col">
          {items.map((item) => (
            <li
              key={item.id}
              data-tone={item.tone}
              className="flex items-start gap-3 border-b border-separator/70 py-2 text-body last:border-b-0 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0"
            >
              <ToastIcon tone={item.tone} />
              <span className="min-w-0 flex-1 break-words">{item.message}</span>
              <time dateTime={new Date(item.at).toISOString()} className="shrink-0 text-caption text-secondary">
                {noticeTime(item.at)}
              </time>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState
          icon={<BellOff />}
          title="Nenhum aviso ainda"
          description="O que cada ação fizer aparece aqui depois que o aviso sumir da tela."
          level={3}
          className="py-6"
        />
      )}
    </Dialog>
  );
}
