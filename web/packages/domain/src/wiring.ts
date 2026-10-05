/**
 * Connects modules that call each other through hooks (they were ported in parallel and would
 * otherwise import each other in a cycle). Loaded by `registry.ts`, so opening a project wires
 * everything; `test/wiring.test.ts` checks every hook is set.
 */
import { findPlanForInstallment } from "./domain/cards.ts";
import { aliases, keyOf, merchantOf, nameMerchant } from "./domain/merchants.ts";
import { getSettings } from "./domain/settings.ts";
import { registerMerchants } from "./importing/ai_merchants.ts";
import { registerSettingsReader } from "./importing/ai_suggestions.ts";
import { registerInstallmentPlanFinder } from "./importing/checks.ts";

registerInstallmentPlanFinder(findPlanForInstallment);
registerSettingsReader(getSettings);
registerMerchants({
  approvedKeys: (ledger) => [...aliases(ledger).values()].map((a) => a.key),
  keyOf,
  merchantOf,
  nameMerchant: (ledger, description, name, origin) => nameMerchant(ledger, description, name, origin),
});
