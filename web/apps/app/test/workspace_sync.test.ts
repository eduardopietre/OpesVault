/**
 * What the workspace hands to the vault when a hand-over or storing a document fails, and what it says about the
 * blobs of removed documents.
 */
import { DomainError } from "@opesvault/domain";
import { describe, expect, it } from "vitest";
import { DOCUMENT_KIND, Workspace, type PlainRecordLike, type RecordSink } from "../src/data/workspace.ts";

/** A sink whose stage and storeBlob fail while `failing` is set, keeping what reached it. */
function flakySink() {
  const state = {
    failing: false,
    staged: [] as PlainRecordLike[],
    deleted: [] as { kind: string; id: string }[],
    options: [] as unknown[],
    blobs: new Map<string, Uint8Array>(),
    retired: [] as string[],
  };
  let next = 0;
  const sink: Required<RecordSink> = {
    stage(upserts, deletes, options) {
      if (state.failing) return Promise.reject(new DomainError("sem concessão"));
      state.staged.push(...upserts);
      state.deleted.push(...deletes);
      state.options.push(options);
      return Promise.resolve();
    },
    storeBlob(data) {
      if (state.failing) return Promise.reject(new DomainError("bloqueado"));
      const id = `blob-${(next += 1)}`;
      state.blobs.set(id, data);
      return Promise.resolve(id);
    },
    getBlob(id) {
      return Promise.resolve(state.blobs.get(id)!);
    },
    retireBlob(id) {
      if (state.failing) return Promise.reject(new DomainError("bloqueado"));
      state.retired.push(id);
      return Promise.resolve();
    },
  };
  return { state, sink };
}

async function opened() {
  const { state, sink } = flakySink();
  const workspace = Workspace.fromRecords([], "Casa", { sink });
  await workspace.settled();
  state.staged.length = 0;
  return { state, workspace };
}

const pdf = new TextEncoder().encode("%PDF-1.4\nrecibo\n%%EOF");

describe("changes the vault did not take", () => {
  it("stay in the tab, are counted and said, and go on the next try", async () => {
    const { state, workspace } = await opened();
    state.failing = true;
    workspace.act((ledger) => ledger.addMember("Bia"));
    await workspace.settled();
    expect(workspace.localOnly).toBeGreaterThan(0);
    expect(workspace.stageError).toBeInstanceOf(DomainError);
    expect(state.staged).toEqual([]);

    state.failing = false;
    workspace.retry();
    await workspace.settled();
    expect(workspace.localOnly).toBe(0);
    expect(workspace.stageError).toBeNull();
    expect(state.staged.some((r) => r.kind === "member")).toBe(true);
    // Made as the editor: the vault keeps it even if the lease was lost in between.
    expect(state.options.at(-1)).toEqual({ madeAsEditor: true });
  });

  it("a newer change of a record wins over the failed one put back", async () => {
    const { state, workspace } = await opened();
    state.failing = true;
    const bia = workspace.act((ledger) => ledger.addMember("Bia"));
    await workspace.settled();
    state.failing = false;
    workspace.act((ledger) => ledger.updateMember({ ...bia, name: "Beatriz" }, "nome completo"));
    await workspace.settled();
    const members = state.staged.filter((r) => r.kind === "member" && r.id === bia.id);
    expect(members.map((r) => (r.payload as { name: string }).name)).toEqual(["Beatriz"]);
    expect(workspace.localOnly).toBe(0);
  });

  it("a document that could not be uploaded waits in the tab, then goes with its record", async () => {
    const { state, workspace } = await opened();
    state.failing = true;
    const doc = workspace.act((_l, session) => session.addDocument("recibo.pdf", pdf));
    await workspace.settled();
    expect(workspace.unsentDocuments).toBe(1);
    expect(workspace.localOnly).toBe(1);

    state.failing = false;
    workspace.retry();
    await workspace.settled();
    expect(workspace.localOnly).toBe(0);
    const record = state.staged.find((r) => r.kind === DOCUMENT_KIND && r.id === doc.meta.id);
    expect((record?.payload as { blob_id: string }).blob_id).toBe("blob-1");
  });
});

describe("blobs of removed documents", () => {
  async function withDocument() {
    const context = await opened();
    const doc = context.workspace.act((_l, session) => session.addDocument("recibo.pdf", pdf));
    await context.workspace.settled();
    return { ...context, id: doc.meta.id };
  }

  it("are retired in the vault, which deletes them in a later session", async () => {
    const { state, workspace, id } = await withDocument();
    workspace.act((_l, session) => session.removeDocument(id));
    await workspace.settled();
    expect(state.deleted).toContainEqual({ kind: DOCUMENT_KIND, id });
    expect(state.retired).toEqual(["blob-1"]);
    expect(state.blobs.size).toBe(1);
  });

  it("an undone removal points to the same blob again, without storing it again", async () => {
    const { state, workspace, id } = await withDocument();
    workspace.act((_l, session) => session.removeDocument(id));
    await workspace.settled();
    state.staged.length = 0;
    workspace.undo();
    await workspace.settled();
    expect(state.blobs.size).toBe(1);
    const record = state.staged.find((r) => r.kind === DOCUMENT_KIND && r.id === id);
    expect((record?.payload as { blob_id: string }).blob_id).toBe("blob-1");
  });

  it("a retirement that failed waits in the tab like any change", async () => {
    const { state, workspace, id } = await withDocument();
    state.failing = true;
    workspace.act((_l, session) => session.removeDocument(id));
    await workspace.settled();
    expect(workspace.localOnly).toBeGreaterThan(0);
    state.failing = false;
    workspace.retry();
    await workspace.settled();
    expect(state.retired).toEqual(["blob-1"]);
    expect(workspace.localOnly).toBe(0);
  });
});
