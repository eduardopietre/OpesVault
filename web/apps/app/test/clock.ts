/**
 * Pins the clock's date for the tests of a file. Tests that write fixed dates (forecasts on "06/10/2026",
 * a goal created on "2026-10-06") must not depend on the day they run; only `Date` is faked, so timers,
 * user events and `waitFor` keep real time.
 */
import { afterEach, beforeEach, vi } from "vitest";

export function pinToday(year: number, month: number, day: number): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(year, month - 1, day, 12));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
