/**
 * Loads every module that registers persisted entity kinds or ledger guards. Port of `registry.py`.
 *
 * Opening a project must know all kinds. Each area keeps its own explicit list (`kinds.ts`) so
 * the areas can grow independently; `test/registry.test.ts` checks the expected kinds exist.
 */
import "./domain/kinds.ts";
import "./importing/kinds.ts";
import "./investments/kinds.ts";
import "./tax/kinds.ts";
