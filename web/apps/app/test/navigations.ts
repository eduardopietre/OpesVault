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
