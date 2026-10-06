/**
 * Importar e revisar and a brokerage note (SINACOR): its items are trades and costs, which have no category to
 * choose, and approving it goes through the investments module, whose refusals reach the person as notices and
 * change nothing (the sample note sells shares the demonstration project does not hold).
 */
import { importing } from "@opesvault/domain";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SINACOR_NOTE_PDF } from "../../../../packages/domain/src/demo_docs/index.ts";
import { file, importFiles, itemsOf, itemsTable, lastBatch, openImport } from "./importar_harness.tsx";
import { fakePdfRender } from "./importar_pdf_mock.ts";

vi.mock("../../src/data/pdf_render.ts", async () =>
  fakePdfRender(await vi.importActual<typeof import("../../src/data/pdf_render.ts")>("../../src/data/pdf_render.ts")),
);

describe("Importar e revisar: nota de corretagem", () => {
  it("reads trades and costs with no category to choose, and shows why the investments module refuses an approval", async () => {
    const o = await openImport();
    await importFiles(o, [file(SINACOR_NOTE_PDF, "nota.pdf")]);
    const batch = lastBatch(o);
    expect(batch.doc_type).toBe(importing.importModel.DocType.BROKERAGE_NOTE);
    expect(itemsOf(o, batch.id).some((i) => i.kind === importing.importModel.ItemKind.TRADE)).toBe(true);
    // a trade or a cost is not categorized: there is no selector for it
    expect(within(await itemsTable()).queryAllByRole("combobox")).toHaveLength(0);
    const operations = o.ledger.operations.size;
    // the note says where it settles, or it is not approved
    await o.user.click(screen.getByRole("button", { name: "Aprovar prontos" }));
    expect(await screen.findByText(/Escolha a conta .* onde a nota liquida\./)).toBeTruthy();
    // with an account, the module still refuses a sale of shares the project does not hold
    await o.user.click(screen.getByRole("combobox", { name: /^Conta ou cartão/ }));
    await o.user.click(await screen.findByRole("option", { name: "Banco A" }));
    await o.user.click(screen.getByRole("button", { name: "Aprovar prontos" }));
    expect(await screen.findByText(/Venda maior que a quantidade em carteira/)).toBeTruthy();
    // and nothing changed by the refused approvals
    expect(importing.pipeline.batches(o.ledger).get(batch.id)!.status).toBe("in_review");
    expect(o.ledger.operations.size).toBe(operations);
    expect(itemsOf(o, batch.id).every((i) => i.status !== importing.importModel.ItemStatus.APPROVED)).toBe(true);
  });
});
