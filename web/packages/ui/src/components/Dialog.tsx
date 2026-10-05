/**
 * Dialogs (docs/16 §3): a form or a decision over the page. The title is the question or the task, the
 * footer has buttons that say what they do. Errors appear inside the form, never in a second dialog.
 * Under 640 px a dialog is a bottom sheet.
 */
import { X } from "lucide-react";
import { useId, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { Button, IconButton, type ButtonVariant } from "./Button.tsx";
import { Overlay, type Placement } from "./Overlay.tsx";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned (stacked full width on phones). */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Renders the body as a form: Enter submits. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  dismissable?: boolean;
  role?: "dialog" | "alertdialog";
  /** Hides the close button (decisions always offer Cancel instead). */
  hideClose?: boolean;
}

const widths = { sm: "tablet:w-[min(440px,calc(100vw-32px))]", md: "", lg: "tablet:w-[min(800px,calc(100vw-32px))]" };

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  onSubmit,
  dismissable = true,
  role = "dialog",
  hideClose,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const body = (
    <>
      <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-1">
        <div className="min-w-0">
          <h2 id={titleId} className="text-headline font-semibold text-text">
            {title}
          </h2>
          {description ? (
            <div id={descriptionId} className="mt-1 text-body text-secondary">
              {description}
            </div>
          ) : null}
        </div>
        {hideClose || !dismissable ? null : (
          <IconButton
            label="Fechar"
            icon={<X />}
            size="sm"
            className="-mt-1 -mr-2"
            onClick={() => onOpenChange(false)}
          />
        )}
      </div>
      {children ? (
        // Focusable so a long body scrolls with the keyboard too.
        <div tabIndex={0} className="min-h-0 flex-1 overflow-y-auto rounded-sm px-5 py-3">
          {children}
        </div>
      ) : null}
      {footer ? (
        <div className="flex flex-col-reverse gap-2 border-t border-separator px-5 py-3 tablet:flex-row tablet:justify-end [&>button]:w-full tablet:[&>button]:w-auto">
          {footer}
        </div>
      ) : null}
    </>
  );
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      placement="center"
      labelledBy={titleId}
      {...(description ? { describedBy: descriptionId } : {})}
      panelClassName={cn(widths[size])}
      dismissable={dismissable}
      role={role}
    >
      {onSubmit ? (
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(event);
          }}
        >
          {body}
        </form>
      ) : (
        body
      )}
    </Overlay>
  );
}

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  side?: Exclude<Placement, "center" | "top">;
  children: ReactNode;
  /** Visually hides the title (the drawer shows the sidebar's own header instead). */
  hideTitle?: boolean;
  className?: string | undefined;
}

/** A panel that slides in from an edge: the drawer, the inspector on medium screens, "Mais" on phones. */
export function Sheet({ open, onOpenChange, title, side = "right", children, hideTitle, className }: SheetProps) {
  const titleId = useId();
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      placement={side}
      labelledBy={titleId}
      panelClassName={cn("overflow-hidden", className)}
    >
      <div className={cn("flex items-center justify-between gap-2 px-4 pt-3 pb-2", hideTitle && "sr-only")}>
        <h2 id={titleId} className="truncate text-headline font-semibold">
          {title}
        </h2>
        <IconButton label="Fechar" icon={<X />} size="sm" onClick={() => onOpenChange(false)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </Overlay>
  );
}

// ── decide / confirm ─────────────────────────────────────────────────────────

export interface Choice {
  id: string;
  label: string;
  variant?: ButtonVariant;
}

export interface DecisionRequest {
  /** The question ("Descartar as alterações deste lançamento?"). */
  title: string;
  /** The consequence of each choice. */
  text?: ReactNode;
  /** Buttons in reading order; Cancel is added at the end and resolves to null. */
  choices: readonly Choice[];
  cancelLabel?: string;
  /** The choice focused first (defaults to Cancel when any choice is "danger"). */
  defaultChoice?: string;
}

interface Pending extends DecisionRequest {
  key: number;
  resolve: (choice: string | null) => void;
}

let queue: Pending[] = [];
let counter = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Asks a decision and resolves with the chosen id, or null for Cancel (docs/16 §3): no icon and no Yes/No,
 * each button says what it does. Needs a <DecisionHost /> mounted once in the app.
 */
export function decide(request: DecisionRequest): Promise<string | null> {
  return new Promise((resolve) => {
    queue = [...queue, { ...request, key: ++counter, resolve }];
    emit();
  });
}

export interface ConfirmRequest {
  title: string;
  text?: ReactNode;
  /** The verb of the action ("Excluir lançamento"). */
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** A decision with one action and Cancel; resolves true when the action was chosen. */
export async function confirm(request: ConfirmRequest): Promise<boolean> {
  const choice = await decide({
    title: request.title,
    text: request.text,
    choices: [{ id: "confirm", label: request.confirmLabel, variant: request.danger ? "danger" : "primary" }],
    ...(request.cancelLabel ? { cancelLabel: request.cancelLabel } : {}),
  });
  return choice === "confirm";
}

function settle(pending: Pending, choice: string | null) {
  queue = queue.filter((item) => item.key !== pending.key);
  emit();
  pending.resolve(choice);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Shows the pending decisions one at a time. Mount once, near the root. */
export function DecisionHost() {
  const current = useSyncExternalStore(
    subscribe,
    () => queue[0] ?? null,
    () => null,
  );
  if (!current) return null;
  const danger = current.choices.some((choice) => choice.variant === "danger");
  const focus = current.defaultChoice ?? (danger ? "__cancel" : current.choices.at(-1)?.id);
  return (
    <Dialog
      key={current.key}
      open
      onOpenChange={(open) => {
        if (!open) settle(current, null);
      }}
      title={current.title}
      description={current.text}
      size="sm"
      role="alertdialog"
      hideClose
      footer={
        <>
          <Button data-autofocus={focus === "__cancel" ? "" : undefined} onClick={() => settle(current, null)}>
            {current.cancelLabel ?? "Cancelar"}
          </Button>
          {current.choices.map((choice) => (
            <Button
              key={choice.id}
              variant={choice.variant ?? "secondary"}
              data-autofocus={focus === choice.id ? "" : undefined}
              onClick={() => settle(current, choice.id)}
            >
              {choice.label}
            </Button>
          ))}
        </>
      }
    />
  );
}

/** Drops pending decisions (tests, and when the project locks: nothing waits on a hidden question). */
export function cancelAllDecisions() {
  const pending = queue;
  queue = [];
  emit();
  for (const item of pending) item.resolve(null);
}
