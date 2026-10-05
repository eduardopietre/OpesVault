/**
 * Loads every module that registers persisted entity kinds or ledger guards. Port of `registry.py`.
 *
 * Opening a project must know all kinds; the list is explicit and tested, so no tool can drop an
 * import that only exists for its side effects.
 */
export const MODULES = [] as const;

// Each module registers its kinds and guards when imported; the imports are below, in the order
// of MODULES. Add a module to both lists.
