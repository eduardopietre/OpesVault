/** The lazy calculation: after the first paint, kept by the ledger's version, repeated only when its inputs change. */
import { AccountSubtype, AccountType, LedgerAccountSchema, Dec, makeDate } from "@opesvault/domain";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceProvider } from "../../src/data/react.tsx";
import { Workspace } from "../../src/data/workspace.ts";
import { useDeferred } from "../../src/pages/investimentos/deferred.ts";
import { solveXirr } from "../../src/pages/investimentos/xirr_client.ts";

function setup() {
  const workspace = Workspace.fromRecords([], "Teste");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WorkspaceProvider workspace={workspace}>{children}</WorkspaceProvider>
  );
  return { workspace, wrapper };
}

describe("useDeferred", () => {
  it("is pending first, then has the value, and the same inputs are not computed again", async () => {
    const { wrapper } = setup();
    const compute = vi.fn(() => 42);
    const { result, rerender } = renderHook(({ key }) => useDeferred(key, compute), {
      wrapper,
      initialProps: { key: "a" },
    });
    expect(result.current).toEqual({ value: null, pending: true });
    await waitFor(() => expect(result.current).toEqual({ value: 42, pending: false }));
    rerender({ key: "a" });
    rerender({ key: "a" });
    expect(compute).toHaveBeenCalledTimes(1);
    // another key is another calculation; going back to the first is served from the cache
    rerender({ key: "b" });
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(result.current.value).toBe(42));
    expect(compute).toHaveBeenCalledTimes(2);
    rerender({ key: "a" });
    expect(result.current).toEqual({ value: 42, pending: false });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("is computed again after the ledger changes, never served from before the change", async () => {
    const { workspace, wrapper } = setup();
    let calls = 0;
    const { result } = renderHook(() => useDeferred("k", (ledger) => `${++calls}:${ledger.accounts.size}`), {
      wrapper,
    });
    await waitFor(() => expect(result.current.value).toBe("1:14"));
    act(() => {
      workspace.act((ledger) =>
        ledger.addAccount(
          LedgerAccountSchema.parse({ name: "Caixa", type: AccountType.ASSET, subtype: AccountSubtype.CHECKING }),
        ),
      );
    });
    await waitFor(() => expect(result.current.value).toBe("2:15"));
  });

  it("does nothing while disabled, and waits for a promise", async () => {
    const { wrapper } = setup();
    const compute = vi.fn(async () => "later");
    const { result, rerender } = renderHook(({ on }) => useDeferred("k", compute, on), {
      wrapper,
      initialProps: { on: false },
    });
    expect(result.current).toEqual({ value: null, pending: false });
    expect(compute).not.toHaveBeenCalled();
    rerender({ on: true });
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(result.current.value).toBe("later"));
  });
});

describe("solveXirr", () => {
  it("solves on the calling thread where there is no worker, to the domain's rate", async () => {
    // -1000 then 1100 a year later: 10%
    const [rate, reason] = await solveXirr([
      [makeDate(2025, 1, 1), Dec.from(-1000)],
      [makeDate(2026, 1, 1), Dec.from(1100)],
    ]);
    expect(reason).toBe("");
    expect(rate!.sub(Dec.from("0.1")).abs().lt(Dec.from("1e-9"))).toBe(true);
    // all flows out: no solution, with the reason
    const [none, why] = await solveXirr([[makeDate(2025, 1, 1), Dec.from(-1000)]]);
    expect(none).toBeNull();
    expect(why).toBe("É preciso ao menos um fluxo negativo e um positivo.");
  });
});
