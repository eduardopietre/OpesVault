/**
 * Flows between screens (docs/16 §5): a notice, a calendar day or a report row takes the user to the
 * object and, when asked, to the action ("pay this bill"). The target page reads `ref` and `act` from
 * its URL with `useReveal()`, shows the object and runs the action once.
 */
import { useMatch, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { PAGES } from "../pages.tsx";

export interface RevealSearch {
  /** Id of the object to show (an operation, a card, a bill month "card-id:2026-10"…). */
  ref?: string;
  /** Action to start on it (page-defined: "pagar", "editar", "nova"…). */
  act?: string;
}

/** Route search validation: only the two known keys, as strings. */
export function revealSearch(search: Record<string, unknown>): RevealSearch {
  const out: RevealSearch = {};
  if (typeof search["ref"] === "string" && search["ref"]) out.ref = search["ref"];
  if (typeof search["act"] === "string" && search["act"]) out.act = search["act"];
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
 * a back navigation does not repeat the action.
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
    callback.current(search.ref, search.act);
    void navigate({ to: pathname, search: {}, replace: true });
  }, [search.ref, search.act, pathname, own, navigate]);
}
