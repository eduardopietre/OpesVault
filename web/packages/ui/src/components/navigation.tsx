/**
 * Navigation (docs/16 §1): the sidebar with destinations grouped by section and Settings pinned below,
 * attention counts that screen readers also hear, and the phone's bottom bar with four destinations and
 * "Mais". Items are real links (`href`), so they open in a new tab too; a plain click navigates in place.
 */
import { motion } from "motion/react";
import { MoreHorizontal } from "lucide-react";
import { useId, type MouseEvent, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { ariaKeyShortcuts } from "./Button.tsx";
import { useMotionPreset } from "../motion.tsx";
import { badgeText } from "./layout.tsx";

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: ReactNode;
  /** Items that need attention (imports waiting review…). */
  count?: number;
  /** Shortcut shown in the tooltip ("Alt+1"). */
  shortcut?: string;
}

export interface NavGroup {
  label: string;
  items: readonly NavItem[];
}

function plainClick(event: MouseEvent) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function accessibleName(item: NavItem) {
  return item.count ? `${item.label}, ${item.count} itens pedem atenção` : item.label;
}

function SidebarLink({
  item,
  selected,
  collapsed,
  onNavigate,
  onPreload,
  indicator,
}: {
  item: NavItem;
  selected: boolean;
  collapsed: boolean;
  onNavigate: (id: string) => void;
  onPreload: ((id: string) => void) | undefined;
  indicator: string;
}) {
  const preset = useMotionPreset();
  return (
    <li>
      <a
        href={item.href}
        aria-current={selected ? "page" : undefined}
        aria-label={collapsed || item.count ? accessibleName(item) : undefined}
        aria-keyshortcuts={item.shortcut ? ariaKeyShortcuts(item.shortcut) : undefined}
        title={
          collapsed
            ? item.shortcut
              ? `${item.label} (${item.shortcut})`
              : item.label
            : item.shortcut
              ? `${item.label} (${item.shortcut})`
              : undefined
        }
        onClick={(event) => {
          if (!plainClick(event)) return;
          event.preventDefault();
          onNavigate(item.id);
        }}
        onPointerEnter={onPreload ? () => onPreload(item.id) : undefined}
        onFocus={onPreload ? () => onPreload(item.id) : undefined}
        className={cn(
          "relative flex h-8 items-center gap-2.5 rounded-md text-body text-text transition-colors hover:bg-hover",
          collapsed ? "w-10 justify-center" : "px-2.5",
          selected && "font-semibold hover:bg-transparent",
        )}
      >
        {selected ? (
          <motion.span
            layoutId={indicator}
            aria-hidden="true"
            className="absolute inset-0 rounded-md bg-selection-inactive"
            transition={preset.spring("indicator")}
          />
        ) : null}
        <span
          aria-hidden="true"
          className={cn("relative shrink-0 [&_svg]:size-4", selected ? "text-text" : "text-secondary")}
        >
          {item.icon}
        </span>
        <span className={cn("relative min-w-0 flex-1 truncate", collapsed && "sr-only")}>{item.label}</span>
        {item.count ? (
          collapsed ? (
            <span aria-hidden="true" className="absolute top-1 right-1 size-2 rounded-full bg-accent" />
          ) : (
            <span
              aria-hidden="true"
              className="relative inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-selection-inactive px-1.5 text-caption font-semibold text-text"
            >
              {badgeText(item.count)}
            </span>
          )
        ) : null}
      </a>
    </li>
  );
}

export interface SidebarProps {
  groups: readonly NavGroup[];
  /** Pinned below the destinations: about the app, not the money (Configurações). */
  footer?: readonly NavItem[];
  selectedId: string | null;
  onNavigate: (id: string) => void;
  /** Called when the pointer rests on a destination or focus reaches it: start loading its code. */
  onPreload?: (id: string) => void;
  /** Icon rail (medium screens, when the user collapses it). */
  collapsed?: boolean;
  /** Something above the groups (the drawer shows the project there). */
  header?: ReactNode;
  className?: string | undefined;
  label?: string;
}

export function Sidebar({
  groups,
  footer = [],
  selectedId,
  onNavigate,
  onPreload,
  collapsed = false,
  header,
  className,
  label = "Seções",
}: SidebarProps) {
  const indicator = useId();
  return (
    <nav aria-label={label} className={cn("flex h-full min-h-0 flex-col bg-window", className)}>
      {header}
      <div className={cn("min-h-0 flex-1 overflow-y-auto pb-2", collapsed ? "px-2" : "px-3")}>
        {groups.map((group) => (
          <div key={group.label} className="mt-3 first:mt-2">
            {collapsed ? (
              <div aria-hidden="true" className="mx-2 my-2 h-px bg-separator" />
            ) : (
              <h2 className="px-2.5 pb-1 text-caption font-semibold text-secondary">{group.label}</h2>
            )}
            <ul
              className={cn("flex flex-col gap-0.5", collapsed && "items-center")}
              aria-label={collapsed ? group.label : undefined}
            >
              {group.items.map((item) => (
                <SidebarLink
                  key={item.id}
                  item={item}
                  selected={item.id === selectedId}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                  onPreload={onPreload}
                  indicator={indicator}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
      {footer.length ? (
        <ul
          className={cn(
            "flex flex-col gap-0.5 border-t border-separator py-2",
            collapsed ? "items-center px-2" : "px-3",
          )}
        >
          {footer.map((item) => (
            <SidebarLink
              key={item.id}
              item={item}
              selected={item.id === selectedId}
              collapsed={collapsed}
              onNavigate={onNavigate}
              onPreload={onPreload}
              indicator={indicator}
            />
          ))}
        </ul>
      ) : null}
    </nav>
  );
}

export interface BottomNavProps {
  /** Four destinations; the rest live under "Mais". */
  items: readonly NavItem[];
  selectedId: string | null;
  onNavigate: (id: string) => void;
  onMore: () => void;
  /** As in the sidebar: start loading a destination's code before the tap. */
  onPreload?: (id: string) => void;
  /** True when the current page is one of those under "Mais". */
  moreSelected?: boolean;
  /** Attention count of the pages under "Mais". */
  moreCount?: number;
  className?: string | undefined;
}

export function BottomNav({
  items,
  selectedId,
  onNavigate,
  onMore,
  onPreload,
  moreSelected,
  moreCount,
  className,
}: BottomNavProps) {
  const indicator = useId();
  const preset = useMotionPreset();
  const cell = (selected: boolean) =>
    cn(
      "relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-caption leading-tight",
      selected ? "font-semibold text-accent" : "text-secondary",
    );
  const pill = (selected: boolean) =>
    selected ? (
      <motion.span
        layoutId={indicator}
        aria-hidden="true"
        className="absolute top-1 h-7 w-14 rounded-full bg-accent-soft"
        transition={preset.spring("indicator")}
      />
    ) : null;
  return (
    <nav
      aria-label="Navegação principal"
      className={cn("border-t border-separator bg-window/95 pb-[env(safe-area-inset-bottom)] backdrop-blur", className)}
    >
      <ul className="flex h-16 items-stretch gap-1 px-2 py-1">
        {items.map((item) => {
          const selected = item.id === selectedId;
          return (
            <li key={item.id} className="flex min-w-0 flex-1">
              <a
                href={item.href}
                aria-current={selected ? "page" : undefined}
                aria-label={item.count ? accessibleName(item) : undefined}
                onClick={(event) => {
                  if (!plainClick(event)) return;
                  event.preventDefault();
                  onNavigate(item.id);
                }}
                onPointerEnter={onPreload ? () => onPreload(item.id) : undefined}
                onTouchStart={onPreload ? () => onPreload(item.id) : undefined}
                onFocus={onPreload ? () => onPreload(item.id) : undefined}
                className={cell(selected)}
              >
                {pill(selected)}
                <span aria-hidden="true" className="relative mt-1 grid h-7 place-items-center [&_svg]:size-5">
                  {item.icon}
                  {item.count ? <span className="absolute -top-0.5 -right-2 size-2 rounded-full bg-accent" /> : null}
                </span>
                <span className="relative w-full truncate text-center">{item.label}</span>
              </a>
            </li>
          );
        })}
        <li className="flex min-w-0 flex-1">
          <button
            type="button"
            onClick={onMore}
            aria-label={moreCount ? `Mais seções, ${moreCount} itens pedem atenção` : "Mais seções"}
            aria-haspopup="dialog"
            className={cell(Boolean(moreSelected))}
          >
            {pill(Boolean(moreSelected))}
            <span aria-hidden="true" className="relative mt-1 grid h-7 place-items-center [&_svg]:size-5">
              <MoreHorizontal />
              {moreCount ? <span className="absolute -top-0.5 -right-2 size-2 rounded-full bg-accent" /> : null}
            </span>
            <span aria-hidden="true" className="relative">
              Mais
            </span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
