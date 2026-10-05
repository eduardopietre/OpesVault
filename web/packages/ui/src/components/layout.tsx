/**
 * Page structure (docs/16 §3): PageHeader, EmptyState, Section, Adaptive, ElidedText, Badge and Skeleton.
 */
import { motion } from "motion/react";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn.ts";
import { useMotionPreset } from "../motion.tsx";

export interface PageHeaderProps {
  title: string;
  /** The context line: a count, a state or the active filters ("Mês aberto", "12 lançamentos"). */
  context?: ReactNode;
  /** The screen's one primary action. A separate slot so a header can never hold two. */
  primary?: ReactNode;
  /** Secondary actions and menus; they wrap below the title when there is no room. */
  actions?: ReactNode;
  /** Something that sits between title and actions on wide screens, such as the MonthPicker. */
  children?: ReactNode;
  className?: string;
}

/** Title ("where am I"), context and actions; at most one primary action (docs/16 §1). */
export function PageHeader({ title, context, primary, actions, children, className }: PageHeaderProps) {
  return (
    <header className={cn("ov-page-header", className)}>
      <div className="ov-page-header-row">
        <div className="min-w-0">
          <h1 className="text-title font-semibold tracking-[-0.01em] text-text">{title}</h1>
          {context ? <div className="mt-1 text-body text-secondary">{context}</div> : null}
        </div>
        {children || primary || actions ? (
          <div className="ov-page-header-actions flex min-w-0 flex-wrap items-center gap-2">
            {children ? <div className="mr-4 flex flex-wrap items-center gap-2">{children}</div> : null}
            {actions}
            {primary}
          </div>
        ) : null}
      </div>
    </header>
  );
}

export interface EmptyStateProps {
  title: string;
  /** What the area is, why it is empty and what to do next. */
  description: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Heading level for the title (2 inside a page, 1 when it is the whole screen). */
  level?: 1 | 2 | 3;
}

export function EmptyState({ title, description, icon, actions, className, level = 2 }: EmptyStateProps) {
  const preset = useMotionPreset();
  const Heading = `h${level}` as "h1" | "h2" | "h3";
  return (
    <motion.div
      {...preset.enter}
      className={cn("mx-auto flex max-w-[560px] flex-col items-center px-4 py-12 text-center", className)}
    >
      {icon ? (
        <div
          aria-hidden="true"
          className="mb-4 grid size-14 place-items-center rounded-xl bg-accent-soft text-accent [&_svg]:size-7"
        >
          {icon}
        </div>
      ) : null}
      <Heading className="text-headline font-semibold text-text">{title}</Heading>
      <div className="mt-2 text-body text-secondary">{description}</div>
      {actions ? <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
    </motion.div>
  );
}

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: string;
  description?: ReactNode;
  /** The group's actions, on the title line at the right (docs/16 §3 `Section.add_actions`). */
  actions?: ReactNode;
  children?: ReactNode;
  level?: 2 | 3;
}

/** A titled group without a box: title, description and actions on one line, content below. */
export function Section({ title, description, actions, children, className, level = 2, ...rest }: SectionProps) {
  const Heading = `h${level}` as "h2" | "h3";
  return (
    <section className={cn("min-w-0", className)} {...rest}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <Heading className="text-headline font-semibold text-text">{title}</Heading>
          {description ? <p className="mt-0.5 text-caption text-secondary">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export type AdaptiveAt = 720 | 1000 | 1200 | 1300 | 1400;

export interface AdaptiveProps {
  children: ReactNode;
  /** Container width from which the parts sit side by side (docs/16 §4 rule 5 table). */
  at?: AdaptiveAt;
  /** Column template when wide, e.g. "3fr 2fr" (chart and values) or "5fr 2fr" (overview column). */
  columns?: string;
  /** The first part goes on top when stacked and to the right when wide (a side column). */
  firstRight?: boolean;
  gap?: number;
  className?: string;
}

/**
 * Related parts side by side when the container has room, stacked otherwise. A container query decides,
 * so the wide arrangement never forces the window to be wide: the minimum width is the stacked form.
 */
export function Adaptive({ children, at = 1000, columns = "1fr 1fr", firstRight, gap, className }: AdaptiveProps) {
  const style = {
    "--ov-adaptive-cols": columns
      .split(/\s+/)
      .map((part) => `minmax(0, ${part})`)
      .join(" "),
    ...(gap !== undefined ? { "--ov-adaptive-gap": `${gap}px` } : {}),
  } as CSSProperties;
  return (
    <div className={cn("ov-adaptive", className)} data-at={at} data-first-right={firstRight || undefined}>
      <div className="ov-adaptive-grid" style={style}>
        {children}
      </div>
    </div>
  );
}

export interface ElidedTextProps extends HTMLAttributes<HTMLSpanElement> {
  children: string;
}

/** One line with a user's name (project, file, account): cut with "…", the full text in the tooltip. */
export function ElidedText({ children, className, ...rest }: ElidedTextProps) {
  return (
    <span title={children} className={cn("block min-w-0 truncate", className)} {...rest}>
      {children}
    </span>
  );
}

export type BadgeTone = "neutral" | "accent" | "positive" | "negative" | "warning";

const badgeTones: Record<BadgeTone, string> = {
  neutral: "bg-selection-inactive text-text",
  accent: "bg-accent-fill text-accent-text",
  positive: "bg-positive-soft text-positive",
  negative: "bg-negative-soft text-negative",
  warning: "bg-warning-soft text-warning",
};

export interface BadgeProps {
  /** A count (shown as "999+" past 999) or a short text. */
  children: ReactNode;
  tone?: BadgeTone;
  /** What the badge means for screen readers ("3 itens pedem atenção"). */
  label?: string;
  className?: string;
}

export function badgeText(count: number): string {
  return count < 1000 ? String(count) : "999+";
}

/** An attention count or a short state label; its meaning is in text, never in color alone. */
export function Badge({ children, tone = "neutral", label, className }: BadgeProps) {
  const content = typeof children === "number" ? badgeText(children) : children;
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-caption font-semibold",
        badgeTones[tone],
        className,
      )}
      {...(label ? { "aria-label": label, role: "img" } : {})}
    >
      {content}
    </span>
  );
}

export interface SkeletonProps {
  className?: string;
  /** Several text lines, the last one shorter. */
  lines?: number;
}

/** Placeholder while data is decrypted or synced. Hidden from screen readers; pair with a busy region. */
export function Skeleton({ className, lines }: SkeletonProps) {
  if (lines && lines > 1) {
    return (
      <div aria-hidden="true" className={cn("flex flex-col gap-2", className)}>
        {Array.from({ length: lines }, (_, index) => (
          <div key={index} className={cn("ov-skeleton h-3.5 rounded-sm", index === lines - 1 ? "w-3/5" : "w-full")} />
        ))}
      </div>
    );
  }
  return <div aria-hidden="true" className={cn("ov-skeleton h-4 rounded-sm", className)} />;
}

/** A labelled key figure (docs/16 `Figures`): caption above, value below. */
export function Figure({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: ReactNode;
  tone?: "positive" | "negative" | "warning";
  note?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-caption text-secondary">{label}</div>
      <div
        className={cn(
          "mt-1 text-figure font-semibold tracking-[-0.02em]",
          tone === "positive" && "text-positive",
          tone === "negative" && "text-negative",
          tone === "warning" && "text-warning",
          !tone && "text-text",
        )}
      >
        {value}
      </div>
      {note ? <div className="mt-0.5 text-caption text-secondary">{note}</div> : null}
    </div>
  );
}
