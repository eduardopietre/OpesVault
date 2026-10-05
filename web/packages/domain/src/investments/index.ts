/** Public modules of this area, one namespace per module. */
export * as model from "./model.ts";
export * as service from "./service.ts";
export * as performance from "./performance.ts";
export * as returns from "./returns.ts";
export * as trades from "./trades.ts";
export * as simulation from "./simulation.ts";
export * as profile from "./profile.ts";
export * as notes from "./notes.ts";
export * as benchmarks from "./benchmarks.ts";
// TODO(W5-integration): `domain/banking.ts` belongs in the domain area's index; exported here until the areas are joined.
export * as banking from "../domain/banking.ts";
