import { DomainError, dom, importing, type Ledger } from "@opesvault/domain";
import { act as reactAct, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderPdf } from "../../src/data/pdf_render.ts";
import type { Workspace } from "../../src/data/workspace.ts";
import { saveFile, formatBytes as fileSize } from "@opesvault/ui";
import {
  NO_FILTER,
  documentRows,
  fileType,
  filterActive,
  keepsDocument,
  summaryLine,
  usedBy,
  type DocumentFilter,
  type DocumentRow,
} from "../../src/pages/documentos/rows.ts";
import { DocumentUnavailable } from "../../src/data/workspace.ts";
import { openAt } from "./sharing_docs_harness.tsx";
import { choose, flat, fromRowMenu, rowMenu, type User, undoOnce } from "../dom.ts";
import { addressSettles, navigations, wentTo } from "../navigations.ts";
import { type MountOptions } from "../mount.tsx";

// happy-dom has no canvas: pdf.js is replaced by a drawing that reports its pages and asks for a password.
vi.mock("../../src/data/pdf_render.ts", async () => {
  const actual = await vi.importActual<typeof import("../../src/data/pdf_render.ts")>("../../src/data/pdf_render.ts");
  return {
    ...actual,
    renderPdf: vi.fn(async (data: Uint8Array, host: HTMLElement, _width: number, _max?: number, password?: string) => {
      const text = new TextDecoder().decode(data);
      if (text.includes("PROTEGIDO")) {
        if (!password) throw new actual.PdfPasswordRequired(false);
        if (password !== "segredo") throw new actual.PdfPasswordRequired(true);
      }
      host.replaceChildren();
      const pages = text.includes("MUITAS") ? 40 : 2;
      for (let number = 1; number <= Math.min(pages, 30); number++) {
        const canvas = document.createElement("canvas");
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", `Página ${number} de ${pages}`);
        host.append(canvas);
      }
      return { pages, destroy: vi.fn() };
    }),
  };
});
vi.mock("@opesvault/ui", async () => {
  const actual = await vi.importActual<typeof import("@opesvault/ui")>("@opesvault/ui");
  return { ...actual, saveFile: vi.fn() };
});

const bytes = (text: string) => new TextEncoder().encode(text);
const PDF = (extra = "") => bytes(`%PDF-1.4 ${extra}`);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const CSV = bytes("data;valor\n2026-03-01;10,00\n");

const op = (ledger: Ledger, description: string) =>
  [...ledger.operations.values()].find((o) => o.description === description)!;

/** The demonstration's imported statement plus five files: two receipts, a shared one, three that nothing uses. */
function prepare(workspace: Workspace): void {
  const ledger = workspace.ledger;
  workspace.act((_l, session) => {
    dom.attachments.attach(session, op(ledger, "Posto Shell").id, "recibo-posto.png", PNG);
    dom.attachments.attach(session, op(ledger, "Posto Shell").id, "nota-dividida.pdf", PDF("DIVIDIDA"));
    dom.attachments.attach(session, op(ledger, "Mercado do mês").id, "nota-dividida.pdf", PDF("DIVIDIDA"));
  });
  workspace.act((_l, session) => {
    session.addDocument("livre.pdf", PDF("LIVRE"));
    session.addDocument("protegido.pdf", PDF("PROTEGIDO"));
    session.addDocument("muitas-paginas.pdf", PDF("MUITAS"));
    session.addDocument("extrato.csv", CSV);
  });
}

const open = (path = "/documentos", options: MountOptions = { prepare }) => openAt(path, "Documentos", options);

const list = () => screen.findByRole("grid", { name: "Documentos no projeto" });
const pickDocument = async (user: User, name: string) => user.click(within(await list()).getByText(name));
const panel = () => screen.findByRole("region", { name: "Documento selecionado" });
const documents = (workspace: Workspace) => workspace.session.documents.map((d) => d.meta.original_name);

beforeEach(() => {
  vi.mocked(renderPdf).mockClear();
  vi.mocked(saveFile).mockClear();
});

describe("Documentos", () => {
  it("lists every document with its date, account or card and situation, and opens the first in this tab", async () => {
    const { ledger, workspace } = await open();
    expect(documents(workspace)).toEqual([
      "fatura-nubank-03.pdf",
      "recibo-posto.png",
      "nota-dividida.pdf",
      "livre.pdf",
      "protegido.pdf",
      "muitas-paginas.pdf",
      "extrato.csv",
    ]);
    const grid = await list();
    const rows = documentRows(ledger, workspace.session.documents);
    const batch = [...importing.importStore.batches(ledger).values()][0]!;
    const statement = flat(within(grid).getByText("fatura-nubank-03.pdf").closest("[role=row]")!.textContent);
    expect(rows[0]!.batchId).toBe(batch.id);
    expect(statement).toContain("Cartão X");
    expect(statement).toMatch(/\d{2}\/\d{2}\/\d{4}/);
    const receipt = flat(within(grid).getByText("recibo-posto.png").closest("[role=row]")!.textContent);
    expect(receipt).toContain("Posto Shell");
    expect(receipt).toContain("Comprovante");
    expect(flat(within(grid).getByText("nota-dividida.pdf").closest("[role=row]")!.textContent)).toContain(
      "Comprovante de 2 lançamentos",
    );
    expect(flat(within(grid).getByText("livre.pdf").closest("[role=row]")!.textContent)).toContain("Sem importação");
    // the line under the title, and the first document is already in the viewer
    expect(screen.getByText(summaryLine(rows))).toBeTruthy();
    expect((await panel()).textContent).toContain("fatura-nubank-03.pdf");
    expect(await screen.findByText("2 páginas")).toBeTruthy();
    expect(vi.mocked(renderPdf)).toHaveBeenCalledTimes(1);
  });

  it("shows what uses the selected document with a link to the import", async () => {
    const { ledger, router, user } = await open();
    const batch = [...importing.importStore.batches(ledger).values()][0]!;
    const region = await panel();
    expect(within(region).getByText(/^Importação \(/)).toBeTruthy();
    const went = navigations(router);
    await user.click(within(region).getByRole("button", { name: "Ver importação" }));
    await wentTo(went, "/importar", { ref: batch.id });
  });

  it("shows the operations that a receipt belongs to, each with a link to the Livro", async () => {
    const { ledger, router, user } = await open();
    await pickDocument(user, "nota-dividida.pdf");
    const region = await panel();
    await waitFor(() => expect(within(region).getByText(/Comprovante de “Posto Shell”/)).toBeTruthy());
    expect(within(region).getByText(/Comprovante de “Mercado do mês”/)).toBeTruthy();
    expect(within(region).getAllByRole("button", { name: /^Ver lançamento/ })).toHaveLength(2);
    const went = navigations(router);
    await user.click(within(region).getByRole("button", { name: "Ver lançamento: Mercado do mês" }));
    await wentTo(went, "/livro", { ref: op(ledger, "Mercado do mês").id });
  });

  it("shows an image directly and says a structured file has no page view", async () => {
    const { user } = await open();
    await pickDocument(user, "recibo-posto.png");
    expect(await screen.findByRole("img", { name: "Documento recibo-posto.png" })).toBeTruthy();
    await pickDocument(user, "extrato.csv");
    expect(await screen.findByText("Arquivo estruturado (CSV/OFX): sem visualização de página.")).toBeTruthy();
  });

  it("notes when only the first pages are drawn", async () => {
    const { user } = await open();
    await pickDocument(user, "muitas-paginas.pdf");
    expect(
      await screen.findByText("Mostrando as 30 primeiras de 40 páginas; salve o original para ver tudo."),
    ).toBeTruthy();
  });

  it("asks for the password of a protected PDF, refuses a wrong one inside the dialog and never keeps it", async () => {
    const { user } = await open();
    await pickDocument(user, "protegido.pdf");
    expect(await screen.findByText("Este PDF é protegido por senha.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Informar senha…" }));
    const dialog = await screen.findByRole("dialog", { name: "PDF protegido" });
    expect(within(dialog).getByText(/não é guardada/)).toBeTruthy();
    const field = within(dialog).getByLabelText("Senha do PDF") as HTMLInputElement;
    expect(field.type).toBe("password");
    // empty: nothing to try
    expect((within(dialog).getByRole("button", { name: "Abrir" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(field, "errada");
    await user.click(within(dialog).getByRole("button", { name: "Abrir" }));
    expect(await within(dialog).findByText("Senha incorreta. Tente de novo.")).toBeTruthy();
    expect((within(dialog).getByLabelText("Senha do PDF") as HTMLInputElement).value).toBe("");
    await user.type(within(dialog).getByLabelText("Senha do PDF"), "segredo");
    await user.click(within(dialog).getByRole("button", { name: "Abrir" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "PDF protegido" })).toBeNull());
    expect(await screen.findByText("2 páginas")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Informar senha…" })).toBeNull();
    // used once for each try, nowhere else
    const tries = vi.mocked(renderPdf).mock.calls.filter((call) => call[4] !== undefined);
    expect(tries.map((call) => call[4])).toEqual(["errada", "segredo"]);
    expect(JSON.stringify({ ...localStorage })).not.toContain("segredo");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("segredo");
    expect(document.body.innerHTML).not.toContain("segredo");
  });

  it("removes a document nothing uses without asking, and Desfazer or one undo brings it back", async () => {
    const { workspace, user } = await open();
    const before = documents(workspace);
    await pickDocument(user, "livre.pdf");
    expect(await screen.findByText("Nada usa este documento.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remover" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(documents(workspace)).not.toContain("livre.pdf"));
    expect(within(await list()).queryByText("livre.pdf")).toBeNull();
    expect(await screen.findByText("“livre.pdf” removido do projeto.")).toBeTruthy();
    // Desfazer in the notice
    await user.click(await screen.findByRole("button", { name: "Desfazer" }));
    await waitFor(() => expect([...documents(workspace)].sort()).toEqual([...before].sort()));
    expect(within(await list()).getByText("livre.pdf")).toBeTruthy();
    // and once more by the project's own undo
    await pickDocument(user, "livre.pdf");
    await user.click(screen.getByRole("button", { name: "Remover" }));
    await waitFor(() => expect(documents(workspace)).not.toContain("livre.pdf"));
    undoOnce(workspace);
    expect([...documents(workspace)].sort()).toEqual([...before].sort());
  });

  it("unlinks one receipt of a shared file and keeps the file; one undo reverts it", async () => {
    const { ledger, workspace, user } = await open();
    const attachments = () => dom.attachments.attachments(ledger).size;
    const before = attachments();
    const names = documents(workspace);
    await pickDocument(user, "nota-dividida.pdf");
    await user.click(await screen.findByRole("button", { name: "Desvincular de Mercado do mês" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(attachments()).toBe(before - 1));
    expect(documents(workspace)).toEqual(names);
    expect(screen.queryByRole("button", { name: "Desvincular de Mercado do mês" })).toBeNull();
    expect(await screen.findByText("“nota-dividida.pdf” deixou de ser comprovante de “Mercado do mês”.")).toBeTruthy();
    undoOnce(workspace);
    expect(attachments()).toBe(before);
    expect(await screen.findByRole("button", { name: "Desvincular de Mercado do mês" })).toBeTruthy();
  });

  it("unlinking the last use takes the file out of the project, and undo brings both back", async () => {
    const { ledger, workspace, user } = await open();
    const before = documents(workspace);
    const attachments = dom.attachments.attachments(ledger).size;
    await pickDocument(user, "recibo-posto.png");
    await user.click(await screen.findByRole("button", { name: "Desvincular de Posto Shell" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(documents(workspace)).not.toContain("recibo-posto.png"));
    expect(within(await list()).queryByText("recibo-posto.png")).toBeNull();
    expect(await screen.findByText(/saiu do projeto, porque nada mais o usa\.$/)).toBeTruthy();
    // Desfazer in the notice brings both back
    await user.click(await screen.findByRole("button", { name: "Desfazer" }));
    expect([...documents(workspace)].sort()).toEqual([...before].sort());
    expect(dom.attachments.attachments(ledger).size).toBe(attachments);
    reactAct(() => void workspace.redo());
    undoOnce(workspace);
    expect([...documents(workspace)].sort()).toEqual([...before].sort());
    expect(dom.attachments.attachments(ledger).size).toBe(attachments);
  });

  it("does not let a receipt be unlinked while another tab edits", async () => {
    const { workspace, user } = await open();
    reactAct(() => workspace.setReadOnly(true));
    await pickDocument(user, "recibo-posto.png");
    const button = (await screen.findByRole("button", { name: "Desvincular de Posto Shell" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("does not let a document in use be removed and says what uses it", async () => {
    const { workspace, user } = await open();
    await pickDocument(user, "recibo-posto.png");
    const remove = (await screen.findByRole("button", { name: "Remover" })) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(screen.getByText(/Em uso por 1 lançamento como comprovante/)).toBeTruthy();
    await pickDocument(user, "fatura-nubank-03.pdf");
    expect(screen.getByText(/Em uso por uma importação/)).toBeTruthy();
    expect(documents(workspace)).toContain("fatura-nubank-03.pdf");
    expect(usedBy(documentRows(workspace.ledger, workspace.session.documents)[0]!)).toBe("uma importação");
  });

  it("saves the original only after warning that it leaves the encrypted storage", async () => {
    const { user } = await open();
    await pickDocument(user, "livre.pdf");
    const save = await screen.findByRole("button", { name: "Salvar o original…" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    await user.click(save);
    let confirmation = await screen.findByRole("alertdialog", { name: "Salvar o original sem criptografia?" });
    expect(within(confirmation).getAllByText(/sem criptografia/).length).toBeGreaterThan(0);
    await user.click(within(confirmation).getByRole("button", { name: "Cancelar" }));
    expect(saveFile).not.toHaveBeenCalled();
    await user.click(save);
    confirmation = await screen.findByRole("alertdialog", { name: "Salvar o original sem criptografia?" });
    await user.click(within(confirmation).getByRole("button", { name: "Salvar o original" }));
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const [name, data, type] = vi.mocked(saveFile).mock.calls[0]!;
    expect(name).toBe("livre.pdf");
    expect(new TextDecoder().decode(data as Uint8Array)).toContain("LIVRE");
    expect(type).toBe("application/pdf");
    expect(await screen.findByText(/Arquivo salvo/)).toBeTruthy();
  });

  it("opens a free document's commands on a right click, Remover apart and in red, with Desfazer", async () => {
    const { workspace, user } = await open();
    const before = documents(workspace);
    const opened = await rowMenu(user, await list(), "livre.pdf");
    expect(opened.getAttribute("aria-label")).toBe("Ações de livre.pdf");
    expect(
      within(opened)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Salvar o original…", "Remover"]);
    expect(within(opened).getByRole("menuitem", { name: "Remover" }).className).toContain("text-negative");
    await user.click(within(opened).getByRole("menuitem", { name: "Remover" }));
    await waitFor(() => expect(documents(workspace)).not.toContain("livre.pdf"));
    await user.click(await screen.findByRole("button", { name: "Desfazer" }));
    await waitFor(() => expect([...documents(workspace)].sort()).toEqual([...before].sort()));
  });

  it("saves the original from the menu after the same warning", async () => {
    const { user } = await open();
    await fromRowMenu(user, await list(), "livre.pdf", "Salvar o original…");
    const confirmation = await screen.findByRole("alertdialog", { name: "Salvar o original sem criptografia?" });
    await user.click(within(confirmation).getByRole("button", { name: "Salvar o original" }));
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const [name, , type] = vi.mocked(saveFile).mock.calls[0]!;
    expect(name).toBe("livre.pdf");
    expect(type).toBe("application/pdf");
  });

  it("offers what uses a receipt: each operation and Desvincular in a cascade, with Desfazer", async () => {
    const { ledger, workspace, user } = await open();
    const opened = await rowMenu(user, await list(), "nota-dividida.pdf");
    expect(
      within(opened)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Salvar o original…", "Ver lançamento", "Desvincular"]);
    await user.keyboard("{Escape}");
    const before = documents(workspace);
    const id = workspace.session.documents.find((d) => d.meta.original_name === "nota-dividida.pdf")!.meta.id;
    await fromRowMenu(user, await list(), "nota-dividida.pdf", "Mercado do mês", "Desvincular");
    await waitFor(() => expect(dom.attachments.ofDocument(ledger, id)).toHaveLength(1));
    expect(documents(workspace)).toEqual(before);
    await user.click(await screen.findByRole("button", { name: "Desfazer" }));
    expect(
      dom.attachments.ofDocument(
        ledger,
        workspace.session.documents.find((d) => d.meta.original_name === "nota-dividida.pdf")!.meta.id,
      ),
    ).toHaveLength(2);
  });

  it("opens one of a receipt's operations from the menu's cascade", async () => {
    const { ledger, router, user } = await open();
    const went = navigations(router);
    await fromRowMenu(user, await list(), "nota-dividida.pdf", "Mercado do mês", "Ver lançamento");
    await wentTo(went, "/livro", { ref: op(ledger, "Mercado do mês").id });
  });

  it("keeps the commands that only read while another tab edits", async () => {
    const { router, workspace, user } = await open();
    reactAct(() => workspace.setReadOnly(true));
    const opened = await rowMenu(user, await list(), "recibo-posto.png");
    const state = (name: string) =>
      within(opened).getByRole("menuitem", { name }).getAttribute("aria-disabled") === "true";
    expect(state("Salvar o original…")).toBe(false);
    expect(state("Ver lançamento")).toBe(false);
    expect(state("Desvincular")).toBe(true);
    await user.keyboard("{Escape}");
    const went = navigations(router);
    const batch = [...importing.importStore.batches(workspace.ledger).values()][0]!;
    await fromRowMenu(user, await list(), "fatura-nubank-03.pdf", "Ver importação");
    await wentTo(went, "/importar", { ref: batch.id });
  });

  it("fetches a document only when it is chosen, and offers another try when it has not been downloaded", async () => {
    let calls = 0;
    const { workspace, user } = await open("/documentos", {
      prepare: (w) => {
        prepare(w);
        // nothing is in this tab yet: the viewer waits for a choice, and the first download fails
        vi.spyOn(w, "hasDocument").mockReturnValue(false);
        const real = w.loadDocument.bind(w);
        vi.spyOn(w, "loadDocument").mockImplementation((id) => {
          calls += 1;
          return calls === 1 ? Promise.reject(new DocumentUnavailable()) : real(id);
        });
      },
    });
    expect(screen.getByText(/Selecione um documento na lista para abrir o original/)).toBeTruthy();
    expect(calls).toBe(0);
    expect(screen.queryByRole("region", { name: "Documento selecionado" })).toBeNull();
    await pickDocument(user, "livre.pdf");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("O documento original ainda não foi baixado");
    // saving and removing wait for the bytes
    expect((screen.getByRole("button", { name: "Salvar o original…" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("2 páginas")).toBeTruthy();
    expect(calls).toBe(2);
    expect(workspace.session.documents.length).toBeGreaterThan(0);
  });

  it("loads the bytes before removing a document, so undo can put it back", async () => {
    const loads: string[] = [];
    const { workspace, user } = await open("/documentos", {
      prepare: (w) => {
        prepare(w);
        const real = w.loadDocument.bind(w);
        vi.spyOn(w, "loadDocument").mockImplementation((id) => {
          loads.push(id);
          return real(id);
        });
      },
    });
    await pickDocument(user, "livre.pdf");
    await screen.findByText("Nada usa este documento.");
    loads.length = 0;
    const livreId = workspace.session.documents.find((d) => d.meta.original_name === "livre.pdf")!.meta.id;
    await user.click(screen.getByRole("button", { name: "Remover" }));
    await waitFor(() => expect(documents(workspace)).not.toContain("livre.pdf"));
    expect(loads[0]).toBe(livreId);
  });

  it("refuses to remove when the bytes cannot be fetched, leaving the project as it was", async () => {
    const { workspace, user } = await open("/documentos", {
      prepare: (w) => {
        prepare(w);
        const real = w.loadDocument.bind(w);
        let first = true;
        vi.spyOn(w, "loadDocument").mockImplementation((id) => {
          if (first) {
            first = false;
            return real(id); // opening the viewer works
          }
          return Promise.reject(new DomainError("Sem conexão."));
        });
      },
    });
    const before = documents(workspace);
    await pickDocument(user, "livre.pdf");
    await screen.findByText("Nada usa este documento.");
    await user.click(screen.getByRole("button", { name: "Remover" }));
    expect((await screen.findAllByText("Sem conexão.")).length).toBeGreaterThan(0);
    expect(documents(workspace)).toEqual(before);
  });

  it("follows a link from another screen by selecting that document", async () => {
    const { workspace, router } = await open();
    const id = workspace.session.documents.find((d) => d.meta.original_name === "extrato.csv")!.meta.id;
    await reactAct(() => router.navigate({ to: "/documentos", search: { ref: id } }));
    expect(await screen.findByText("Arquivo estruturado (CSV/OFX): sem visualização de página.")).toBeTruthy();
    await addressSettles(router, {});
    await reactAct(() => router.navigate({ to: "/documentos", search: { ref: "documento:sumiu" } }));
    expect(await screen.findByText("Esse documento não existe mais.")).toBeTruthy();
  });

  it("in a project without documents explains where they come from", async () => {
    const { router, user } = await open("/documentos", { project: "new" });
    expect(await screen.findByRole("heading", { name: "Nenhum documento no projeto" })).toBeTruthy();
    expect(screen.queryByRole("grid")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Abrir o Livro financeiro" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/livro"));
  });

  it("is read only while another tab edits: the original can be seen and saved, not removed", async () => {
    const { workspace, user } = await open();
    reactAct(() => workspace.setReadOnly(true));
    await pickDocument(user, "livre.pdf");
    const remove = (await screen.findByRole("button", { name: "Remover" })) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Salvar o original…" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(await screen.findByText("2 páginas")).toBeTruthy();
  });

  it("adds a file by itself, opens it, and one undo takes it out", async () => {
    const { workspace, user } = await open();
    const before = workspace.session.documents.length;
    await user.upload(
      screen.getByLabelText("Escolher o arquivo"),
      new File([PDF("CONTRATO")], "contrato.pdf", { type: "application/pdf" }),
    );
    await waitFor(() => expect(documents(workspace)).toContain("contrato.pdf"));
    expect(await screen.findByText("Arquivo adicionado e guardado cifrado no projeto.")).toBeTruthy();
    await waitFor(async () => expect((await panel()).textContent).toContain("contrato.pdf"));
    expect(
      flat(
        within(await list())
          .getByText("contrato.pdf")
          .closest("[role=row]")!.textContent,
      ),
    ).toContain("Sem importação");
    expect(workspace.undoStack.undoLabel()).toBe("adicionar documento");
    undoOnce(workspace);
    expect(workspace.session.documents.length).toBe(before);
  });

  it("keeps the same file once and refuses what is not a PDF or an image", async () => {
    const { workspace, user } = await open();
    const before = workspace.session.documents.length;
    const input = screen.getByLabelText("Escolher o arquivo");
    await user.upload(input, new File([PDF("LIVRE")], "copia.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("Este arquivo já está no projeto, como “livre.pdf”.")).toBeTruthy();
    await user.upload(input, new File(["só texto"], "falso.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("Adicione um PDF ou uma imagem (PNG ou JPEG).")).toBeTruthy();
    expect(workspace.session.documents.length).toBe(before);
  });

  it("finds documents by name or by what uses them, and filters by type and date", async () => {
    const { user } = await open();
    const grid = await list();
    const names = () =>
      within(screen.getByRole("grid", { name: "Documentos no projeto" }))
        .getAllByRole("row")
        .slice(1)
        .map((row) => flat(row.textContent));
    await user.type(screen.getByRole("searchbox", { name: "Buscar em Documentos no projeto" }), "mercado do mes");
    await waitFor(() => expect(names()).toHaveLength(1));
    expect(names()[0]).toContain("nota-dividida.pdf");
    expect(screen.getByText("1 de 7")).toBeTruthy();
    await user.clear(screen.getByRole("searchbox", { name: "Buscar em Documentos no projeto" }));
    expect(grid.isConnected).toBe(true);

    await choose(user, "Tipo de arquivo", "Imagem");
    await waitFor(() => expect(names()).toHaveLength(1));
    await choose(user, "Tipo de arquivo", "Outro");
    await waitFor(() => expect(names()).toHaveLength(1));
    expect(names()[0]).toContain("extrato.csv");
    await choose(user, "Tipo de arquivo", "Todos os tipos");

    await choose(user, "Data dos documentos", "Intervalo de datas");
    await user.type(screen.getByRole("textbox", { name: "Data inicial" }), "01/01/2099");
    expect(await screen.findByText("Nada encontrado")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Limpar busca e filtros" }));
    await waitFor(() => expect(names()).toHaveLength(7));
  });

  it("keeps a document by its type and its date, a month or a range", () => {
    const row = (name: string, date: string | null) =>
      ({ name, date, where: "", state: "", receipts: [] }) as unknown as DocumentRow;
    expect(fileType("Foto.JPEG")).toBe("image");
    expect(fileType("fatura.pdf")).toBe("pdf");
    expect(fileType("extrato.ofx")).toBe("other");
    expect(fileType("sem extensão")).toBe("other");
    const march = row("a.pdf", "2026-03-10");
    expect(keepsDocument(march, { type: "pdf", date: { kind: "any" } })).toBe(true);
    expect(keepsDocument(march, { type: "image", date: { kind: "any" } })).toBe(false);
    expect(keepsDocument(march, { type: null, date: { kind: "month", month: { year: 2026, month: 3 } } })).toBe(true);
    expect(keepsDocument(march, { type: null, date: { kind: "month", month: { year: 2026, month: 4 } } })).toBe(false);
    const range = (from: string | null, to: string | null) =>
      ({ type: null, date: { kind: "range", from, to } }) as DocumentFilter;
    expect(keepsDocument(march, range("2026-03-10", "2026-03-10"))).toBe(true);
    expect(keepsDocument(march, range("2026-03-11", null))).toBe(false);
    expect(keepsDocument(march, range(null, "2026-03-09"))).toBe(false);
    // without a date a document passes only while no date is asked for
    expect(keepsDocument(row("b.pdf", null), range(null, null))).toBe(true);
    expect(keepsDocument(row("b.pdf", null), range("2026-01-01", null))).toBe(false);
    expect(filterActive(range(null, null))).toBe(false);
    expect(filterActive(NO_FILTER)).toBe(false);
  });

  it("formats sizes as people read them", () => {
    expect(fileSize(840)).toBe("840 B");
    expect(fileSize(1536)).toBe("1,5 KiB");
    expect(fileSize(12 * 1024)).toBe("12 KiB");
    expect(fileSize(3.4 * 1024 * 1024)).toBe("3,4 MiB");
    expect(summaryLine([])).toBe("");
  });
});
