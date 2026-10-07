/**
 * The places a router was asked to go, in order, with their search. A destination page consumes its `ref` as soon
 * as it mounts (`useReveal` replaces the address), so a test that reads `router.state.location` after the page
 * changed may already find it cleared. Following a link is checked here instead: it navigated, with that `ref`.
 */
import type { AnyRouter } from "@tanstack/react-router";
import { waitFor } from "@testing-library/react";
import { expect } from "vitest";

export interface Navigation {
  readonly pathname: string;
  readonly search: Record<string, unknown>;
}

export function navigations(router: AnyRouter): Navigation[] {
  const seen: Navigation[] = [];
  router.subscribe("onBeforeNavigate", (event) => {
    seen.push({ pathname: event.toLocation.pathname, search: event.toLocation.search as Record<string, unknown> });
  });
  return seen;
}

/** Waits until the router went to `pathname` with a search holding `search` (exactly `search` when `exact`). */
export async function wentTo(
  seen: readonly Navigation[],
  pathname: string,
  search: Record<string, unknown>,
  { exact = false }: { exact?: boolean } = {},
): Promise<void> {
  await waitFor(() =>
    expect(seen).toContainEqual({ pathname, search: exact ? search : expect.objectContaining(search) }),
  );
}

/**
 * Waits until the address settles on exactly `search`: what a page keeps in it (the month, a year) or `{}` once
 * the destination consumed `ref`/`act`. It checks an effect on the address, never where a link went: that is
 * `wentTo`, since the destination may clear the address before the test reads it.
 */
export async function addressSettles(router: AnyRouter, search: Record<string, unknown>): Promise<void> {
  await waitFor(() => expect(router.state.location.search).toEqual(search));
}

/** The search the address holds now, for checks `addressSettles` does not cover (a key that must be gone). */
export function searchNow(router: AnyRouter): Record<string, unknown> {
  return router.state.location.search as Record<string, unknown>;
}
