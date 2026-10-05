/**
 * Collapsible section (docs/16 §3): the title is the toggle, with a chevron before it; the actions sit on the
 * title line and disappear while collapsed. With `prefKey`, the user's choice (only a click, never a change
 * made by code) is remembered on this device.
 */
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { useMotionPreset } from "../motion.tsx";
import { useStoredFlag } from "../preferences.tsx";

export interface CollapsibleProps {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  description?: ReactNode;
  defaultOpen?: boolean;
  /** Controlled state (the ChartPanel opens its table when a point is chosen). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Preference key, e.g. "secoes/visao-geral/mes-a-mes". */
  prefKey?: string;
  level?: 2 | 3;
  className?: string;
}

export function Collapsible({
  title,
  children,
  actions,
  description,
  defaultOpen = true,
  open: controlled,
  onOpenChange,
  prefKey,
  level = 2,
  className,
}: CollapsibleProps) {
  const [stored, setStored] = useStoredFlag(prefKey ? `secoes/${prefKey}` : undefined, defaultOpen);
  const open = controlled ?? stored;
  const id = useId();
  const preset = useMotionPreset();
  const Heading = `h${level}` as "h2" | "h3";
  const toggle = () => {
    setStored(!open);
    onOpenChange?.(!open);
  };
  return (
    <section className={cn("min-w-0", className)}>
      <div className="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Heading className="min-w-0 text-headline font-semibold">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            onClick={toggle}
            className="group -ml-1 inline-flex max-w-full items-center gap-1 rounded-md py-0.5 pr-1.5 pl-0.5 text-left text-text hover:text-accent"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 text-secondary transition-transform duration-[var(--ov-duration-base)] ease-standard group-hover:text-accent",
                open && "rotate-90",
              )}
            />
            <span className="truncate">{title}</span>
          </button>
        </Heading>
        {open && actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {description && open ? <p className="-mt-1 mb-2 text-caption text-secondary">{description}</p> : null}
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div key="content" id={id} {...preset.enter}>
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
