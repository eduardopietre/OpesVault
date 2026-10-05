/**
 * Short feedback (docs/16 §4 rules 2 and 14): what an action did, in one line, without a dialog. Toasts are
 * read by screen readers through a polite live region, stay while hovered or focused and may offer one
 * action ("Desfazer").
 */
import { AnimatePresence, motion } from "motion/react";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { useMotionPreset } from "../motion.tsx";
import { IconButton } from "./Button.tsx";

export type ToastTone = "info" | "positive" | "warning" | "negative";

export interface ToastOptions {
  tone?: ToastTone;
  /** One action button, such as Desfazer. */
  action?: { label: string; run: () => void };
  /** Milliseconds on screen (default 5 s; 0 keeps it until closed). */
  duration?: number;
}

export interface ToastItem extends Required<Pick<ToastOptions, "tone" | "duration">> {
  id: number;
  message: string;
  action?: ToastOptions["action"];
}

let toasts: ToastItem[] = [];
let next = 0;
const listeners = new Set<() => void>();
const MAX_VISIBLE = 3;

function emit() {
  for (const listener of listeners) listener();
}

/** Shows a short message; returns its id (for dismissToast). */
export function notify(message: string, options: ToastOptions = {}): number {
  const id = ++next;
  const item: ToastItem = { id, message, tone: options.tone ?? "info", duration: options.duration ?? 5000 };
  if (options.action) item.action = options.action;
  toasts = [...toasts, item].slice(-MAX_VISIBLE);
  emit();
  return id;
}

export function dismissToast(id: number) {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function clearToasts() {
  toasts = [];
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const icons: Record<ToastTone, ReactNode> = {
  info: <Info className="text-accent" />,
  positive: <CircleCheck className="text-positive" />,
  warning: <TriangleAlert className="text-warning" />,
  negative: <CircleAlert className="text-negative" />,
};

function ToastView({ toast }: { toast: ToastItem }) {
  const paused = useRef(false);
  const preset = useMotionPreset();
  useEffect(() => {
    if (!toast.duration) return;
    let left = toast.duration;
    const step = 250;
    const timer = setInterval(() => {
      if (paused.current) return;
      left -= step;
      if (left <= 0) dismissToast(toast.id);
    }, step);
    return () => clearInterval(timer);
  }, [toast.id, toast.duration]);
  return (
    <motion.div
      layout={!preset.reduce}
      initial={preset.reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
      animate={preset.reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={preset.spring("panel")}
      onPointerEnter={() => (paused.current = true)}
      onPointerLeave={() => (paused.current = false)}
      onFocus={() => (paused.current = true)}
      onBlur={() => (paused.current = false)}
      className="pointer-events-auto flex w-full items-center gap-3 rounded-lg border border-separator bg-raised py-2 pr-2 pl-3 text-body text-text shadow-lg [&>svg]:size-4 [&>svg]:shrink-0"
      data-tone={toast.tone}
    >
      {icons[toast.tone]}
      <span className="min-w-0 flex-1">{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 font-semibold text-accent hover:bg-hover"
          onClick={() => {
            toast.action?.run();
            dismissToast(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <IconButton label="Fechar aviso" icon={<X />} size="sm" onClick={() => dismissToast(toast.id)} />
    </motion.div>
  );
}

/** The toast region. Mount once; on phones it sits above the bottom navigation. */
export function Toaster({ className }: { className?: string }) {
  const items = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => toasts,
  );
  return (
    <section
      aria-label="Avisos"
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-[calc(72px+env(safe-area-inset-bottom))] z-50 flex justify-center px-4 tablet:bottom-6 tablet:justify-end tablet:px-6",
        className,
      )}
    >
      <div role="status" aria-live="polite" aria-atomic="false" className="flex w-full max-w-[420px] flex-col gap-2">
        <AnimatePresence initial={false}>
          {items.map((toast) => (
            <ToastView key={toast.id} toast={toast} />
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}
