/**
 * The sync state, always visible in the top bar (docs/18 §3.3): a dot and a text, never color alone.
 * Changes are announced politely. The dot pulses while syncing.
 */
import { cn } from "../cn.ts";

export type SyncState = "synced" | "pending" | "syncing" | "offline" | "conflict" | "readonly" | "locked";

export const SYNC_LABELS: Record<SyncState, string> = {
  synced: "Sincronizado",
  pending: "Alterações pendentes",
  syncing: "Sincronizando…",
  offline: "Sem conexão",
  conflict: "Conflito",
  readonly: "Somente leitura",
  locked: "Bloqueado",
};

/** Shorter labels for phones. */
export const SYNC_SHORT: Record<SyncState, string> = {
  synced: "Sincronizado",
  pending: "Pendente",
  syncing: "Sincronizando",
  offline: "Offline",
  conflict: "Conflito",
  readonly: "Leitura",
  locked: "Bloqueado",
};

const dot: Record<SyncState, string> = {
  synced: "bg-positive",
  pending: "bg-warning",
  syncing: "bg-accent ov-pulse",
  offline: "bg-secondary",
  conflict: "bg-negative",
  readonly: "bg-secondary",
  locked: "bg-secondary",
};

const shape: Record<SyncState, string> = {
  synced: "rounded-full",
  pending: "rounded-full",
  syncing: "rounded-full",
  offline: "rounded-none rotate-45 scale-75", // a different shape: not only color
  conflict: "rounded-[1px]",
  readonly: "rounded-full ring-1 ring-secondary bg-transparent",
  locked: "rounded-[1px]",
};

export interface StatusPillProps {
  state: SyncState;
  /** More detail for the tooltip ("3 alterações aguardando envio"). */
  detail?: string;
  compact?: boolean;
  className?: string | undefined;
  onClick?: () => void;
}

export function StatusPill({ state, detail, compact, className, onClick }: StatusPillProps) {
  const text = compact ? SYNC_SHORT[state] : SYNC_LABELS[state];
  const body = (
    <>
      <span aria-hidden="true" className={cn("size-2 shrink-0", dot[state], shape[state])} />
      <span className="truncate">{text}</span>
    </>
  );
  const classes = cn(
    "inline-flex h-7 max-w-full items-center gap-2 rounded-full border border-separator bg-raised px-2.5 text-caption font-medium text-text",
    state === "conflict" && "border-negative/50 bg-negative-soft text-negative",
    state === "pending" && "bg-warning-soft",
    className,
  );
  const label = `Estado da sincronização: ${SYNC_LABELS[state]}${detail ? `. ${detail}` : ""}`;
  return (
    <span role="status" aria-live="polite" className="inline-flex min-w-0">
      {onClick ? (
        <button type="button" className={classes} title={label} aria-label={label} onClick={onClick}>
          {body}
        </button>
      ) : (
        <span className={classes} title={label}>
          <span className="sr-only">Estado da sincronização: </span>
          {body}
          {detail ? <span className="sr-only">. {detail}</span> : null}
        </span>
      )}
    </span>
  );
}
