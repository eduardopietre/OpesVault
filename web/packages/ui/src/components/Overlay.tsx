/**
 * The modal layer under Dialog, Sheet, the drawer, the inspector sheet and the command palette.
 *
 * Built on the native <dialog> element (top layer, inert page underneath, Esc): Radix Dialog's scroll lock
 * injects <style> elements, which the strict CSP (docs/18 §3.7, style-src 'self') refuses. The panel springs in
 * with Motion; a user who asks for less motion gets a short fade. Under 640 px a dialog becomes a bottom sheet.
 */
import { AnimatePresence, motion, type Transition } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { useMediaQuery } from "../hooks.ts";
import { useMotionPreset } from "../motion.tsx";
import { BAND, DURATION, EASE } from "../tokens.ts";

export type Placement = "center" | "top" | "bottom" | "left" | "right";

export interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the panel sits; "center" and "top" become a bottom sheet on phones. */
  placement?: Placement;
  /** Accessible name of the layer (usually the id of the visible title). */
  labelledBy?: string;
  label?: string;
  describedBy?: string;
  /** Classes of the panel (width, height, padding). */
  panelClassName?: string;
  /** Escape and a click outside close it (false while a decision is required). */
  dismissable?: boolean;
  /** Element focused when it opens (defaults to the first control with autofocus or the first control). */
  initialFocus?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
  /** alertdialog for decisions. */
  role?: "dialog" | "alertdialog";
}

/**
 * What should get focus back when the layer closes. A dialog opened from a menu entry would otherwise remember the
 * entry, which is gone by then: the menu's own button (named by the menu's `aria-labelledby`) is the opener.
 */
function opener(active: Element | null): Element | null {
  const labelledBy = active?.closest?.('[role="menu"]')?.getAttribute("aria-labelledby");
  return (labelledBy ? document.getElementById(labelledBy) : null) ?? active;
}

/**
 * Leaves the modal state: closes the native dialog (the page is no longer inert) and gives focus back to
 * where it was, unless the user or the action already moved it elsewhere.
 */
function release(element: HTMLDialogElement, previous: Element | null) {
  if (element.hasAttribute("data-closing")) return;
  element.setAttribute("data-closing", "");
  const active = document.activeElement;
  const focusInside = active !== null && element.contains(active);
  if (element.open) element.close();
  // The panel stays visible while it animates out: focus must not stay on a control inside it.
  if (focusInside && active instanceof HTMLElement) active.blur();
  if (
    (focusInside || active === document.body || active === null) &&
    previous instanceof HTMLElement &&
    previous.isConnected
  ) {
    previous.focus();
  }
}

/** Keeps the layer mounted until its exit animation ends. */
export function Overlay(props: OverlayProps) {
  const [mounted, setMounted] = useState(props.open);
  if (props.open && !mounted) setMounted(true);
  if (!mounted) return null;
  return <OverlayLayer {...props} onExited={() => setMounted(false)} />;
}

function OverlayLayer({
  open,
  onOpenChange,
  placement = "center",
  labelledBy,
  label,
  describedBy,
  panelClassName,
  dismissable = true,
  initialFocus,
  children,
  role = "dialog",
  onExited,
}: OverlayProps & { onExited: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const previous = useRef<Element | null>(null);
  const preset = useMotionPreset();
  const phone = !useMediaQuery(`(min-width: ${BAND.tablet}px)`);
  const where: Placement = phone && (placement === "center" || placement === "top") ? "bottom" : placement;

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    previous.current = opener(document.activeElement);
    if (!element.open) {
      try {
        element.showModal();
      } catch {
        element.setAttribute("open", "");
      }
    }
    const target =
      initialFocus?.current ??
      element.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ??
      // A form opens on its first field (the close button comes first in the document, but typing is the
      // task); a layer with no field falls through to its first control.
      element.querySelector<HTMLElement>(
        "input:not([disabled]):not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']), textarea:not([disabled]), select:not([disabled]), [role='combobox']:not([disabled])",
      ) ??
      element.querySelector<HTMLElement>(
        "input:not([disabled]), textarea, select, button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      );
    target?.focus();
    return () => release(element, previous.current);
    // Runs once per opening: the layer is remounted for each one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    // Closing: the page becomes usable at once (focus returns, nothing inert) while the panel animates out.
    const element = dialog.current;
    if (!open && element) release(element, previous.current);
  }, [open]);

  useEffect(() => {
    // Escape is handled on keydown (so the browser's own cancel never closes a decision).
    const element = dialog.current;
    if (!element) return;
    const stop = (event: Event) => event.preventDefault();
    element.addEventListener("cancel", stop);
    return () => element.removeEventListener("cancel", stop);
  }, []);

  const close = () => {
    if (dismissable) onOpenChange(false);
  };

  const transition: Transition =
    where === "center" || where === "top" ? preset.spring("dialog") : preset.spring("sheet");
  const from = preset.reduce
    ? { opacity: 0 }
    : where === "bottom"
      ? { y: "100%" }
      : where === "left"
        ? { x: "-100%" }
        : where === "right"
          ? { x: "100%" }
          : { opacity: 0, scale: 0.96, y: 8 };
  const to = preset.reduce
    ? { opacity: 1 }
    : where === "center" || where === "top"
      ? { opacity: 1, scale: 1, y: 0 }
      : { x: 0, y: 0 };

  return (
    <dialog
      ref={dialog}
      className="ov-layer"
      data-ov-modal=""
      role={role === "alertdialog" ? "alertdialog" : undefined}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      aria-describedby={describedBy}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <AnimatePresence onExitComplete={onExited}>
        {open ? (
          <motion.div
            key="scrim"
            aria-hidden="true"
            className="fixed inset-0 bg-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION.base, ease: EASE.standard }}
            onClick={close}
          />
        ) : null}
        {open ? (
          <motion.div
            key="panel"
            initial={from}
            animate={to}
            exit={{ ...from, transition: { duration: DURATION.fast, ease: EASE.exit } }}
            transition={transition}
            data-placement={where}
            className={cn(
              "fixed flex flex-col bg-raised text-text shadow-lg outline-none",
              where === "center" &&
                "top-1/2 left-1/2 max-h-[85dvh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl",
              where === "top" &&
                "top-[12dvh] left-1/2 max-h-[70dvh] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 rounded-xl",
              where === "bottom" && "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-xl pb-[env(safe-area-inset-bottom)]",
              where === "left" && "inset-y-0 left-0 w-[min(320px,86vw)] border-r border-separator",
              where === "right" && "inset-y-0 right-0 w-[min(420px,92vw)] border-l border-separator",
              panelClassName,
            )}
          >
            {where === "bottom" ? (
              <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-separator-strong" />
            ) : null}
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </dialog>
  );
}
