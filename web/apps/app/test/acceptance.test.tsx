/**
 * Acceptance tests of docs/08 whose web form needed a test of its own (docs/15, "Web" column):
 *   TA-03  cancelling the project password opens nothing and asks the server for nothing;
 *   TA-33  a project in an older schema is migrated in memory and sent whole, in one hand-over; one from a newer
 *          program is refused and nothing is sent.
 */
import { DomainError, Ledger, SCHEMA_VERSION, type LedgerRecord } from "@opesvault/domain";
import { memoryPreferences } from "@opesvault/ui";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { Workspace, type PlainRecordLike } from "../src/data/workspace.ts";
import { createAppRouter } from "../src/router.tsx";
import { DEMO, createFakeServices } from "../src/services/fake.ts";
import { SessionStore } from "../src/session.tsx";

describe("TA-03: cancelling the password", () => {
  it("opens no project, asks the services for nothing and leaves the list as it was", async () => {
    const user = userEvent.setup();
    const services = createFakeServices({ seed: true });
    const opened = vi.spyOn(services, "openProject");
    const session = new SessionStore();
    const account = await services.signIn(DEMO.email, DEMO.password);
    session.update({ account });
    const router = createAppRouter({ session, history: createMemoryHistory({ initialEntries: ["/projetos"] }) });
    render(<App router={router} services={services} session={session} preferences={memoryPreferences()} />);

    await user.click(await screen.findByRole("button", { name: /Casa/ }));
    const dialog = await screen.findByRole("dialog", { name: "Abrir Casa" });
    await user.type(screen.getByLabelText("Senha do projeto"), "digitada e desistida");
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Abrir Casa" })).toBeNull());
    expect(dialog.isConnected).toBe(false);

    expect(opened).not.toHaveBeenCalled();
    expect(session.get().open).toBeNull();
    expect(router.state.location.pathname).toBe("/projetos");
    // The password typed and abandoned is gone with the dialog: opening again starts empty.
    await user.click(screen.getByRole("button", { name: /Casa/ }));
    expect(((await screen.findByLabelText("Senha do projeto")) as HTMLInputElement).value).toBe("");
  });
});

/** A small project's records, as the vault holds them (kind, id, payload). */
function records(): PlainRecordLike[] {
  const ledger = Ledger.new("Casa");
  ledger.addMember("Ana");
  ledger.addMember("Bruno");
  return ledger.toRecords().map((r) => ({ kind: r.kind, id: r.id, payload: r.payload }));
}

/** The same project as an earlier program saved it: schema 1, members without a role. */
function olderSchema(rows: PlainRecordLike[]): PlainRecordLike[] {
  return rows.map((r) => {
    const payload = r.payload as Record<string, unknown>;
    if (r.kind === "ledger.meta") return { ...r, payload: { ...payload, schema_version: 1 } };
    if (r.kind === "member") {
      const { role: _role, ...rest } = payload;
      return { ...r, payload: rest };
    }
    return r;
  });
}

function recordingSink() {
  const calls: { upserts: PlainRecordLike[]; deletes: { kind: string; id: string }[] }[] = [];
  return {
    calls,
    sink: {
      stage(upserts: readonly PlainRecordLike[], deletes: readonly { kind: string; id: string }[]) {
        calls.push({ upserts: [...upserts], deletes: [...deletes] });
      },
    },
  };
}

describe("TA-33: migration and an older or newer program", () => {
  it("migrates an older project in memory and sends it whole, in one hand-over, once", async () => {
    const stored = olderSchema(records());
    const { calls, sink } = recordingSink();
    const workspace = Workspace.fromRecords(stored, "Casa", { sink });
    await workspace.settled();

    // The mark of the migration is cleared once it was handed over (a second opening would not resend it).
    expect(workspace.ledger.meta.schema_version).toBe(SCHEMA_VERSION);
    expect([...workspace.ledger.members.values()].map((m) => m.role)).toEqual(["holder", "holder"]);
    // Everything that was stored is sent again in the new shape, in a single hand-over (one revision).
    expect(calls).toHaveLength(1);
    const sent = new Map(calls[0]!.upserts.map((r) => [`${r.kind}:${r.id}`, r]));
    for (const r of stored) expect(sent.has(`${r.kind}:${r.id}`), `${r.kind} is sent again`).toBe(true);
    const meta = calls[0]!.upserts.find((r) => r.kind === "ledger.meta")!;
    expect((meta.payload as { schema_version: number }).schema_version).toBe(SCHEMA_VERSION);
    expect(calls[0]!.deletes).toEqual([]);

    // Undo cannot go back before the migration: the opening is not an edit.
    expect(workspace.undoStack.canUndo()).toBe(false);
  });

  it("a current project is not sent again on opening", async () => {
    const { calls, sink } = recordingSink();
    const workspace = Workspace.fromRecords(records(), "Casa", { sink });
    await workspace.settled();
    expect(calls).toEqual([]);
  });

  it("refuses a project saved by a newer program, and sends nothing", async () => {
    const newer = records().map((r) =>
      r.kind === "ledger.meta"
        ? { ...r, payload: { ...(r.payload as Record<string, unknown>), schema_version: SCHEMA_VERSION + 1 } }
        : r,
    );
    const { calls, sink } = recordingSink();
    expect(() => Workspace.fromRecords(newer, "Casa", { sink })).toThrow(DomainError);
    expect(() => Workspace.fromRecords(newer, "Casa", { sink })).toThrow(/versão|nova|atualiz/i);
    await Promise.resolve();
    expect(calls).toEqual([]);
    // The domain says so for any reader of the records, not only the workspace.
    expect(() => Ledger.fromRecords(newer as unknown as LedgerRecord[])).toThrow(DomainError);
  });
});
