/**
 * Menus (docs/16 §3 `menu_button`): secondary commands grouped without hiding them. Radix DropdownMenu in
 * non-modal mode (the modal mode locks scrolling with injected styles that the CSP refuses). The same entries
 * make the context menu of a table row (`ContextMenuAt`, opened by `DataTable`'s `rowMenu`), with submenus.
 */
import { ChevronDown, ChevronRight, Check } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../cn.ts";
import { Button, type ButtonVariant } from "./Button.tsx";
import { usePortalContainer } from "./portal.ts";

export type MenuEntry =
  | {
      kind?: "item";
      id: string;
      label: string;
      onSelect: () => void;
      icon?: ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
    }
  | { kind: "separator"; id: string }
  /** A cascade: its entries open beside it (hover, click or the right arrow key). */
  | { kind: "submenu"; id: string; label: string; items: readonly MenuEntry[]; icon?: ReactNode; disabled?: boolean }
  | { kind: "label"; id: string; label: string }
  | {
      kind: "radio";
      id: string;
      label: string;
      value: string;
      options: readonly { value: string; label: string }[];
      onChange: (value: string) => void;
    };

const itemBase =
  "relative flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-body outline-none " +
  "data-[disabled]:text-tertiary [&_svg]:size-4";
const itemClass = `${itemBase} text-text data-[highlighted]:bg-selection data-[highlighted]:text-accent-text`;
/**
 * A destructive command is red, and stays red when highlighted, on its own soft red, so it is never mistaken for
 * another. It never gets the normal text color too: in the generated CSS that one would win.
 */
const dangerClass = `${itemBase} text-negative data-[highlighted]:bg-negative-soft data-[highlighted]:text-negative`;
const contentClass =
  "z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[200px] max-w-[min(320px,calc(100vw-16px))] " +
  "overflow-y-auto origin-[var(--radix-dropdown-menu-content-transform-origin)] rounded-lg border border-separator " +
  "bg-raised p-1 shadow-lg data-[state=open]:animate-[ov-menu-in_var(--ov-duration-fast)_var(--ov-ease-enter)]";

/** The entries of a menu or of a submenu, recursively. */
function Entries({ items, container }: { items: readonly MenuEntry[]; container?: HTMLElement | undefined }) {
  return items.map((entry) => {
    if (entry.kind === "separator") {
      return <DropdownMenu.Separator key={entry.id} className="mx-1 my-1 h-px bg-separator" />;
    }
    if (entry.kind === "label") {
      return (
        <DropdownMenu.Label key={entry.id} className="px-2 pt-2 pb-1 text-caption font-semibold text-secondary">
          {entry.label}
        </DropdownMenu.Label>
      );
    }
    if (entry.kind === "radio") {
      return (
        <DropdownMenu.Group key={entry.id}>
          <DropdownMenu.Label className="px-2 pt-2 pb-1 text-caption font-semibold text-secondary">
            {entry.label}
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={entry.value} onValueChange={entry.onChange}>
            {entry.options.map((option) => (
              <DropdownMenu.RadioItem key={option.value} value={option.value} className={cn(itemClass, "pl-7")}>
                <DropdownMenu.ItemIndicator className="absolute left-2 inline-flex">
                  <Check aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
                {option.label}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Group>
      );
    }
    if (entry.kind === "submenu") {
      return (
        <DropdownMenu.Sub key={entry.id}>
          <DropdownMenu.SubTrigger
            disabled={entry.disabled ?? false}
            className={cn(itemClass, "data-[state=open]:bg-hover")}
          >
            {entry.icon ? <span aria-hidden="true">{entry.icon}</span> : null}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            <ChevronRight aria-hidden="true" className="ml-2 text-secondary in-data-[highlighted]:text-accent-text" />
          </DropdownMenu.SubTrigger>
          <DropdownMenu.Portal {...(container ? { container } : {})}>
            <DropdownMenu.SubContent sideOffset={4} alignOffset={-4} collisionPadding={8} className={contentClass}>
              <Entries items={entry.items} container={container} />
            </DropdownMenu.SubContent>
          </DropdownMenu.Portal>
        </DropdownMenu.Sub>
      );
    }
    return (
      <DropdownMenu.Item
        key={entry.id}
        onSelect={entry.onSelect}
        disabled={entry.disabled ?? false}
        className={entry.danger ? dangerClass : itemClass}
      >
        {entry.icon ? <span aria-hidden="true">{entry.icon}</span> : null}
        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
        {entry.shortcut ? (
          <kbd className="ml-4 font-sans text-caption text-secondary in-data-[highlighted]:text-accent-text">
            {entry.shortcut}
          </kbd>
        ) : null}
      </DropdownMenu.Item>
    );
  });
}

export function MenuContent({
  items,
  align = "end",
  container,
}: {
  items: readonly MenuEntry[];
  align?: "start" | "end";
  /** Where to render (the open <dialog> that holds the trigger); the body by default. */
  container?: HTMLElement | undefined;
}) {
  return (
    <DropdownMenu.Portal {...(container ? { container } : {})}>
      {/* A long menu (the Livro's commands on a phone) scrolls inside the room the screen has; being focusable,
          its scrolling also works from the keyboard (axe: scrollable-region-focusable). */}
      <DropdownMenu.Content align={align} sideOffset={6} collisionPadding={8} tabIndex={0} className={contentClass}>
        <Entries items={items} container={container} />
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

/**
 * A menu open at a point of the screen: the context menu of a table row. An invisible anchor at the point is the
 * trigger, so the menu flips and shifts to stay on screen like any other; on closing the focus is left to
 * `onClose` (the table takes it back) instead of going to the anchor.
 */
export function ContextMenuAt({
  x,
  y,
  items,
  onClose,
  label,
  container,
}: {
  x: number;
  y: number;
  items: readonly MenuEntry[];
  onClose: () => void;
  /** The accessible name of the menu ("Ações de CDB Banco X"). */
  label: string;
  container?: HTMLElement | undefined;
}) {
  return (
    <DropdownMenu.Root open modal={false} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DropdownMenu.Trigger asChild>
        <span
          aria-hidden="true"
          tabIndex={-1}
          className="pointer-events-none fixed size-0"
          style={{ left: x, top: y }}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal {...(container ? { container } : {})}>
        <DropdownMenu.Content
          align="start"
          side="bottom"
          sideOffset={2}
          collisionPadding={8}
          tabIndex={0}
          aria-label={label}
          // The anchor is an invisible point, not a name: without this, Radix names the menu after it.
          aria-labelledby={undefined}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className={contentClass}
        >
          <Entries items={items} container={container} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export interface MenuButtonProps {
  label: string;
  items: readonly MenuEntry[];
  variant?: ButtonVariant;
  icon?: ReactNode;
  align?: "start" | "end";
  /** Custom trigger (an avatar, an icon button); it must be a button with an accessible name. */
  trigger?: ReactNode;
}

/** A button that opens a menu of commands ("Mais", "Exportar"). */
export function MenuButton({ label, items, variant = "secondary", icon, align = "end", trigger }: MenuButtonProps) {
  const [anchorRef, container] = usePortalContainer();
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        {trigger ?? (
          <Button
            ref={anchorRef}
            variant={variant}
            icon={icon}
            trailing={<ChevronDown aria-hidden="true" className="size-4 opacity-70" />}
          >
            {label}
          </Button>
        )}
      </DropdownMenu.Trigger>
      <MenuContent items={items} align={align} container={container} />
    </DropdownMenu.Root>
  );
}

/** Shorthand for the desktop's `menu_button(label, actions)`. */
export function menuButton(label: string, items: readonly MenuEntry[], variant: ButtonVariant = "secondary") {
  return <MenuButton label={label} items={items} variant={variant} />;
}
