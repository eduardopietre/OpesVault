/**
 * Menus (docs/16 §3 `menu_button`): secondary commands grouped without hiding them. Radix DropdownMenu in
 * non-modal mode (the modal mode locks scrolling with injected styles that the CSP refuses).
 */
import { ChevronDown, Check } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../cn.ts";
import { Button, type ButtonVariant } from "./Button.tsx";

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
  | { kind: "label"; id: string; label: string }
  | {
      kind: "radio";
      id: string;
      label: string;
      value: string;
      options: readonly { value: string; label: string }[];
      onChange: (value: string) => void;
    };

const itemClass =
  "relative flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-body text-text outline-none " +
  "data-[highlighted]:bg-selection data-[highlighted]:text-accent-text data-[disabled]:text-tertiary [&_svg]:size-4";

export function MenuContent({ items, align = "end" }: { items: readonly MenuEntry[]; align?: "start" | "end" }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className="z-50 min-w-[200px] max-w-[min(320px,calc(100vw-16px))] origin-[var(--radix-dropdown-menu-content-transform-origin)] rounded-lg border border-separator bg-raised p-1 shadow-lg data-[state=open]:animate-[ov-menu-in_var(--ov-duration-fast)_var(--ov-ease-enter)]"
      >
        {items.map((entry) => {
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
          return (
            <DropdownMenu.Item
              key={entry.id}
              onSelect={entry.onSelect}
              disabled={entry.disabled ?? false}
              className={cn(itemClass, entry.danger && "text-negative")}
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
        })}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
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
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        {trigger ?? (
          <Button
            variant={variant}
            icon={icon}
            trailing={<ChevronDown aria-hidden="true" className="size-4 opacity-70" />}
          >
            {label}
          </Button>
        )}
      </DropdownMenu.Trigger>
      <MenuContent items={items} align={align} />
    </DropdownMenu.Root>
  );
}

/** Shorthand for the desktop's `menu_button(label, actions)`. */
export function menuButton(label: string, items: readonly MenuEntry[], variant: ButtonVariant = "secondary") {
  return <MenuButton label={label} items={items} variant={variant} />;
}
