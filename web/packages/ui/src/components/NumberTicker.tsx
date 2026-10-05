/**
 * A key figure that counts up to its value on entry (docs/18 §5.2, Visão geral). The value is a decimal
 * string and every frame is computed with BigInt, so the last frame is exactly the value given; a user who
 * asks for less motion sees the value at once. Screen readers get only the final value.
 */
import { animate } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { fromScaled, formatDecimalBR, isDecimalText, scaleOf, toScaled } from "../format.ts";
import { useReduceMotion } from "../motion.tsx";
import { DURATION } from "../tokens.ts";

export interface NumberTickerProps {
  /** Canonical decimal string ("-1234.56"). */
  value: string;
  /** Turns a decimal string into display text (defaults to "1.234,56"). */
  format?: (decimal: string) => string;
  /** Count from this value (defaults to zero on first show, then from the previous value). */
  from?: string;
  durationMs?: number;
  className?: string;
}

const STEPS = 1_000_000n;

export function NumberTicker({ value, format, from, durationMs, className }: NumberTickerProps) {
  const show = format ?? ((text: string) => formatDecimalBR(text));
  const reduce = useReduceMotion();
  const previous = useRef(from ?? "0");
  const [display, setDisplay] = useState(() => (reduce || !isDecimalText(value) ? value : (from ?? "0")));

  useEffect(() => {
    const start = previous.current;
    previous.current = value;
    if (reduce || !isDecimalText(value) || !isDecimalText(start) || start === value) {
      setDisplay(value);
      return;
    }
    const scale = Math.max(scaleOf(value), scaleOf(start));
    const a = toScaled(start, scale);
    const b = toScaled(value, scale);
    let display = start;
    const controls = animate(0, 1, {
      duration: (durationMs ?? 900) / 1000 || DURATION.slow,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (progress) => {
        // Progress is a fraction of the way; the amount itself stays an exact scaled integer.
        const t = BigInt(Math.round(progress * Number(STEPS)));
        display = fromScaled(a + ((b - a) * t) / STEPS, scale);
        setDisplay(display);
      },
      onComplete: () => {
        display = value;
        setDisplay(value);
      },
    });
    return () => {
      controls.stop();
      // Interrupted (a re-run in development, or a new value): the next run starts where this one did.
      if (display !== value) previous.current = start;
    };
  }, [value, reduce, durationMs]);

  return (
    <span className={className}>
      <span aria-hidden="true" className="tabular-nums">
        {show(display)}
      </span>
      <span className="sr-only">{show(value)}</span>
    </span>
  );
}
