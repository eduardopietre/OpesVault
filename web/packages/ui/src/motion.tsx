/**
 * Motion policy (docs/18 §5.2): only transform and opacity animate, with the token durations, and a user who
 * asks for less motion gets no movement at all, only short fades. Components take their transitions from
 * here instead of writing numbers inline.
 */
import { MotionConfig, useReducedMotionConfig, type TargetAndTransition, type Transition } from "motion/react";
import type { ReactNode } from "react";
import { DURATION, EASE, SPRING } from "./tokens.ts";

/** Wraps the app: Motion itself drops transforms and layout animations when the system asks for less motion. */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

/** True when the user asked for less motion (the system setting, or a MotionConfig that forces it). */
export function useReduceMotion(): boolean {
  return useReducedMotionConfig() ?? false;
}

const fadeOnly: Transition = { duration: DURATION.fast, ease: EASE.standard };

interface Preset {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
  transition: Transition;
}

export interface MotionPreset {
  reduce: boolean;
  /** A short fade, for anything that appears in place. */
  fade: Preset;
  /** Content entering: slide up a little and fade (pages, rows, cards). */
  enter: Preset;
  /** A transition for the given spring, or a short fade when motion is reduced. */
  spring: (name: keyof typeof SPRING) => Transition;
}

export function useMotionPreset(): MotionPreset {
  const reduce = useReduceMotion();
  return presetFor(reduce);
}

export function presetFor(reduce: boolean): MotionPreset {
  const fade: Preset = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: fadeOnly,
  };
  return {
    reduce,
    fade,
    enter: reduce
      ? fade
      : {
          initial: { opacity: 0, y: 8 },
          animate: { opacity: 1, y: 0 },
          exit: { opacity: 0, y: -4 },
          transition: { duration: DURATION.base, ease: EASE.enter },
        },
    spring: (name) => (reduce ? fadeOnly : SPRING[name]),
  };
}
