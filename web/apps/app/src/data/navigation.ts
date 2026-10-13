/**
 * Flows between screens (docs/16 §5): a notice, a calendar day or a report row takes the user to the
 * object and, when asked, to the action ("pay this bill"). The target page reads `ref` and `act` from
 * its URL with `useReveal()`, shows the object and runs the action once.
 */
import { useMatch, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PAGES } from "../pages.tsx";

export interface RevealSearch {
  /** Id of the object to show (an operation, a card, a bill month "card-id:2026-10"…). */
  ref?: string;
  /** Action to start on it (page-defined: "pagar", "editar", "nova"…). */
  act?: string;
  /** The tab of a screen with tabs (Contas e cartões, Configurações): it stays in the address (`useTab`). */
  aba?: string;
}

/** Route search validation: only the known keys, as strings. */
export function revealSearch(search: Record<string, unknown>): RevealSearch {
  const out: RevealSearch = {};
  if (typeof search["ref"] === "string" && search["ref"]) out.ref = search["ref"];
  if (typeof search["act"] === "string" && search["act"]) out.act = search["act"];
  if (typeof search["aba"] === "string" && search["aba"]) out.aba = search["aba"];
  return out;
}

/** Goes to a destination by page id, optionally to an object and an action there. */
export function useGoTo(): (pageId: string, target?: RevealSearch) => void {
  const navigate = useNavigate();
  return useCallback(
    (pageId, target = {}) => {
      const page = PAGES.find((p) => p.id === pageId);
      if (!page) throw new Error(`unknown page ${pageId}`);
      void navigate({ to: page.path, search: target });
    },
    [navigate],
  );
}

/**
 * Calls `onReveal(ref, act)` once for each new `ref`/`act` in the URL, then clears them so a reload or
 * a back navigation does not repeat the action. The tab (`aba`) stays.
 */
export function useReveal(onReveal: (ref: string | undefined, act: string | undefined) => void): void {
  const search = useRouterState({ select: (state) => state.location.search as RevealSearch });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const handled = useRef<string | null>(null);
  // The route this page is rendered in: a link leaving it for another page (still mounted while the
  // router transitions) carries a `ref` meant for the destination, which this page must not consume.
  const own = useMatch({ strict: false, select: (match) => match.pathname });
  const callback = useRef(onReveal);
  useEffect(() => {
    callback.current = onReveal;
  });
  useEffect(() => {
    if (pathname !== own) return;
    const key = `${search.ref ?? ""}|${search.act ?? ""}`;
    if (key === "|") {
      // The URL was cleared: the same link followed again later is a new request.
      handled.current = null;
      return;
    }
    if (handled.current === key) return;
    handled.current = key;
    // Cleared first (keeping the tab), so a navigation the action itself makes (a tab, another page) wins.
    void navigate({ to: pathname, search: search.aba ? { aba: search.aba } : {}, replace: true });
    callback.current(search.ref, search.act);
  }, [search.ref, search.act, search.aba, pathname, own, navigate]);
}

/** The tab last shown on each screen, per opened project: coming back to the screen shows it again. */
const lastTabs = new WeakMap<object, Map<string, string>>();

/**
 * The chosen tab of a screen with tabs, kept in the address (`?aba=`): a reload, the back button and a link
 * (`goTo(page, { aba })`) show that tab. Without `aba` in the address, the tab last shown on this screen while the
 * project is open comes back, or the first one. `owner` is the opened project (the memory goes with it).
 */
export function useTab<T extends string>(owner: object, ids: readonly T[], fallback: T): [T, (tab: T) => void] {
  const search = useRouterState({ select: (state) => state.location.search as RevealSearch });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const own = useMatch({ strict: false, select: (match) => match.pathname });
  const navigate = useNavigate();
  const valid = (id: string | undefined): T | null =>
    (ids as readonly string[]).includes(id ?? "") ? (id as T) : null;
  const memory = useMemo(() => {
    const found = lastTabs.get(owner) ?? new Map<string, string>();
    lastTabs.set(owner, found);
    return found;
  }, [owner]);
  // The tab chosen here, used while the address names none (a link without `aba`, the sidebar).
  const [chosen, setChosen] = useState<T>(() => valid(memory.get(own)) ?? fallback);
  const inAddress = valid(search.aba);
  // The address wins: the back and forward buttons and a link to a tab show it.
  const tab = inAddress ?? chosen;

  const choose = useCallback(
    (next: T) => {
      setChosen(next);
      // Replacing the entry: the back button leaves the screen instead of walking its tabs.
      void navigate({ to: own, search: next === fallback ? {} : { aba: next }, replace: true });
    },
    [navigate, own, fallback],
  );

  // Remember the tab for the next visit; an address without it gets it back (the first tab needs none), once a
  // link's `ref`/`act` was consumed (`useReveal` clears them).
  const linking = Boolean(search.ref || search.act);
  useEffect(() => {
    memory.set(own, tab);
    if (pathname === own && !linking && inAddress === null && tab !== fallback) {
      void navigate({ to: own, search: { aba: tab }, replace: true });
    }
  }, [tab, inAddress, linking, pathname, own, fallback, memory, navigate]);
  return [tab, choose];
}
