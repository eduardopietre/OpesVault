/** The dialogs of Imposto de renda: people, the year's table, assets, informes (from a PDF too) and the print view. */
import { exporting, tax } from "@opesvault/domain";
import { act as reactAct, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BANK_INCOME_REPORT_PDF } from "../../../../packages/domain/src/demo_docs/index.ts";
import { PROTECTED_PDF_PASSWORD, protectedPdf } from "../../e2e/protected_pdf.ts";
import { taxReportData } from "../../src/pages/imposto/report.ts";
import {
  YEAR,
  account,
  choose,
  closed,
  dialog,
  fill,
  flat,
  member,
  openImposto,
  pick,
  rowOf,
  submit,
  table,
  taxSnapshot,
} from "./imposto_harness.tsx";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", async () => await import("./fake_echarts.ts"));

const LINK = `/imposto-de-renda?ref=year:${YEAR}`;
const undo = (workspace: { undo(): unknown }) => reactAct(() => void workspace.undo());

async function menu(user: Awaited<ReturnType<typeof openImposto>>["user"], button: string, item: string) {
  await user.click(screen.getByRole("button", { name: button }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

describe("Declarantes e dependentes", () => {
  it("lists the members with their CPF and who declares them, and edits one: masked, checked, undone", async () => {
    const { user, ledger, workspace } = await openImposto(LINK);
    await menu(user, "Cadastros", "Declarantes e dependentes…");
    const people = await dialog("Declarantes e dependentes");
    const grid = within(people).getByRole("grid", { name: "Integrantes" });
    expect(flat(rowOf(grid, "Ana").textContent)).toContain("529.982.247-25");
    expect(flat(rowOf(grid, "Ana").textContent)).toContain("Própria");
    expect(flat(rowOf(grid, "Bruno").textContent)).toContain("Dependente de Ana");
    const before = taxSnapshot(ledger);
    await pick(user, grid, "Bruno");
    await user.click(within(people).getByRole("button", { name: "Editar…" }));
    const box = await dialog("Dados fiscais — Bruno");
    const cpf = within(box).getByLabelText("CPF") as HTMLInputElement;
    expect(cpf.value).toBe("111.444.777-35");
    expect((within(box).getByLabelText("Relação de dependência") as HTMLInputElement).value).toBe("Filho(a)");
    // a CNPJ is not a person's CPF; a wrong digit is refused with the number nowhere in the message
    await fill(user, box, "CPF", "11222333000181");
    expect(cpf.value).toBe("112.223.330-00"); // a CPF has 11 digits: the mask stops there
    expect(within(box).getByText("CPF inválido: confira os dígitos.")).toBeTruthy();
    await submit(user, box, "Salvar");
    expect(flat(box.textContent)).toContain("CPF inválido: confira os dígitos.");
    // another member's CPF
    await fill(user, box, "CPF", "52998224725");
    await submit(user, box, "Salvar");
    expect(await within(box).findByText("Este CPF já pertence a outro integrante.")).toBeTruthy();
    await fill(user, box, "CPF", "11144477735");
    await fill(user, box, "Relação de dependência", "Enteado(a)");
    await submit(user, box, "Salvar");
    await closed("Dados fiscais — Bruno");
    expect(await within(people).findByText("Dados fiscais salvas.".replace("salvas", "salvos"))).toBeTruthy();
    expect(tax.records.memberInfo(ledger, member(ledger, "Bruno").id)!.relation).toBe("Enteado(a)");
    undo(workspace);
    expect(taxSnapshot(ledger)).toBe(before);
    await user.click(within(people).getAllByRole("button", { name: "Fechar" }).at(-1)!);
    await closed("Declarantes e dependentes");
  });

  it("makes a member a dependent: who declares comes from the other active members", async () => {
    const { user, ledger } = await openImposto(LINK);
    const ana = member(ledger, "Ana");
    await menu(user, "Cadastros", "Declarantes e dependentes…");
    const people = await dialog("Declarantes e dependentes");
    await pick(user, within(people).getByRole("grid", { name: "Integrantes" }), "Ana");
    await user.click(within(people).getByRole("button", { name: "Editar…" }));
    const box = await dialog("Dados fiscais — Ana");
    await choose(user, box, "Quem declara", "Dependente de Bruno");
    await submit(user, box, "Salvar");
    // Bruno is Ana's dependent already: nobody can be both
    expect(await within(box).findByText(/não pode ser dependente|declara outras pessoas/)).toBeTruthy();
    expect(tax.records.memberInfo(ledger, ana.id)!.declared_by).toBeNull();
  });

  it("asks to register members first when there are none", async () => {
    const { user } = await openImposto("/imposto-de-renda", { empty: true });
    await menu(user, "Cadastros", "Declarantes e dependentes…");
    expect(await screen.findByText("Cadastre os integrantes em Contas e cartões › Integrantes.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Tabela e limites do ano", () => {
  it("starts empty, refuses a typo naming the row, and with the user's table the simulation shows the tax", async () => {
    const { user, ledger, workspace } = await openImposto(LINK);
    const before = taxSnapshot(ledger);
    await menu(user, "Cadastros", "Tabela e limites do ano…");
    const box = await dialog("Tabela e limites de 2026");
    for (const name of ["Faixa 1: base anual até", "Faixa 1: alíquota (%)", "Faixa 5: parcela a deduzir"]) {
      expect((within(box).getByLabelText(name) as HTMLInputElement).value).toBe("");
    }
    expect(within(box).getAllByRole("button", { name: /^Remover faixa/ })).toHaveLength(5);
    await fill(user, box, "Faixa 2: base anual até", "abc");
    await submit(user, box, "Salvar");
    expect(await within(box).findByText("Faixa 2: use valores como 2.259,20 e 7,5.")).toBeTruthy();
    await fill(user, box, "Faixa 2: base anual até", "");
    // the user's own table: up to 30.000 at 10%, above at 20% minus 3.000
    await fill(user, box, "Faixa 1: base anual até", "30.000,00");
    await fill(user, box, "Faixa 1: alíquota (%)", "10");
    await fill(user, box, "Faixa 2: alíquota (%)", "20");
    await fill(user, box, "Faixa 2: parcela a deduzir", "3.000,00");
    await user.click(within(box).getByRole("button", { name: "Remover faixa 5" }));
    await user.click(within(box).getByRole("button", { name: "Adicionar faixa" }));
    expect(within(box).getAllByRole("button", { name: /^Remover faixa/ })).toHaveLength(5);
    await fill(user, box, "Desconto simplificado (%)", "20");
    await fill(user, box, "Teto do desconto simplificado", "16.754,34");
    await fill(user, box, "Dedução por dependente", "2.275,08");
    await fill(user, box, "Fonte dos valores", "Receita Federal, teste");
    await submit(user, box, "Salvar");
    await closed("Tabela e limites de 2026");
    expect(await screen.findByText("Tabela do ano salva.")).toBeTruthy();
    const saved = tax.records.parameters(ledger, YEAR)!;
    expect(saved.brackets).toHaveLength(2);
    expect(saved.simplified_rate!.eq("0.2") && saved.dependent_deduction!.eq("2275.08")).toBe(true);
    expect(saved.education_cap).toBeNull(); // not informed: unknown, not zero
    const sim = await table("Simplificada ou completa");
    await waitFor(() => expect(flat(rowOf(sim, "Imposto devido").textContent)).not.toBe("Imposto devido——"));
    expect(screen.queryByText(/Falta informar a tabela anual/)).toBeNull();
    expect(screen.getByText(/menos imposto|Falta informar/)).toBeTruthy();
    // reopened, the table comes back as typed
    await menu(user, "Cadastros", "Tabela e limites do ano…");
    const again = await dialog("Tabela e limites de 2026");
    expect((within(again).getByLabelText("Faixa 1: base anual até") as HTMLInputElement).value).toBe("30.000,00");
    expect((within(again).getByLabelText("Faixa 2: alíquota (%)") as HTMLInputElement).value).toBe("20");
    await user.click(within(again).getByRole("button", { name: "Cancelar" }));
    await closed("Tabela e limites de 2026");
    undo(workspace);
    expect(taxSnapshot(ledger)).toBe(before);
  });

  it("opens from the simulation too, and a bad percentage is refused with its name", async () => {
    const { user } = await openImposto(LINK);
    await user.click(screen.getByRole("button", { name: "Tabela do ano…", description: "" }).closest("button")!);
    const box = await dialog("Tabela e limites de 2026");
    await fill(user, box, "Desconto simplificado (%)", "250");
    await submit(user, box, "Salvar");
    expect(await within(box).findByText("Desconto simplificado: informe entre 0 e 100.")).toBeTruthy();
  });
});

describe("Bem (imóvel, veículo)", () => {
  it("includes a good at acquisition cost, edits it from the sheet, and each is one undo", async () => {
    const { user, ledger, workspace } = await openImposto(LINK);
    const before = taxSnapshot(ledger);
    await menu(user, "Cadastros", "Novo bem (imóvel, veículo)…");
    const box = await dialog("Novo bem");
    await submit(user, box, "Salvar");
    expect(await within(box).findByText("Informe o nome do bem.")).toBeTruthy();
    await fill(user, box, "Nome do bem", "Apartamento");
    await submit(user, box, "Salvar");
    expect(await within(box).findByText("Escolha o grupo e o código na tabela do IRPF.")).toBeTruthy();
    const kind = within(box).getByRole("combobox", { name: "Tipo (grupo e código do IRPF)" });
    await user.click(kind);
    await user.type(kind, "01.11");
    await user.click(await screen.findByRole("option", { name: /^01\.11/ }));
    await submit(user, box, "Salvar");
    expect(await within(box).findByText("Informe o valor.")).toBeTruthy();
    await fill(user, box, "Custo de aquisição", "350.000,00");
    await fill(user, box, "Data de aquisição", "10/03/2020");
    await fill(user, box, "Discriminação", "Rua das Flores, 100");
    await submit(user, box, "Salvar");
    await closed("Novo bem");
    expect(await screen.findByText("Bem incluído.")).toBeTruthy();
    const [asset] = [...tax.records.declaredAssets(ledger).values()];
    expect(asset).toMatchObject({ name: "Apartamento", group: "01", code: "11", description: "Rua das Flores, 100" });
    expect(asset!.cost.eq("350000")).toBe(true);
    expect(asset!.sold_on).toBeNull(); // not sold: unknown, not today
    const assets = await table("Bens e direitos");
    expect(flat(rowOf(assets, "Apartamento").textContent)).toContain("R$ 350.000,00");

    // edit it from the sheet: sold before it was bought is refused
    await pick(user, assets, "Apartamento");
    await user.click(screen.getByRole("button", { name: "Classificar…" }));
    const edit = await dialog("Bem");
    expect((within(edit).getByLabelText(/^Nome do bem/) as HTMLInputElement).value).toBe("Apartamento");
    await user.click(within(edit).getByLabelText(/Data de venda.*informada|informada/));
    await fill(user, edit, "Data de venda", "01/01/2019");
    await submit(user, edit, "Salvar");
    expect(await within(edit).findByText("A venda não pode ser antes da aquisição.")).toBeTruthy();
    await fill(user, edit, "Data de venda", "01/01/2024");
    await fill(user, edit, "Valor de venda", "400.000,00");
    await submit(user, edit, "Salvar");
    await closed("Bem");
    expect(tax.records.declaredAssets(ledger).get(asset!.id)!.sale_value!.eq("400000")).toBe(true);
    undo(workspace);
    expect(tax.records.declaredAssets(ledger).get(asset!.id)!.sold_on).toBeNull();
    undo(workspace);
    expect(taxSnapshot(ledger)).toBe(before);
  });

  it("the institution's CNPJ and a lender's: each needs a chosen row, and the asset of the sheet leads to its institution", async () => {
    const { user, ledger, workspace } = await openImposto(LINK);
    const header = screen.getByRole("heading", { name: "Bens e direitos" }).closest("section")!;
    await user.click(within(header).getByRole("button", { name: "CNPJ…" }));
    expect(await screen.findByText("Escolha um bem na tabela.")).toBeTruthy();
    const assets = await table("Bens e direitos");
    await pick(user, assets, "Nubank do Bruno");
    await user.click(within(header).getByRole("button", { name: "CNPJ…" }));
    const box = await dialog("CPF ou CNPJ");
    expect(flat(box.textContent)).toContain("Instituição da conta: Nubank do Bruno");
    await user.click(within(box).getByRole("button", { name: "Cancelar" }));
    await closed("CPF ou CNPJ");
    // a lender
    const debts = await table("Dívidas e ônus reais");
    await pick(user, debts, "Financiamento do carro");
    const lender = screen.getByRole("heading", { name: "Dívidas e ônus" }).closest("section")!;
    await user.click(within(lender).getByRole("button", { name: "CNPJ…" }));
    const lenderBox = await dialog("CPF ou CNPJ");
    await fill(user, lenderBox, "CPF ou CNPJ", "11222333000181");
    await submit(user, lenderBox, "Salvar");
    await closed("CPF ou CNPJ");
    const row = flat(rowOf(await table("Dívidas e ônus reais"), "Financiamento do carro").textContent);
    expect(row).toContain("11.222.333/0001-81");
    expect(tax.records.identity(ledger, "account", account(ledger, "Financiamento do carro").id)).not.toBeNull();
    undo(workspace);
    expect(tax.records.identity(ledger, "account", account(ledger, "Financiamento do carro").id)).toBeNull();
  });
});

describe("Informes de rendimentos", () => {
  it("creates one without a file: needs a source, drops empty lines, refuses a bad value and a duplicate", async () => {
    const { user, ledger, workspace } = await openImposto(LINK);
    const before = taxSnapshot(ledger);
    await menu(user, "Mais", "Novo informe sem arquivo…");
    const box = await dialog("Informe de rendimentos");
    expect((within(box).getByLabelText("Ano-calendário") as HTMLInputElement).value).toBe(String(YEAR));
    await submit(user, box, "Salvar informe");
    expect(await within(box).findByText("Escolha de quem é o informe.")).toBeTruthy();
    await choose(user, box, "De quem é o informe", "Conta: Nubank do Bruno — conta corrente");
    await user.click(within(box).getByRole("button", { name: "Adicionar linha" }));
    await fill(user, box, "Linha 1: valor", "1.000x");
    await submit(user, box, "Salvar informe");
    expect(await within(box).findByText("Valor inválido na linha 1. Use o formato 1.234,56.")).toBeTruthy();
    await fill(user, box, "Linha 1: valor", "640,00");
    await choose(user, box, "Linha 1: campo", "Saldo no fim do ano");
    await fill(user, box, "Linha 1: texto do informe", "Saldo em 31/12");
    await user.click(within(box).getByRole("button", { name: "Adicionar linha" }));
    await fill(user, box, "CNPJ de quem emitiu", "18236120000158");
    await submit(user, box, "Salvar informe");
    await closed("Informe de rendimentos");
    expect(await screen.findByText("Informe salvo.")).toBeTruthy();
    const nubank = account(ledger, "Nubank do Bruno — conta corrente");
    const saved = tax.records.reportsOf(ledger, YEAR).find((r) => r.source_id === nubank.id)!;
    expect(saved.lines).toHaveLength(1); // the empty second line was dropped
    expect(saved.lines[0]).toMatchObject({ field: "balance_end", label: "Saldo em 31/12" });
    const reports = await table("Informes de rendimentos");
    expect(flat(rowOf(reports, "Nubank do Bruno").textContent)).toContain("18.236.120/0001-58");
    // the same source in the same year is a duplicate
    await menu(user, "Mais", "Novo informe sem arquivo…");
    const again = await dialog("Informe de rendimentos");
    await choose(user, again, "De quem é o informe", "Conta: Nubank do Bruno — conta corrente");
    await submit(user, again, "Salvar informe");
    expect(await within(again).findByText(/Já há um informe desta fonte neste ano/)).toBeTruthy();
    await user.click(within(again).getByRole("button", { name: "Cancelar" }));
    await closed("Informe de rendimentos");
    undo(workspace);
    expect(taxSnapshot(ledger)).toBe(before);
  });

  it("reads a PDF, shows the lines to review, keeps the original and compares with the records", async () => {
    const { user, ledger, workspace } = await openImposto(`/imposto-de-renda?ref=year:${YEAR - 1}`);
    const before = taxSnapshot(ledger);
    const input = screen.getByLabelText("Escolher o arquivo do informe") as HTMLInputElement;
    await user.upload(
      input,
      new File([new Uint8Array(BANK_INCOME_REPORT_PDF)], "informe-banco.pdf", { type: "application/pdf" }),
    );
    const box = await dialog("Informe de rendimentos", { timeout: 15000 });
    expect((within(box).getByLabelText("Ano-calendário") as HTMLInputElement).value).toBe("2025");
    // the CNPJ in the document is shown formatted and the source is the institution already known by it
    expect((within(box).getByLabelText("CNPJ de quem emitiu") as HTMLInputElement).value).toBe("11.222.333/0001-81");
    // known by that CNPJ (the employer's category and the bank carry the same one in the demonstration)
    expect(within(box).getByRole("combobox", { name: "De quem é o informe" }).textContent).toMatch(/Banco A|Salário/);
    await choose(user, box, "De quem é o informe", "Conta: Banco A");
    expect(within(box).getByLabelText("Linha 1: valor")).toBeTruthy();
    expect(flat(box.textContent)).toContain("não foi validada com informes reais");
    await submit(user, box, "Salvar informe");
    await closed("Informe de rendimentos");
    expect(await screen.findByText("Informe salvo e comparado com o registrado.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Avisos" }).textContent).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}/);
    const [report] = tax.records.reportsOf(ledger, 2025);
    expect(report!.document_id).not.toBeNull();
    expect(workspace.session.documents.find((d) => d.meta.id === report!.document_id)!.meta.original_name).toBe(
      "informe-banco.pdf",
    );
    // the new informe is the one selected, and its comparison is shown
    const checks = await table("Informe comparado com o registrado");
    expect(flat(checks.textContent)).toContain("Saldo no fim do ano");
    undo(workspace);
    expect(taxSnapshot(ledger)).toBe(before);
    expect(tax.records.reportsOf(ledger, 2025)).toHaveLength(0);
  });

  it("a protected PDF asks for its password once, refuses a wrong one inside the dialog and never keeps it", async () => {
    const { user } = await openImposto(LINK);
    const input = screen.getByLabelText("Escolher o arquivo do informe") as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array(protectedPdf())], "protegido.pdf", { type: "application/pdf" }));
    const ask = await screen.findByRole("dialog", { name: "PDF protegido" }, { timeout: 15000 });
    const field = within(ask).getByLabelText("Senha do PDF") as HTMLInputElement;
    expect(field.type).toBe("password");
    await user.type(field, "errada");
    await user.click(within(ask).getByRole("button", { name: "Abrir" }));
    expect(await within(ask).findByText("Senha incorreta. Tente de novo.")).toBeTruthy();
    await user.type(within(ask).getByLabelText("Senha do PDF"), PROTECTED_PDF_PASSWORD);
    await user.click(within(ask).getByRole("button", { name: "Abrir" }));
    // the review opens once the password dialog has closed (never both at once)
    const review = await screen.findByRole("dialog", { name: "Informe de rendimentos" }, { timeout: 15000 });
    expect(screen.queryByRole("dialog", { name: "PDF protegido" })).toBeNull();
    expect(review).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(PROTECTED_PDF_PASSWORD);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(PROTECTED_PDF_PASSWORD);
  });

  it("a file that cannot be read says so and points to the informe without a file", async () => {
    const { user, ledger } = await openImposto(LINK);
    const before = taxSnapshot(ledger);
    const input = screen.getByLabelText("Escolher o arquivo do informe") as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3])], "estragado.pdf"));
    expect(
      await screen.findByText(
        "Não foi possível ler este arquivo. Use Mais › Novo informe sem arquivo.",
        {},
        { timeout: 15000 },
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(taxSnapshot(ledger)).toBe(before);
  });
});

describe("the report for the return", () => {
  it("has the sections of the domain's HTML, in the same order and with the same figures", async () => {
    const { workspace, ledger } = await openImposto(LINK);
    const today = workspace.today();
    const ana = member(ledger, "Ana").id;
    for (const declarant of [null, ana]) {
      const html = exporting.taxReportHtml(ledger, YEAR, today, declarant);
      const data = taxReportData(ledger, YEAR, today, declarant);
      const doc = new DOMParser().parseFromString(html, "text/html");
      const titles = [...doc.querySelectorAll("h2")].map((h) => h.textContent);
      expect(data.sections.map((s) => s.title)).toEqual(titles);
      expect(doc.querySelector("h1")!.textContent).toBe(`${data.project} — imposto de renda, ano-calendário ${YEAR}`);
      expect(doc.body.textContent).toContain(`Declarante: ${data.who}`);
      expect(doc.body.textContent).toContain(data.warning);
      expect(doc.body.textContent).toContain(data.notice);
      expect(data.cpf !== null).toBe(declarant !== null);
      if (data.cpf !== null) expect(doc.body.textContent).toContain(`CPF: ${data.cpf}`);
      // walk the HTML: after each title comes its note, table or list
      for (const heading of doc.querySelectorAll("h2")) {
        const section = data.sections.find((s) => s.title === heading.textContent)!;
        let node = heading.nextElementSibling;
        while (node && node.tagName !== "H2") {
          if (node.tagName === "TABLE") {
            const rows = [...node.querySelectorAll("tr")].slice(1);
            const cells = rows.map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent));
            if (section.table!.rows.length) {
              expect(cells.length, section.title).toBe(section.table!.rows.length);
              section.table!.rows.forEach((row, i) =>
                row.forEach((cell, j) =>
                  expect(cells[i]![j], `${section.title} ${i}:${j}`).toBe(
                    cell === null ? "—" : typeof cell === "string" ? cell : cellMoney(cell),
                  ),
                ),
              );
            }
            expect([...node.querySelectorAll("th")].map((h) => h.textContent)).toEqual([...section.table!.headers]);
          } else if (node.tagName === "UL") {
            expect([...node.querySelectorAll("li")].map((li) => li.textContent)).toEqual([...section.items!]);
          } else if (node.tagName === "P" && node.className !== "note") {
            expect(node.textContent).toBe(section.text);
          }
          node = node.nextElementSibling;
        }
      }
    }
    expect(taxReportData(ledger, YEAR, today, ana).sections.map((s) => s.id)).toContain("dependentes");
  });

  it("opens as a print view from Mais, prints once, downloads the HTML and goes back to the year", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    const created: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      created.push(blob as Blob);
      return "blob:test";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const { user, router, ledger, workspace } = await openImposto(LINK);
    await choose(user, document.body, "Declarante", "Ana");
    await menu(user, "Mais", "Relatório para a declaração (PDF)…");
    await waitFor(() => expect(router.state.location.pathname).toBe("/imprimir/imposto"));
    const title = await screen.findByRole("heading", { level: 1, name: /imposto de renda, ano-calendário 2026/ });
    expect(title.textContent).toContain(ledger.meta.family_name);
    expect(screen.getByRole("heading", { name: "Rendimentos tributáveis recebidos de pessoa jurídica" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Dependentes" })).toBeTruthy();
    expect(screen.getByText(/Declarante:/).textContent).toContain("Ana");
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(router.state.location.search).not.toHaveProperty("imprimir");
    await user.click(screen.getByRole("button", { name: "Imprimir ou salvar em PDF" }));
    expect(print).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Baixar como arquivo HTML" }));
    expect(created).toHaveLength(1);
    expect(await created[0]!.text()).toBe(
      exporting.taxReportHtml(ledger, YEAR, workspace.today(), member(ledger, "Ana").id),
    );
    await user.click(screen.getByRole("button", { name: "Voltar ao Imposto de renda" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/imposto-de-renda"));
    expect(await screen.findByText(/ano-calendário 2026\)/)).toBeTruthy();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});

function cellMoney(value: { toFixed(): string }): string {
  const [integer = "0", frac = "00"] = Number(value.toFixed()).toFixed(2).replace("-", "").split(".");
  const negative = Number(value.toFixed()) < 0;
  return `${negative ? "-" : ""}R$ ${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${frac}`;
}
