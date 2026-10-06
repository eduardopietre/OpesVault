/**
 * Where a popover, a menu or a select list renders. A modal <dialog> sits in the browser's top layer, so
 * anything portaled to <body> would be drawn under it and could not be clicked: inside a dialog the portal
 * must target the dialog itself.
 */
import { useCallback, useState } from "react";

/**
 * A ref for the control that opens the popover and the element to portal into: the <dialog> holding the
 * control, or undefined (Radix then uses <body>) when it is not inside one.
 */
export function usePortalContainer(): [(anchor: HTMLElement | null) => void, HTMLElement | undefined] {
  const [container, setContainer] = useState<HTMLElement | undefined>(undefined);
  const ref = useCallback((anchor: HTMLElement | null) => {
    const dialog = anchor?.closest<HTMLElement>("dialog") ?? undefined;
    setContainer((current) => (current === dialog ? current : dialog));
  }, []);
  return [ref, container];
}
