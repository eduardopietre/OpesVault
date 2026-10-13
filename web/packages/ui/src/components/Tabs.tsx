/**
 * Tabs separate different objects (Contas, Cartões, Faturas…), never views of the same values: a chart and
 * its table go together in a ChartPanel (docs/16 §4 rule 9). The indicator slides to the chosen tab.
 *
 * When the tabs do not fit (a phone), the row scrolls sideways: the side with more tabs fades out and shows an
 * arrow that scrolls it, and the chosen tab is always brought into view. The arrow keys move between tabs as
 * usual, so the arrows are for the pointer only (out of the Tab order).
 */
import { motion } from "motion/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Tabs as RadixTabs } from "radix-ui";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { useMotionPreset } from "../motion.tsx";
import { badgeText } from "./layout.tsx";

export interface TabItem {
  id: string;
  label: string;
  count?: number;
  content: ReactNode;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  value: string;
  onValueChange: (id: string) => void;
  /** Accessible name of the tab list ("Cadastros da conta"). */
  label: string;
  className?: string | undefined;
}

interface Edges {
  /** Tabs hidden before the visible ones. */
  start: boolean;
  /** Tabs hidden after them. */
  end: boolean;
}

/** Width of the faded edge where more tabs are. */
const FADE = "40px";

function maskOf({ start, end }: Edges): string | undefined {
  if (!start && !end) return undefined;
  const from = start ? `transparent 0, black ${FADE}` : "black 0";
  const to = end ? `black calc(100% - ${FADE}), transparent 100%` : "black 100%";
  return `linear-gradient(to right, ${from}, ${to})`;
}

export function Tabs({ tabs, value, onValueChange, label, className }: TabsProps) {
  const group = useId();
  const preset = useMotionPreset();
  const list = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>({ start: false, end: false });

  const measure = useCallback(() => {
    const element = list.current;
    if (!element) return;
    const start = element.scrollLeft > 1;
    const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setEdges((previous) => (previous.start === start && previous.end === end ? previous : { start, end }));
  }, []);

  useEffect(() => {
    measure();
    const element = list.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, tabs.length]);

  // The chosen tab in view, also when another screen chose it (a link to Integrantes).
  useEffect(() => {
    const element = list.current;
    const active = element?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (!element || !active) return;
    const left = active.offsetLeft - element.offsetLeft;
    const right = left + active.offsetWidth;
    const margin = 40;
    if (left - margin < element.scrollLeft) element.scrollLeft = Math.max(0, left - margin);
    else if (right + margin > element.scrollLeft + element.clientWidth) {
      element.scrollLeft = right + margin - element.clientWidth;
    }
    measure();
  }, [value, measure]);

  const scroll = (direction: -1 | 1) => {
    const element = list.current;
    if (!element) return;
    element.scrollBy({ left: direction * element.clientWidth * 0.7, behavior: preset.reduce ? "auto" : "smooth" });
  };

  const arrow = "absolute top-0 z-10 grid h-9 w-7 place-items-center text-secondary hover:text-text [&_svg]:size-4";
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange} className={cn("min-w-0", className)}>
      <div className="relative">
        <RadixTabs.List
          ref={list}
          aria-label={label}
          onScroll={measure}
          style={{ maskImage: maskOf(edges), WebkitMaskImage: maskOf(edges) }}
          className="flex max-w-full gap-1 overflow-x-auto border-b border-separator [scrollbar-width:none]"
        >
          {tabs.map((tab) => {
            const active = tab.id === value;
            return (
              <RadixTabs.Trigger
                key={tab.id}
                value={tab.id}
                className={cn(
                  "relative inline-flex h-9 shrink-0 items-center gap-1.5 px-3 text-body outline-offset-[-2px] transition-colors",
                  active ? "font-semibold text-text" : "text-secondary hover:text-text",
                )}
              >
                {tab.label}
                {tab.count ? (
                  <span className="rounded-full bg-selection-inactive px-1.5 text-caption font-semibold text-text">
                    {badgeText(tab.count)}
                  </span>
                ) : null}
                {active ? (
                  <motion.span
                    layoutId={`${group}-indicator`}
                    aria-hidden="true"
                    className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent"
                    transition={preset.spring("indicator")}
                  />
                ) : null}
              </RadixTabs.Trigger>
            );
          })}
        </RadixTabs.List>
        {edges.start ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Abas anteriores"
            title="Abas anteriores"
            onClick={() => scroll(-1)}
            className={cn(arrow, "left-0 justify-items-start")}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
        ) : null}
        {edges.end ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Mais abas"
            title="Mais abas"
            onClick={() => scroll(1)}
            className={cn(arrow, "right-0 justify-items-end")}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {tabs.map((tab) => (
        <RadixTabs.Content key={tab.id} value={tab.id} className="mt-4 rounded-md">
          {tab.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
