/** Small layout hooks: media queries, the responsive band and an element's width. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefCallback } from "react";
import { BAND, bandOf, type Band } from "./tokens.ts";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** The viewport band (phone < 640 ≤ tablet < 1024 ≤ medium < 1440 ≤ wide). */
export function useBand(): Band {
  const wide = useMediaQuery(`(min-width: ${BAND.wide}px)`);
  const medium = useMediaQuery(`(min-width: ${BAND.medium}px)`);
  const tablet = useMediaQuery(`(min-width: ${BAND.tablet}px)`);
  if (wide) return "wide";
  if (medium) return "medium";
  if (tablet) return "tablet";
  return typeof window === "undefined" ? "wide" : bandOf(0);
}

/** The content-box width of an element, followed with a ResizeObserver (0 before the first layout). */
export function useElementWidth<T extends HTMLElement>(): [RefCallback<T>, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    setWidth(node.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.current.observe(node);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}
