/**
 * The key figures of the month: each amount counts up to its value on entry (`NumberTicker`, exact to the
 * cent) and says its sign in the text; the tone (positive, negative) only adds to it.
 */
import { Dec, formatBrl } from "@opesvault/domain";
import { Figure, NumberTicker, cn, useMotionPreset } from "@opesvault/ui";
import { motion } from "motion/react";
import type { ReactNode } from "react";

/** An amount in reais, counted up. */
export function Money({ value }: { value: Dec }) {
  return <NumberTicker value={value.toFixed()} format={(text) => formatBrl(Dec.from(text))} />;
}

/** The tone of a signed result: nothing for zero. */
export function toneOf(value: Dec | null): "positive" | "negative" | undefined {
  if (value === null || value.isZero()) return undefined;
  return value.isPositive() ? "positive" : "negative";
}

export interface FigureSpec {
  label: string;
  value: ReactNode;
  tone?: "positive" | "negative" | "warning" | undefined;
  note?: ReactNode;
}

/**
 * Figures in a row that wraps by itself: as many as fit side by side, each at least `min` wide and never
 * narrower than its own value (an amount stays on one line), so a figure that does not fit takes the next
 * line instead of breaking its value. The row is also the container the values shrink against on very narrow
 * screens (`Figure`).
 */
export function FigureRow({ figures, min = "8rem" }: { figures: readonly FigureSpec[]; min?: string }) {
  return (
    <div className={cn("@container flex flex-wrap gap-x-6 gap-y-4")} data-min={min}>
      {figures.map((figure) => (
        // Basis `min`, automatic minimum width: the value's own width is the floor, the rest is shared.
        <div key={figure.label} className="max-w-full" style={{ flex: `1 1 ${min}` }}>
          <Figure
            label={figure.label}
            value={figure.value}
            {...(figure.tone ? { tone: figure.tone } : {})}
            {...(figure.note ? { note: figure.note } : {})}
          />
        </div>
      ))}
    </div>
  );
}

/** A titled card of figures (Caixa, Resultado por competência, Patrimônio). */
export function FigureCard({
  title,
  caption,
  figures,
  index = 0,
  min,
}: {
  title: string;
  caption?: ReactNode;
  figures: readonly FigureSpec[];
  /** Position in the page, for the staggered entry. */
  index?: number;
  min?: string;
}) {
  const preset = useMotionPreset();
  return (
    <motion.section
      initial={preset.enter.initial}
      animate={preset.enter.animate}
      transition={{ ...preset.enter.transition, delay: preset.reduce ? 0 : 0.06 * index }}
      aria-label={title}
      className="min-w-0 rounded-xl border border-separator bg-raised p-5 shadow-sm"
    >
      <h2 className="text-headline font-semibold text-text">{title}</h2>
      {caption ? <p className="mt-0.5 mb-4 text-caption text-secondary">{caption}</p> : <div className="mb-4" />}
      <FigureRow figures={figures} {...(min ? { min } : {})} />
    </motion.section>
  );
}
