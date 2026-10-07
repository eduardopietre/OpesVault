/**
 * Keyboard shortcuts of the shell (docs/18 §5.1). Ctrl+1…9 belong to the browser, so sections use Alt+1…9
 * and `g` followed by a letter. Single keys never fire while the user types or while a dialog is open.
 *
 * `SHORTCUTS` is the one list of what the keys do: the "Atalhos de teclado" sheet (`?`), the help (F1), the
 * tooltips and `aria-keyshortcuts` of the buttons all read it, and a test presses each shell entry's keys.
 */
import { useEffect, useRef } from "react";

export interface ShortcutHandlers {
  palette(): void;
  help(): void;
  shortcuts(): void;
  goIndex(index: number): void;
  goLetter(letter: string): boolean;
  undo(): void;
  redo(): void;
  toggleSidebar(): void;
  lock(): void;
}

export type ShortcutId = keyof ShortcutHandlers | "month" | "livro-search" | "livro-mark" | "import" | "approve";

export interface Shortcut {
  id: ShortcutId;
  /** As shown: "Ctrl+K". The first is the one tooltips show. */
  keys: readonly string[];
  /** What it does, in the user's words. */
  what: string;
  /** For `aria-keyshortcuts` ("Control+K Meta+K"), when the keys name one action a button also does. */
  aria?: string;
  /** Where it works: the whole app, or one screen (by page title). */
  where: "geral" | string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: "palette",
    keys: ["Ctrl+K", "⌘K"],
    aria: "Control+K Meta+K",
    what: "Buscar seção ou comando (paleta de comandos)",
    where: "geral",
  },
  { id: "goIndex", keys: ["Alt+1 … Alt+9"], what: "Ir para a seção correspondente", where: "geral" },
  { id: "goLetter", keys: ["g e uma letra"], what: "Ir para qualquer seção (veja as letras abaixo)", where: "geral" },
  { id: "undo", keys: ["Ctrl+Z"], aria: "Control+Z Meta+Z", what: "Desfazer a última ação", where: "geral" },
  {
    id: "redo",
    keys: ["Ctrl+Shift+Z", "Ctrl+Y"],
    aria: "Control+Shift+Z Control+Y Meta+Shift+Z",
    what: "Refazer o que foi desfeito",
    where: "geral",
  },
  {
    id: "toggleSidebar",
    keys: ["Ctrl+Shift+B"],
    aria: "Control+Shift+B Meta+Shift+B",
    what: "Mostrar ou recolher a barra lateral",
    where: "geral",
  },
  {
    id: "lock",
    keys: ["Ctrl+Shift+L"],
    aria: "Control+Shift+L Meta+Shift+L",
    what: "Bloquear o projeto agora",
    where: "geral",
  },
  {
    id: "month",
    keys: ["Alt+←", "Alt+→"],
    what: "Mês anterior ou próximo, no seletor de mês",
    where: "geral",
  },
  { id: "help", keys: ["F1"], aria: "F1", what: "Ajuda desta tela", where: "geral" },
  { id: "shortcuts", keys: ["?"], aria: "?", what: "Esta lista de atalhos", where: "geral" },
  { id: "livro-search", keys: ["/"], what: "Buscar nos lançamentos", where: "Livro financeiro" },
  { id: "livro-mark", keys: ["Espaço"], what: "Marcar ou desmarcar a linha atual", where: "Livro financeiro" },
  { id: "import", keys: ["Ctrl+I"], what: "Escolher arquivos para importar", where: "Importar e revisar" },
  {
    id: "approve",
    keys: ["Ctrl+Enter", "Ctrl+Shift+Enter"],
    what: "Aprovar os itens marcados / todos os prontos",
    where: "Importar e revisar",
  },
];

export function shortcut(id: ShortcutId): Shortcut {
  const found = SHORTCUTS.find((item) => item.id === id);
  if (!found) throw new Error(`unknown shortcut ${id}`);
  return found;
}

/** The keys as one line ("Ctrl+Shift+Z ou Ctrl+Y"). */
export function keysText(item: Shortcut): string {
  return item.keys.join(" ou ");
}

/** The tooltip text of a shortcut ("Ctrl+Z"): its first keys. */
export function tip(id: ShortcutId): string {
  return shortcut(id).keys[0] ?? "";
}

export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(type);
}

function dialogOpen(): boolean {
  return document.querySelector("dialog[open]") !== null;
}

/** The sequence window for `g` + letter. */
const SEQUENCE_MS = 1500;

export function useShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    if (!enabled) return;
    let pendingG = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const h = latest.current;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !event.altKey && key === "k") {
        event.preventDefault();
        if (!dialogOpen()) h.palette();
        return;
      }
      if (dialogOpen()) return;
      if (event.key === "F1") {
        event.preventDefault();
        h.help();
        return;
      }
      if (event.altKey && !mod && /^Digit[1-9]$/.test(event.code)) {
        event.preventDefault();
        h.goIndex(Number(event.code.slice(5)) - 1);
        return;
      }
      if (mod && event.shiftKey && key === "b") {
        event.preventDefault();
        h.toggleSidebar();
        return;
      }
      if (mod && event.shiftKey && key === "l") {
        event.preventDefault();
        h.lock();
        return;
      }
      const typing = isTyping(event.target);
      if (mod && !event.altKey && (key === "z" || key === "y")) {
        // Inside a text field, the browser's own text undo applies.
        if (typing) return;
        event.preventDefault();
        if (key === "y" || event.shiftKey) h.redo();
        else h.undo();
        return;
      }
      if (typing || mod || event.altKey) return;
      // "?" is Shift+/ on some layouts and another key on others: the character is what counts.
      if (event.key === "?") {
        pendingG = 0;
        event.preventDefault();
        h.shortcuts();
        return;
      }
      if (key === "g" && !event.shiftKey) {
        pendingG = event.timeStamp || Date.now();
        return;
      }
      if (pendingG && (event.timeStamp || Date.now()) - pendingG < SEQUENCE_MS && /^[a-z]$/.test(key)) {
        pendingG = 0;
        if (h.goLetter(key)) event.preventDefault();
        return;
      }
      pendingG = 0;
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
