/**
 * One dialog at a time: `show` mounts the next with a fresh key, `close` only clears `open`, so the dialog leaves
 * with its content (the exit animation still has it) and the next one starts clean.
 */
import { useCallback, useState } from "react";

export interface DialogSlot<T> {
  /** The last dialog shown; kept after `close` until the next `show`. */
  spec: T | null;
  open: boolean;
  /** Changes with every `show`: the dialog's `key`. */
  key: number;
  show: (spec: T) => void;
  close: () => void;
}

export function useDialog<T>(): DialogSlot<T> {
  const [state, setState] = useState<{ spec: T | null; open: boolean; key: number }>({
    spec: null,
    open: false,
    key: 0,
  });
  const show = useCallback((spec: T) => setState((s) => ({ spec, open: true, key: s.key + 1 })), []);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  return { ...state, show, close };
}
