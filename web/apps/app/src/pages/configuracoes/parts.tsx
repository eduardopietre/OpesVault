/** Small pieces every section of Configurações shares: where a setting lives, a titled block, a note. */
import { cn } from "@opesvault/ui";
import { Laptop, Users } from "lucide-react";
import type { ReactNode } from "react";

export type Scope = "project" | "device";

/**
 * Says where a setting lives, in words and with an icon (never color alone): a project setting is the same
 * for everyone and syncs; a device preference is only this browser's, written at once (docs/16 §4 rule 8).
 */
export function ScopeBadge({ scope }: { scope: Scope }) {
  const project = scope === "project";
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-caption font-medium",
        project ? "bg-accent-soft text-accent" : "bg-selection-inactive text-text",
      )}
    >
      {project ? <Users aria-hidden="true" className="size-3" /> : <Laptop aria-hidden="true" className="size-3" />}
      {project ? "Vale para todo o projeto" : "Vale só neste aparelho"}
    </span>
  );
}

export interface BlockProps {
  title: string;
  scope?: Scope;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons that belong to the block. */
  actions?: ReactNode;
  className?: string;
}

/** A titled block of one tab: the title and where it lives, the explanation, the controls, the buttons. */
export function Block({ title, scope, description, children, actions, className }: BlockProps) {
  return (
    <section className={cn("min-w-0 rounded-lg border border-separator bg-raised p-4 tablet:p-5", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="text-headline font-semibold">{title}</h2>
        {scope ? <ScopeBadge scope={scope} /> : null}
      </div>
      {description ? <div className="mt-1.5 max-w-[68ch] text-body text-secondary">{description}</div> : null}
      {children ? <div className="mt-4 flex flex-col gap-4">{children}</div> : null}
      {actions ? <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div> : null}
    </section>
  );
}

/** A caption under a control. */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("max-w-[68ch] text-caption text-secondary", className)}>{children}</p>;
}

/** The tab's column: a readable width, blocks stacked. */
export function TabColumn({ children }: { children: ReactNode }) {
  return <div className="flex max-w-[880px] flex-col gap-4">{children}</div>;
}
