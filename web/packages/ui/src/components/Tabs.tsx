/**
 * Tabs separate different objects (Contas, Cartões, Faturas…), never views of the same values: a chart and
 * its table go together in a ChartPanel (docs/16 §4 rule 9). The indicator slides to the chosen tab.
 */
import { motion } from "motion/react";
import { Tabs as RadixTabs } from "radix-ui";
import { useId, type ReactNode } from "react";
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

export function Tabs({ tabs, value, onValueChange, label, className }: TabsProps) {
  const group = useId();
  const preset = useMotionPreset();
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange} className={cn("min-w-0", className)}>
      <RadixTabs.List
        aria-label={label}
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
      {tabs.map((tab) => (
        <RadixTabs.Content key={tab.id} value={tab.id} className="mt-4 rounded-md">
          {tab.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
