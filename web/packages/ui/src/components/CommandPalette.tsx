/**
 * The command palette (docs/18 §5.1, Ctrl+K / ⌘K): every destination and command of the app, found by
 * typing part of the name without accents. It replaces the desktop's menus; each entry shows its shortcut.
 */
import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { searchKey } from "../format.ts";
import { Overlay } from "./Overlay.tsx";

export interface Command {
  id: string;
  label: string;
  /** Group heading ("Ir para", "Projeto", "Editar", "Exibir", "Ajuda"). */
  group: string;
  run: () => void;
  shortcut?: string;
  keywords?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: readonly Command[];
  placeholder?: string;
}

export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const words = searchKey(query).split(/\s+/).filter(Boolean);
  if (!words.length) return commands.filter((command) => !command.disabled);
  return commands.filter((command) => {
    if (command.disabled) return false;
    const haystack = searchKey(`${command.label} ${command.group} ${command.keywords ?? ""}`);
    return words.every((word) => haystack.includes(word));
  });
}

export function CommandPalette({ open, onOpenChange, commands, placeholder }: CommandPaletteProps) {
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      placement="top"
      label="Paleta de comandos"
      panelClassName="overflow-hidden"
    >
      <PaletteBody commands={commands} placeholder={placeholder} onDone={() => onOpenChange(false)} />
    </Overlay>
  );
}

function PaletteBody({
  commands,
  placeholder,
  onDone,
}: {
  commands: readonly Command[];
  placeholder: string | undefined;
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const groups = useMemo(() => {
    const map = new Map<string, Command[]>();
    for (const command of results) map.set(command.group, [...(map.get(command.group) ?? []), command]);
    return [...map.entries()];
  }, [results]);
  const current = Math.min(active, results.length - 1);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    onDone();
    // After the palette closes, so focus and navigation land on the page.
    setTimeout(command.run, 0);
  };

  let index = -1;
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-separator px-4">
        <Search aria-hidden="true" className="size-4 shrink-0 text-secondary" />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results[current] ? `${listId}-${current}` : undefined}
          aria-label="Buscar comando ou seção"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder ?? "Buscar seção ou comando…"}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive(Math.min(current + 1, results.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive(Math.max(current - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              run(results[current]);
            }
          }}
          className="h-12 min-w-0 flex-1 bg-transparent text-headline text-text outline-none placeholder:text-tertiary"
        />
        <kbd className="hidden rounded border border-separator px-1.5 font-sans text-caption text-secondary tablet:inline">
          Esc
        </kbd>
      </div>
      <div ref={list} id={listId} role="listbox" aria-label="Resultados" className="min-h-0 flex-1 overflow-y-auto p-2">
        {results.length === 0 ? (
          <p className="px-3 py-6 text-center text-body text-secondary">Nada encontrado para “{query}”.</p>
        ) : (
          groups.map(([group, items]) => (
            <div key={group} role="group" aria-label={group} className="mb-1">
              <div aria-hidden="true" className="px-3 pt-2 pb-1 text-caption font-semibold text-secondary">
                {group}
              </div>
              {items.map((command) => {
                index += 1;
                const mine = index;
                const selected = mine === current;
                return (
                  <div
                    key={command.id}
                    id={`${listId}-${mine}`}
                    data-index={mine}
                    role="option"
                    aria-selected={selected}
                    onPointerMove={() => setActive(mine)}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => run(command)}
                    className={cn(
                      "flex h-10 cursor-default items-center gap-3 rounded-md px-3 text-body",
                      selected ? "bg-selection text-accent-text" : "text-text",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn("shrink-0 [&_svg]:size-4", selected ? "text-accent-text" : "text-secondary")}
                    >
                      {command.icon}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    {command.shortcut ? (
                      <kbd
                        className={cn(
                          "hidden shrink-0 font-sans text-caption tablet:inline",
                          selected ? "text-accent-text" : "text-secondary",
                        )}
                      >
                        {command.shortcut}
                      </kbd>
                    ) : null}
                    {selected ? <CornerDownLeft aria-hidden="true" className="size-4 shrink-0" /> : null}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
