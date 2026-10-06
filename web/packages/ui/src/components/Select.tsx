/**
 * Select and Combobox: choosing among options by id. The value is always the option's id (a string), never
 * an object: an id read back from the project must find its option (CLAUDE.md, `select_combo`).
 *
 * Built on Radix Popover with an ARIA listbox; Radix Select injects a <style> element that the CSP refuses.
 */
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { searchKey } from "../format.ts";
import { Field, inputClass } from "./fields.tsx";
import { usePortalContainer } from "./portal.ts";

export interface SelectOption {
  id: string;
  label: string;
  /** A second line (a bank code, an account's owner). */
  description?: string;
  /** Extra words that find the option when typing (codes, old names). */
  keywords?: string;
  disabled?: boolean;
}

/** The option with this id, comparing values (never identity). */
export function optionById(options: readonly SelectOption[], id: string | null | undefined): SelectOption | undefined {
  if (id === null || id === undefined) return undefined;
  return options.find((option) => option.id === id);
}

function OptionList({
  id,
  options,
  value,
  active,
  onActive,
  onPick,
  label,
  emptyText,
}: {
  id: string;
  options: readonly SelectOption[];
  value: string | null;
  active: number;
  onActive: (index: number) => void;
  onPick: (option: SelectOption) => void;
  label: string;
  emptyText: string;
}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  if (options.length === 0) {
    return <p className="px-3 py-2 text-body text-secondary">{emptyText}</p>;
  }
  return (
    <ul ref={list} id={id} role="listbox" aria-label={label} className="max-h-72 overflow-y-auto p-1">
      {options.map((option, index) => {
        const selected = option.id === value;
        return (
          <li
            key={option.id}
            id={`${id}-o${index}`}
            data-index={index}
            role="option"
            aria-selected={selected}
            aria-disabled={option.disabled || undefined}
            onPointerMove={() => onActive(index)}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => !option.disabled && onPick(option)}
            className={cn(
              "flex cursor-default items-start gap-2 rounded-md px-2 py-1.5 text-body",
              index === active ? "bg-selection text-accent-text" : "text-text",
              option.disabled && "text-tertiary",
            )}
          >
            <Check
              aria-hidden="true"
              className={cn("mt-0.5 size-4 shrink-0", selected ? "opacity-100" : "opacity-0")}
            />
            <span className="min-w-0">
              <span className="block truncate">{option.label}</span>
              {option.description ? (
                <span
                  className={cn(
                    "block truncate text-caption",
                    index === active ? "text-accent-text" : "text-secondary",
                  )}
                >
                  {option.description}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function nextEnabled(options: readonly SelectOption[], from: number, step: 1 | -1): number {
  if (options.length === 0) return -1;
  let index = from;
  for (let tries = 0; tries < options.length; tries++) {
    index = Math.min(options.length - 1, Math.max(0, index + step));
    if (!options[index]?.disabled) return index;
    if (index === 0 || index === options.length - 1) break;
  }
  return from;
}

const popoverClass =
  "z-50 w-[var(--radix-popover-trigger-width)] min-w-[200px] max-w-[calc(100vw-16px)] rounded-lg border border-separator bg-raised shadow-lg " +
  "data-[state=open]:animate-[ov-menu-in_var(--ov-duration-fast)_var(--ov-ease-enter)]";

export interface SelectProps {
  label: string;
  options: readonly SelectOption[];
  value: string | null;
  onChange: (id: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  error?: string | null | undefined;
  hideLabel?: boolean;
  disabled?: boolean;
  className?: string | undefined;
}

export function Select({
  label,
  options,
  value,
  onChange,
  placeholder = "Escolha…",
  hint,
  error,
  hideLabel,
  disabled,
  className,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const typed = useRef({ text: "", at: 0 });
  const current = optionById(options, value);
  const [anchorRef, container] = usePortalContainer();

  const show = (start?: number) => {
    setActive(
      start ??
        Math.max(
          0,
          options.findIndex((option) => option.id === value),
        ),
    );
    setOpen(true);
  };
  const pick = (option: SelectOption) => {
    onChange(option.id);
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        show();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => nextEnabled(options, index, event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[active];
      if (option && !option.disabled) pick(option);
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      setOpen(false);
    } else if (event.key.length === 1) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + event.key, at: now };
      const key = searchKey(typed.current.text);
      const found = options.findIndex((option) => searchKey(option.label).startsWith(key));
      if (found >= 0) setActive(found);
    }
  };

  return (
    <Field label={label} hint={hint} error={error} hideLabel={hideLabel ?? false} className={className}>
      {({ id, describedBy, invalid }) => (
        <Popover.Root open={open} onOpenChange={(next) => (next ? show() : setOpen(false))}>
          <Popover.Trigger asChild>
            <button
              ref={anchorRef}
              id={id}
              type="button"
              role="combobox"
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              aria-activedescendant={open && active >= 0 ? `${listId}-o${active}` : undefined}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              disabled={disabled}
              onKeyDown={onKeyDown}
              className={cn(inputClass, "flex items-center justify-between gap-2 text-left")}
            >
              <span className={cn("min-w-0 truncate", !current && "text-secondary")}>
                {current?.label ?? placeholder}
              </span>
              <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-secondary" />
            </button>
          </Popover.Trigger>
          <Popover.Portal {...(container ? { container } : {})}>
            <Popover.Content
              align="start"
              sideOffset={4}
              collisionPadding={8}
              onOpenAutoFocus={(event) => event.preventDefault()}
              className={popoverClass}
            >
              <OptionList
                id={listId}
                label={label}
                options={options}
                value={value}
                active={active}
                onActive={setActive}
                onPick={pick}
                emptyText="Nenhuma opção."
              />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </Field>
  );
}

export interface ComboboxProps extends Omit<SelectProps, "placeholder"> {
  placeholder?: string;
  emptyText?: string;
}

/** A searchable select: typing a code or part of the name narrows the options (docs/16 `catalog_widgets`). */
export function Combobox({
  label,
  options,
  value,
  onChange,
  placeholder = "Digite para buscar…",
  emptyText = "Nada encontrado.",
  hint,
  error,
  hideLabel,
  disabled,
  className,
}: ComboboxProps) {
  const current = optionById(options, value);
  const [anchorRef, container] = usePortalContainer();
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const filtered = useMemo(() => {
    if (!query) return options;
    const key = searchKey(query);
    return options.filter((option) =>
      searchKey(`${option.label} ${option.description ?? ""} ${option.keywords ?? ""}`).includes(key),
    );
  }, [options, query]);

  const pick = (option: SelectOption) => {
    onChange(option.id);
    setQuery(null);
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      setActive((index) => nextEnabled(filtered, index, event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      const option = filtered[active];
      if (option && !option.disabled) pick(option);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setQuery(null);
    }
  };

  return (
    <Field label={label} hint={hint} error={error} hideLabel={hideLabel ?? false} className={className}>
      {({ id, describedBy, invalid }) => (
        <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
          <Popover.Anchor asChild>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-secondary"
              />
              <input
                ref={anchorRef}
                id={id}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                aria-activedescendant={open && filtered[active] ? `${listId}-o${active}` : undefined}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                disabled={disabled}
                autoComplete="off"
                placeholder={placeholder}
                value={query ?? current?.label ?? ""}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                  setOpen(true);
                }}
                onFocus={(event) => event.target.select()}
                onClick={() => setOpen(true)}
                onBlur={() => {
                  setQuery(null);
                  setOpen(false);
                }}
                onKeyDown={onKeyDown}
                className={cn(inputClass, "pl-9")}
              />
            </div>
          </Popover.Anchor>
          <Popover.Portal {...(container ? { container } : {})}>
            <Popover.Content
              align="start"
              sideOffset={4}
              collisionPadding={8}
              onOpenAutoFocus={(event) => event.preventDefault()}
              onInteractOutside={(event) => {
                if (event.target instanceof Node && document.getElementById(id)?.contains(event.target)) {
                  event.preventDefault();
                }
              }}
              className={cn(popoverClass, "w-[var(--radix-popover-anchor-width)]")}
            >
              <OptionList
                id={listId}
                label={label}
                options={filtered}
                value={value}
                active={active}
                onActive={setActive}
                onPick={pick}
                emptyText={emptyText}
              />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </Field>
  );
}
