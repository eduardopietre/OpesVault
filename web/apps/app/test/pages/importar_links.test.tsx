/**
 * Importar e revisar and the links between screens: a link with `ref: "<batchId>"` (a notice, Documentos'
 * "Ver importação", an investment note) opens that document's review; a ref that no longer exists says so; the count
 * beside the sidebar follows the approvals; and what leaves this page goes to the object it names.
 */
import { importing } from "@opesvault/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BANK_OFX } from "../../../../packages/domain/src/demo_docs/index.ts";
import { batches, file, importFiles, lastBatch, openImport } from "./importar_harness.tsx";
import { fakePdfRender } from "./importar_pdf_mock.ts";
import { addressSettles } from "../navigations.ts";

vi.mock("../../src/data/pdf_render.ts", async () =>
  fakePdfRender(await vi.importActual<typeof import("../../src/data/pdf_render.ts")>("../../src/data/pdf_render.ts")),
);

describe("Importar e revisar: links que chegam", () => {
  it("opens the review of the batch a link names, even when another one is the most recent", async () => {
    const o = await openImport();
    const demo = batches(o)[0]!;
    await importFiles(o, [file(BANK_OFX, "extrato.ofx")]);
    expect(await screen.findByRole("heading", { level: 2, name: "extrato.ofx" })).toBeTruthy();
    await o.router.navigate({ to: "/importar", search: { ref: demo.id } });
    expect(await screen.findByRole("heading", { level: 2, name: "fatura-nubank-03.pdf" })).toBeTruthy();
    // the link is consumed: the address is clean again
    await addressSettles(o.router, {});
    // the table is ready for the keyboard
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Itens extraídos"));
    // the same link followed later is a new request
    await importFiles(o, [file(new Uint8Array([...BANK_OFX, 10]), "extrato-2.ofx")]);
    await o.router.navigate({ to: "/importar", search: { ref: demo.id } });
    expect(await screen.findByRole("heading", { level: 2, name: "fatura-nubank-03.pdf" })).toBeTruthy();
  });

  it("says so when the document of the link no longer exists", async () => {
    const o = await openImport();
    await o.router.navigate({ to: "/importar", search: { ref: "00000000-0000-4000-8000-000000000000" } });
    expect(await screen.findByText("Esse documento não existe mais.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "fatura-nubank-03.pdf" })).toBeTruthy();
  });

  it("is where Documentos sends 'Ver importação'", async () => {
    const o = await openImport({ path: "/documentos", heading: "Documentos" });
    await o.user.click(await screen.findByRole("button", { name: "Ver importação" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Importar e revisar" })).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 2, name: "fatura-nubank-03.pdf" })).toBeTruthy();
    expect(o.router.state.location.pathname).toBe("/importar");
  });
});

describe("Importar e revisar: o que sai daqui", () => {
  it("keeps the count beside the sidebar in step with the items waiting for review", async () => {
    const o = await openImport();
    const waiting = [...importing.pipeline.items(o.ledger).values()].filter(
      (item) => item.status === "ready" || item.status === "needs_review",
    ).length;
    const link = () => screen.getAllByRole("link", { name: /^Importar e revisar/ })[0]!;
    await waitFor(() =>
      expect(link().getAttribute("aria-label")).toBe(`Importar e revisar, ${waiting} itens pedem atenção`),
    );
    await o.user.click(screen.getByRole("button", { name: "Aprovar prontos" }));
    // nothing waits any more: the link has no count
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Importar e revisar" }).length).toBeGreaterThan(0));
    expect(lastBatch(o)).toBeTruthy();
  });

  it("goes from the rule dialog back to the review: the rule's description starts from the item", async () => {
    const o = await openImport();
    await o.user.click(within(await screen.findByRole("grid", { name: "Itens extraídos" })).getByText("Loja Eletro"));
    await o.user.click(screen.getByRole("button", { name: "Mais" }));
    await o.user.click(await screen.findByRole("menuitem", { name: /^Criar regra a partir do item…/ }));
    const dialog = await screen.findByRole("dialog", { name: "Regra de categoria" });
    expect(within(dialog).getByRole("button", { name: "Criar regra" })).toBeTruthy();
    await o.user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Regra de categoria" })).toBeNull());
  });
});
