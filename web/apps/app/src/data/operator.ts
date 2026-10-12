/**
 * Who is operating when a project opens (docs/01: the operator's name goes into the history).
 *
 * The order of `members` follows how the records came back from the cache (opaque ids), which is
 * arbitrary, so it never decides. In order: the member chosen earlier in this tab for this project,
 * the member named after the account (the one created with the project), then the first by name.
 * The choice is kept in memory only: a member id is project data and never goes to localStorage
 * (docs/19 §8).
 */
import { compareLabels } from "@opesvault/ui";
import type { Member } from "../services/types.ts";

/** The members who can operate: the active ones, by name, as the top bar lists them. */
export function activeMembers(ledger: {
  readonly members: { values(): Iterable<{ id: string; name: string; active: boolean }> };
}): Member[] {
  return [...ledger.members.values()]
    .filter((m) => m.active)
    .map((m) => ({ id: m.id, name: m.name }))
    .sort(byName);
}

const byName = (a: Member, b: Member) => compareLabels(a.name, b.name) || (a.id < b.id ? -1 : 1);

export function sameMembers(a: readonly Member[], b: readonly Member[]): boolean {
  return a.length === b.length && a.every((member, i) => member.id === b[i]?.id && member.name === b[i]?.name);
}

export function defaultOperator(
  members: readonly Member[],
  accountName: string | null | undefined,
  remembered?: string | null,
): string | null {
  if (remembered && members.some((member) => member.id === remembered)) return remembered;
  const first = accountName?.trim().split(/\s+/)[0];
  if (first) {
    const own = members.filter((member) => compareLabels(member.name.trim(), first) === 0);
    if (own.length === 1) return own[0]!.id;
  }
  return [...members].sort(byName)[0]?.id ?? null;
}
