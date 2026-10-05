/**
 * Keyboard shortcuts of the shell (docs/18 §5.1). Ctrl+1…9 belong to the browser, so sections use Alt+1…9
 * and `g` followed by a letter. Single keys never fire while the user types or while a dialog is open.
 */
import { useEffect, useRef } from "react";

export interface ShortcutHandlers {
  palette(): void;
  help(): void;
  goIndex(index: number): void;
  goLetter(letter: string): boolean;
  undo(): void;
  redo(): void;
  toggleSidebar(): void;
  lock(): void;
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
