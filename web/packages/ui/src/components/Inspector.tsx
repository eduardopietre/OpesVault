/**
 * The inspector (docs/16 §1): details of the selected object beside the work area instead of a dialog.
 * Wide screens (≥ 1440 px): a side column that slides in. Medium (1024–1439): a sheet sliding from the
 * right. Below: hidden; the page offers its own way to see the details.
 */
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { useBand } from "../hooks.ts";
import { useMotionPreset } from "../motion.tsx";
import type { Band } from "../tokens.ts";
import { IconButton } from "./Button.tsx";
import { Sheet } from "./Dialog.tsx";

export interface InspectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  /** Width of the side column on wide screens. */
  width?: number;
  className?: string;
  /** Forces a band (the catalog shows each form). */
  band?: Band;
}

export function Inspector({ open, onOpenChange, title, children, width = 360, className, band }: InspectorProps) {
  const current = useBand();
  const mode = band ?? current;
  const titleId = useId();
  const preset = useMotionPreset();
  if (mode === "phone" || mode === "tablet") return null;
  if (mode === "medium") {
    return (
      <Sheet open={open} onOpenChange={onOpenChange} title={title} side="right">
        <div className="px-4 pb-4">{children}</div>
      </Sheet>
    );
  }
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.aside
          key="inspector"
          aria-labelledby={titleId}
          initial={preset.reduce ? { opacity: 0 } : { opacity: 0, x: 24 }}
          animate={preset.reduce ? { opacity: 1 } : { opacity: 1, x: 0 }}
          exit={preset.reduce ? { opacity: 0 } : { opacity: 0, x: 24 }}
          transition={preset.spring("panel")}
          style={{ width }}
          className={cn("flex min-h-0 shrink-0 flex-col border-l border-separator bg-content", className)}
        >
          <div className="flex items-center justify-between gap-2 border-b border-separator px-4 py-3">
            <h2 id={titleId} className="truncate text-headline font-semibold">
              {title}
            </h2>
            <IconButton label="Fechar inspetor" size="sm" icon={<X />} onClick={() => onOpenChange(false)} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
