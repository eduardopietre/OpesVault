/** Every hook between modules ported in parallel is connected once the registry is loaded. */
import { describe, expect, it } from "vitest";

import { Ledger } from "../src/domain/ledger.ts";
import { updateSettings } from "../src/domain/settings.ts";
import { clientFromSettings } from "../src/importing/ai_suggestions.ts";

describe("wiring", () => {
  it("the AI follows the project's settings", () => {
    const ledger = Ledger.new("x");
    const transport = () => Promise.reject(new Error("no network in tests"));
    expect(clientFromSettings(ledger, transport)).toBeNull();
    updateSettings(ledger, { ai_enabled: true, ai_model: "qwen" });
    expect(clientFromSettings(ledger, transport)).not.toBeNull();
  });
});
