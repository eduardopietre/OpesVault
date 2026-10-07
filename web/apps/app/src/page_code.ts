/**
 * The code of each destination (pages/<page id>/index.tsx, exporting `Page`), loaded when first needed. The
 * shell starts loading a destination as soon as the pointer rests on its link or the keyboard reaches it, so the
 * click shows the page at once (docs/18 §5.1). Loading code never touches the project's data.
 */
import type { ComponentType } from "react";

const SCREENS = import.meta.glob<{ Page: ComponentType }>("./pages/*/index.tsx");

/** The loader of a destination's screen; undefined while the destination has no folder yet. */
export function screenLoader(id: string): (() => Promise<{ Page: ComponentType }>) | undefined {
  return SCREENS[`./pages/${id}/index.tsx`];
}

const started = new Map<string, Promise<unknown>>();

/**
 * Starts loading a destination's code once (idempotent). A failed load (offline, a new version deployed) is
 * forgotten, so a later hover tries again and the click falls back to the router's own loading.
 */
export function preloadPage(id: string): Promise<unknown> | undefined {
  const known = started.get(id);
  if (known) return known;
  const load = screenLoader(id);
  if (!load) return undefined;
  const promise = load().catch(() => {
    started.delete(id);
  });
  started.set(id, promise);
  return promise;
}
