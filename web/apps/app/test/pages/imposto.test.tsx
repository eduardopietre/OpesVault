/** Imposto de renda: the sheets of the year, the pending items that lead to the fix, DARFs, links, states. */
import { investments, makeDate, tax, type IsoDate } from "@opesvault/domain";
import { act as reactAct, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { YEAR, openImposto, seedRent, seedVariableIncome, taxSnapshot } from "./imposto_harness.tsx";
import { accountNamed, memberNamed } from "../lookup.ts";
import { choose, closed, dialog, fill, flat, clickRow, rowOf, submit, table, undoOnce } from "../dom.ts";
import { addressSettles } from "../navigations.ts";

const LINK = `/imposto-de-renda?ref=year:${YEAR}`;
const day = (m: number, d: number): IsoDate => makeDate(YEAR, m, d);

/** The button that resolves the pending item with these words. */
const resolver = (title: string | RegExp) =>
  screen.getByRole("button", { name: typeof title === "string" ? new RegExp(`\\(${escape(title)}`) : title });
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("the page", () => {
  it("opens on last year (the return filed now) and says whose declaration it is", async () => {
    await openImposto();
    const last = Number(new Date().getFullYear()) - 1;
    expect(
      screen.getByText(new RegExp(`Declaração de ${last + 1} \\(ano-calendário ${last}\\) · todo o projeto`)),
    ).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Ano-calendário" }).textContent).toContain(String(last));
  });

  it("shows every sheet of the demonstration year with its figures", async () => {
    const { ledger } = await openImposto(LINK);
    expect(screen.getAllByText("R$ 25.200,00").length).toBeGreaterThan(0); // taxable income of the year
    for (const label of ["Rendimentos tributáveis", "Imposto retido", "Deduções registradas", "Pendências"]) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
    const taxable = await table("Rendimentos tributáveis de pessoa jurídica");
    expect(flat(rowOf(taxable, "Empresa Exemplo Ltda").textContent)).toContain("11.222.333/0001-81");
    const payments = await table("Pagamentos efetuados");
    const row = flat(rowOf(payments, "Consulta Pediatra").textContent);
    expect(row).toContain("falta"); // the payee's CPF/CNPJ is missing and the sheet says so
    expect(row).toContain("0 de 1"); // no receipt attached
    expect(await table("Bens e direitos")).toBeTruthy();
    expect(await table("Dívidas e ônus reais")).toBeTruthy();
    expect(await table("Informes de rendimentos")).toBeTruthy();
    expect(flat(rowOf(await table("Informes de rendimentos"), "Banco A").textContent)).toContain("confere");
    // no sales of stocks: the variable income sheet is not shown
    expect(screen.queryByRole("grid", { name: "Renda variável mês a mês" })).toBeNull();
    expect(ledger.members.size).toBe(2);
  });

  it("shows the results that need the user's table as unknown, with the reason, never as zero", async () => {
    await openImposto(LINK);
    const sim = await table("Simplificada ou completa");
    expect(flat(rowOf(sim, "Imposto devido").textContent)).toBe("Imposto devido——");
    expect(flat(rowOf(sim, "A pagar (+) ou a restituir (−)").textContent)).toContain("——");
    expect(screen.getByText(/Falta informar a tabela anual de 2026/)).toBeTruthy();
    expect(screen.getByText(/o imposto fica desconhecido/)).toBeTruthy();
    expect(screen.queryByText(/menos imposto/)).toBeNull();
  });

  it("changes the year and the declarant, and the sheets follow", async () => {
    const { user, ledger } = await openImposto(LINK);
    await choose(user, "Declarante", "Ana", document.body);
    await waitFor(() => expect(screen.getByText(/ano-calendário 2026\) · Ana/)).toBeTruthy());
    // Ana has no CPF recorded as a declarant? She has: the sheets are hers and her dependent Bruno's
    expect(tax.records.peopleOf(ledger, memberNamed(ledger, "Ana").id)!.size).toBe(2);
    await choose(user, "Declarante", "Projeto inteiro", document.body);
    await choose(user, "Ano-calendário", `Ano-calendário ${YEAR - 1}`, document.body);
    await waitFor(() => expect(screen.getByText(new RegExp(`ano-calendário ${YEAR - 1}\\)`))).toBeTruthy());
    expect(screen.queryByRole("grid", { name: "Rendimentos tributáveis de pessoa jurídica" })).toBeNull();
    expect(screen.getByText(/Nenhuma receita no ano/)).toBeTruthy();
  });

  it("opens an empty project with a state for every sheet and nothing crashing (TA-31)", async () => {
    await openImposto("/imposto-de-renda", { project: "blank" });
    expect(screen.getByText(/Nenhuma receita no ano/)).toBeTruthy();
    expect(screen.getByText(/Nenhum pagamento dedutível no ano/)).toBeTruthy();
    expect(screen.getByText("Nenhum bem com saldo ou custo no fim do ano.")).toBeTruthy();
    expect(screen.getByText(/Nenhum informe deste ano/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Dívidas e ônus" })).toBeNull(); // no debts: no sheet
    expect(screen.queryByRole("grid", { name: "Renda variável mês a mês" })).toBeNull();
  });

  it("disables every editing command in a read-only project, with the reason, and changes nothing", async () => {
    const { user, ledger } = await openImposto(LINK, { project: "blank", readOnly: true });
    const before = taxSnapshot(ledger);
    expect((screen.getByRole("button", { name: "Importar informe…" }) as HTMLButtonElement).disabled).toBe(true);
    for (const name of ["CNPJ da fonte…", "Contracheques…", "Natureza…", "Registrar DARF do Carnê-Leão…"]) {
      const button = screen.queryByRole("button", { name }) as HTMLButtonElement | null;
      if (button) {
        expect(button.disabled, name).toBe(true);
        expect(button.title).toMatch(/Outra aba ou outro aparelho está editando/);
      }
    }
    await user.click(screen.getByRole("button", { name: "Cadastros" }));
    await user.click(await screen.findByRole("menuitem", { name: "Tabela e limites do ano…" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText(/Outra aba ou outro aparelho está editando/)).toBeTruthy();
    expect(taxSnapshot(ledger)).toBe(before);
  });
});

describe("the menus", () => {
  it("Cadastros opens each registration and Mais the informe without a file", async () => {
    const { user } = await openImposto(LINK);
    for (const [button, item, title] of [
      ["Cadastros", "Declarantes e dependentes…", "Declarantes e dependentes"],
      ["Cadastros", "Natureza dos rendimentos…", "Natureza dos rendimentos"],
      ["Cadastros", "Novo bem (imóvel, veículo)…", "Novo bem"],
      ["Cadastros", "Tabela e limites do ano…", "Tabela e limites de 2026"],
      ["Cadastros", "Regras de renda variável…", "Regras de renda variável"],
      ["Mais", "Novo informe sem arquivo…", "Informe de rendimentos"],
    ] as const) {
      await user.click(screen.getByRole("button", { name: button }));
      await user.click(await screen.findByRole("menuitem", { name: item }));
      const box = await dialog(title);
      await user.click(
        within(box)
          .getAllByRole("button", { name: /^(Cancelar|Fechar)$/ })
          .at(-1)!,
      );
      await closed(title);
    }
  });
});

describe("pending items lead to what resolves them", () => {
  it("lists them by urgency, each with a button that names its item", async () => {
    await openImposto(LINK);
    const list = screen.getByRole("list", { name: "Pendências da declaração" });
    const items = within(list).getAllByRole("listitem");
    expect(items.length).toBe(9);
    expect(items[0]!.textContent).toContain("Corrigir");
    expect(
      within(items[0]!).getByRole("button", { name: /^Informar CPF\/CNPJ… \(CPF\/CNPJ de quem recebeu/ }),
    ).toBeTruthy();
    expect(screen.getByText("Pendências · 9")).toBeTruthy();
    expect(screen.getByText("2 para corrigir")).toBeTruthy();
  });

  it("CPF/CNPJ of a payee: the number is masked, checked and kept, one undo reverts, and no notice carries it", async () => {
    const { user, ledger, workspace } = await openImposto(LINK);
    const before = taxSnapshot(ledger);
    const known = tax.records.identities(ledger).size;
    await user.click(resolver("CPF/CNPJ de quem recebeu: Consulta Pediatra"));
    const box = await dialog("CPF ou CNPJ");
    expect(flat(box.textContent)).toContain("Quem recebeu o pagamento: Consulta Pediatra");
    expect((within(box).getByLabelText("Nome na declaração") as HTMLInputElement).value).toBe("Consulta Pediatra");
    const number = within(box).getByLabelText("CPF ou CNPJ") as HTMLInputElement;
    await user.type(number, "11222333000180"); // a wrong check digit
    expect(number.value).toBe("11.222.333/0001-80");
    expect(within(box).getByText("CPF ou CNPJ inválido: confira os dígitos.")).toBeTruthy();
    await submit(user, box, "Salvar");
    expect(within(box).getAllByText("CPF ou CNPJ inválido: confira os dígitos.").length).toBeGreaterThan(0);
    expect(tax.records.identities(ledger).size).toBe(known); // nothing was stored
    await fill(user, box, "CPF ou CNPJ", "52998224725");
    expect(number.value).toBe("529.982.247-25"); // a CPF is accepted for a doctor
    await fill(user, box, "Nome na declaração", "Dra. Helena Pediatria");
    await submit(user, box, "Salvar");
    await closed("CPF ou CNPJ");
    expect(await screen.findByText("CPF/CNPJ salvo.")).toBeTruthy();
    // no CPF/CNPJ in any notice
    expect(screen.getByRole("region", { name: "Avisos" }).textContent).not.toMatch(/\d{3}\.?\d{3}/);
    const saved = [...tax.records.identities(ledger).values()].find((i) => i.subject === "merchant")!;
    expect(saved).toMatchObject({ tax_id: "52998224725", name: "Dra. Helena Pediatria" });
    const row = flat(rowOf(await table("Pagamentos efetuados"), "529.982.247-25").textContent);
    expect(row).toContain("Dra. Helena Pediatria"); // the name used in the return
    expect(row).toContain("529.982.247-25");
    expect(
      screen.queryByRole("button", { name: /^Informar CPF\/CNPJ… \(CPF\/CNPJ de quem recebeu: Consulta/ }),
    ).toBeNull();
    undoOnce(workspace);
    expect(taxSnapshot(ledger)).toBe(before);
  });

  it("receipts: lists the payments and attaches one, shown as 1 anexo, with one undo", async () => {
    const { user, ledger, workspace } = await openImposto(LINK);
    await user.click(resolver("Comprovante não anexado: Consulta Pediatra"));
    const box = await dialog("Comprovantes");
    expect(flat(box.textContent)).toContain("falta");
    const input = within(box).getByLabelText("Escolher o comprovante") as HTMLInputElement;
    const pdf = new File(
      [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 10, 1, 2, 3])],
      "recibo.pdf",
      {
        type: "application/pdf",
      },
    );
    await user.upload(input, pdf);
    expect(await within(box).findByText("Comprovante anexado e guardado cifrado no projeto.")).toBeTruthy();
    expect(flat(box.textContent)).toContain("1 anexo(s)");
    await user.click(within(box).getAllByRole("button", { name: "Fechar" }).at(-1)!);
    await closed("Comprovantes");
    expect(flat(rowOf(await table("Pagamentos efetuados"), "Consulta Pediatra").textContent)).toContain("1 de 1");
    expect(workspace.session.documents.some((d) => d.meta.original_name === "recibo.pdf")).toBe(true);
    undoOnce(workspace);
    expect(flat(rowOf(await table("Pagamentos efetuados"), "Consulta Pediatra").textContent)).toContain("0 de 1");
    expect(ledger.operations.size).toBeGreaterThan(0);
  });

  it("payslips: the gross, tax withheld and INSS of a deposit change the sheet; empty fields stay unknown", async () => {
    const { user, ledger, workspace } = await openImposto(LINK);
    const before = taxSnapshot(ledger);
    await user.click(resolver("Bruto, imposto retido e INSS: Empresa Exemplo Ltda"));
    const list = await dialog("Contracheques");
    const grid = within(list).getByRole("grid", { name: "Lançamentos" });
    expect(flat(grid.textContent)).toContain("não detalhado");
    await clickRow(user, grid, "05/02/2026");
    await user.click(within(list).getByRole("button", { name: "Detalhar…" }));
    const box = await dialog("Detalhar rendimento");
    await fill(user, box, "Bruto", "9600,00");
    await fill(user, box, "IR retido", "800,00");
    await submit(user, box, "Salvar");
    await closed("Detalhar rendimento");
    expect(flat(within(list).getByRole("grid", { name: "Lançamentos" }).textContent)).toContain(
      "R$ 9.600,00 / R$ 800,00 / —",
    );
    await user.click(within(list).getAllByRole("button", { name: "Fechar" }).at(-1)!);
    await closed("Contracheques");
    const details = [...tax.records.incomeDetails(ledger).values()];
    expect(details.some((d) => d.gross?.eq("9600") && d.withheld?.eq("800") && d.social_security === null)).toBe(true);
    expect(details).toHaveLength(2); // the demonstration's own payslip and this one
    undoOnce(workspace);
    expect(taxSnapshot(ledger)).toBe(before);
  });

  it("an asset: group and code are chosen from the IRPF table, never saved on their own, one undo reverts", async () => {
    const { user, ledger, workspace } = await openImposto(LINK);
    const before = taxSnapshot(ledger);
    expect(tax.records.filings(ledger).size).toBe(0);
    await user.click(resolver("Grupo e código do bem: Conjunta"));
    const box = await dialog("Bens e Direitos");
    expect(flat(box.textContent)).toContain("sugestão: grupo");
    await submit(user, box, "Salvar");
    expect(await within(box).findByText("Escolha o grupo e o código na tabela do IRPF.")).toBeTruthy();
    const kind = within(box).getByRole("combobox", { name: "Tipo (grupo e código do IRPF)" });
    await user.click(kind);
    await user.type(kind, "06.01");
    await user.click(await screen.findByRole("option", { name: /^06\.01/ }));
    await submit(user, box, "Salvar");
    await closed("Bens e Direitos");
    expect(await screen.findByText("Bem classificado.")).toBeTruthy();
    const [filing] = [...tax.records.filings(ledger).values()];
    expect(filing).toMatchObject({ subject: "account", description: "Conjunta" });
    undoOnce(workspace);
    expect(taxSnapshot(ledger)).toBe(before);
  });

  it("nature of the income: a source with no nature is a pending item; choosing it is the user's", async () => {
    const { user, ledger, workspace } = await openImposto(LINK);
    await reactAct(async () => void workspace.act((l) => seedRent(l)));
    const rent = accountNamed(ledger, "Aluguel recebido");
    const before = taxSnapshot(ledger);
    await user.click(
      await screen.findByRole("button", { name: /^Definir natureza… \(Natureza do rendimento: Aluguel recebido/ }),
    );
    const box = await dialog("Natureza dos rendimentos");
    expect(within(box).getByRole("combobox", { name: "Natureza: Aluguel recebido" }).textContent).toContain(
      "A definir",
    );
    await choose(user, "Natureza: Aluguel recebido", /Carnê-Leão/, box);
    await submit(user, box, "Salvar");
    await closed("Natureza dos rendimentos");
    expect(tax.records.natureOf(ledger, "category", rent.id)).toBe("carne_leao");
    expect(await table("Carnê-Leão mês a mês")).toBeTruthy();
    undoOnce(workspace);
    expect(taxSnapshot(ledger)).toBe(before);
    expect(tax.records.natureOf(ledger, "category", rent.id)).toBeNull();
  });

  it("the documents of the year: a pending item opens them, a document is marked by hand and unmarked", async () => {
    const { user, ledger, workspace } = await openImposto(LINK);
    const before = taxSnapshot(ledger);
    await user.click(screen.getByRole("button", { name: /^Ver documentos/ }));
    const grid = await table("Documentos do ano");
    await clickRow(user, grid, "Saldo devedor em 31/12");
    await user.click(screen.getByRole("button", { name: "Recebido / não recebido" }));
    await waitFor(() =>
      expect(flat(rowOf(grid, "Saldo devedor em 31/12").textContent)).toContain("Recebido (marcado)"),
    );
    expect(tax.records.marks(ledger).size).toBe(1);
    expect(screen.getByText("Documentos do ano · faltam 5")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Recebido / não recebido" }));
    await waitFor(() => expect(flat(rowOf(grid, "Saldo devedor em 31/12").textContent)).toContain("Falta"));
    expect(tax.records.marks(ledger).size).toBe(0);
    expect(taxSnapshot(ledger)).toBe(before);
    await user.click(screen.getByRole("button", { name: "Recebido / não recebido" }));
    await waitFor(() => expect(tax.records.marks(ledger).size).toBe(1));
    undoOnce(workspace);
    expect(taxSnapshot(ledger)).toBe(before);
  });

  it("opens a document of the checklist: receipts open the payments, an informe already read opens its review", async () => {
    const { user } = await openImposto(LINK);
    const grid = await table("Documentos do ano");
    await clickRow(user, grid, "Recibos e notas — Farmácia");
    const docs = within(screen.getByRole("heading", { name: /^Documentos do ano/ }).closest("section")!);
    await user.click(docs.getByRole("button", { name: "Abrir…" }));
    expect(await dialog("Comprovantes")).toBeTruthy();
    await user.click(
      within(await dialog("Comprovantes"))
        .getAllByRole("button", { name: "Fechar" })
        .at(-1)!,
    );
    await closed("Comprovantes");
    await clickRow(user, grid, "Informe de rendimentos — ITAÚ");
    await user.click(docs.getByRole("button", { name: "Abrir…" }));
    const review = await dialog("Informe de rendimentos");
    expect(within(review).getByRole("combobox", { name: "De quem é o informe" }).textContent).toContain("Banco A");
  });
});

describe("pending items that need seeded data", () => {
  it("a declarant without CPF: the pending item opens the member's tax data", async () => {
    const { user, ledger, workspace } = await openImposto(LINK);
    const ana = memberNamed(ledger, "Ana");
    await reactAct(
      async () =>
        void workspace.act((l) =>
          tax.records.setMemberInfo(l, ana.id, { cpf: null, birth_date: null, declared_by: null }, workspace.today()),
        ),
    );
    await choose(user, "Declarante", "Ana", document.body);
    await user.click(await screen.findByRole("button", { name: /^Dados fiscais… \(CPF: Ana\)/ }));
    const box = await dialog("Dados fiscais — Ana");
    expect(box).toBeTruthy();
    await fill(user, box, "CPF", "52998224725");
    await submit(user, box, "Salvar");
    await closed("Dados fiscais — Ana");
    expect(tax.records.memberInfo(ledger, ana.id)!.cpf).toBe("52998224725");
    expect(screen.queryByRole("button", { name: /^Dados fiscais… \(CPF: Ana\)/ })).toBeNull();
    undoOnce(workspace);
    expect(tax.records.memberInfo(ledger, ana.id)!.cpf).toBeNull();
  });

  it("an informe that differs from the records: the pending item opens it, correcting it clears the item", async () => {
    const { user, ledger, workspace } = await openImposto(LINK);
    const [report] = tax.records.reportsOf(ledger, YEAR);
    await reactAct(
      async () =>
        void workspace.act((l) =>
          tax.records.saveReport(
            l,
            YEAR,
            report!.source,
            report!.source_id,
            [tax.model.ReportLineSchema.parse({ field: "balance_end", amount: "1000.00", label: "Saldo" })],
            { report_id: report!.id, payer_tax_id: report!.payer_tax_id },
          ),
        ),
    );
    expect(flat(rowOf(await table("Informes de rendimentos"), "Banco A").textContent)).toContain("1 diferença(s)");
    const checks = await table("Informe comparado com o registrado");
    expect(flat(rowOf(checks, "Saldo no fim do ano").textContent)).toContain("R$ 1.000,00R$ 16.052,00-R$ 15.052,00");
    await user.click(
      await screen.findByRole("button", { name: /^Ver informe… \(Informe diferente do registrado: Banco A/ }),
    );
    const box = await dialog("Informe de rendimentos");
    await fill(user, box, "Linha 1: valor", "16.052,00");
    await submit(user, box, "Salvar informe");
    await closed("Informe de rendimentos");
    expect(await screen.findByText("Informe corrigido.")).toBeTruthy();
    expect(flat(rowOf(await table("Informes de rendimentos"), "Banco A").textContent)).toContain("confere");
  });

  it("an informe is removed after a confirmation, and the original stays in Documentos", async () => {
    const { user, ledger, workspace } = await openImposto(LINK);
    const before = taxSnapshot(ledger);
    await user.click(screen.getByRole("button", { name: "Remover" }));
    const ask = await screen.findByRole("alertdialog", { name: "Remover este informe?" });
    expect(flat(ask.textContent)).toContain("O arquivo original continua em Documentos.");
    await user.click(within(ask).getByRole("button", { name: "Cancelar" }));
    expect(tax.records.reportsOf(ledger, YEAR)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Remover" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remover" }));
    await waitFor(() => expect(tax.records.reportsOf(ledger, YEAR)).toHaveLength(0));
    expect(await screen.findByText(/Nenhum informe deste ano/)).toBeTruthy();
    undoOnce(workspace);
    expect(taxSnapshot(ledger)).toBe(before);
  });

  it("income of nobody in particular, seen from a declarant, leads to the Livro", async () => {
    const { user, workspace, router } = await openImposto(LINK);
    const joint = accountNamed(workspace.ledger, "Conjunta");
    const salary = [...workspace.ledger.categories("income" as never)][0]!;
    await reactAct(
      async () => void workspace.act((l) => l.recordIncome(joint.id, salary.id, "100.00", day(5, 5), "Prêmio")),
    );
    await choose(user, "Declarante", "Ana", document.body);
    await user.click(await screen.findByRole("button", { name: /^Ver no Livro \(Receitas sem integrante/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/livro"));
  });

  it("an investment without a known cost leads to Investimentos", async () => {
    const { user, workspace, router } = await openImposto(LINK);
    await reactAct(
      async () =>
        void workspace.act((l) =>
          investments.service.createPosition(l, "Fundo sem custo", investments.model.AssetClass.FUND, day(2, 1), {
            holder_id: memberNamed(l, "Ana").id,
            reference_value: "1000.00",
          }),
        ),
    );
    await user.click(
      await screen.findByRole("button", {
        name: /^Ver investimento \(Custo de aquisição desconhecido: Fundo sem custo/,
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/investimentos"));
  });
});

describe("variable income and DARF", () => {
  it("lists the sales month by month, with the user's rates, and says when a rate is missing", async () => {
    const { user, workspace, ledger } = await openImposto(LINK);
    await reactAct(async () => void workspace.act((l) => seedVariableIncome(l, { rates: false })));
    const grid = await table("Renda variável mês a mês");
    const april = flat(rowOf(grid, "04/2026").textContent);
    expect(april).toContain("Operações comuns (ações e ETF)");
    expect(april).toMatch(/R\$ 20\.000,00/); // the taxable base
    expect(screen.getByText(/Há base tributável sem alíquota/)).toBeTruthy();
    expect(screen.getByText(/feriados/)).toBeTruthy();
    // the tax is unknown, not zero, until the user informs the rates
    expect(april).toContain("—");
    await user.click(await screen.findByRole("button", { name: /^Regras… \(Alíquotas de renda variável/ }));
    const rules = await dialog("Regras de renda variável");
    expect((within(rules).getByLabelText("Operações comuns (ações e ETF) (%)") as HTMLInputElement).value).toBe("");
    await fill(user, rules, "Operações comuns (ações e ETF) (%)", "15");
    await fill(user, rules, "Vendas de ações isentas até", "20.000,00");
    await fill(user, rules, "Fonte", "Receita Federal");
    await submit(user, rules, "Salvar");
    await closed("Regras de renda variável");
    expect(
      tax.records
        .variableRules(ledger)!
        .rules.find((r) => r.bucket === "common")!
        .rate!.eq("0.15"),
    ).toBe(true);
    await waitFor(() => expect(flat(rowOf(grid, "04/2026").textContent)).toContain("R$ 3.000,00"));
    expect(screen.queryByText(/Há base tributável sem alíquota/)).toBeNull();
    undoOnce(workspace);
    expect(tax.records.variableRules(ledger)).toBeNull();
  });

  it("registers the DARF of the month: the amount still due comes filled in, one undo reverts everything", async () => {
    const { user, workspace, ledger } = await openImposto(LINK);
    await reactAct(async () => void workspace.act((l) => seedVariableIncome(l)));
    const grid = await table("Renda variável mês a mês");
    expect(flat(rowOf(grid, "04/2026").textContent)).toContain("R$ 3.000,00");
    const before = taxSnapshot(ledger);
    await user.click(screen.getByRole("button", { name: "Registrar DARF…" })); // no row chosen: the first month still due
    const box = await dialog("DARF de renda variável");
    expect(flat(box.textContent)).toContain("Apuração de 04/2026");
    expect((within(box).getByLabelText("Valor pago") as HTMLInputElement).value).toBe("3.000,00");
    await fill(user, box, "Valor pago", "");
    await submit(user, box, "Registrar pagamento");
    expect(await within(box).findByText("Informe o valor pago.")).toBeTruthy();
    await fill(user, box, "Valor pago", "3.000,00");
    await submit(user, box, "Registrar pagamento");
    await closed("DARF de renda variável");
    expect(await screen.findByText("Pagamento do DARF registrado.")).toBeTruthy();
    const [payment] = [...tax.records.payments(ledger).values()];
    expect(payment).toMatchObject({ purpose: "variable_income", month: { year: YEAR, month: 4 } });
    expect(payment!.amount.eq("3000")).toBe(true);
    expect(payment!.operation_id).not.toBeNull();
    await waitFor(() => expect(flat(rowOf(grid, "04/2026").textContent)).toMatch(/29\/05\/2026R\$ 3\.000,00$/));
    undoOnce(workspace);
    expect(taxSnapshot(ledger)).toBe(before);
    expect(tax.records.payments(ledger).size).toBe(0);
  });

  it("without a row chosen and nothing due, it says which table to use", async () => {
    const { user, workspace } = await openImposto(LINK);
    await reactAct(async () => void workspace.act((l) => seedVariableIncome(l, { rates: false })));
    await table("Renda variável mês a mês");
    await user.click(screen.getByRole("button", { name: "Registrar DARF…" }));
    expect(await screen.findByText("Escolha o mês na tabela de renda variável.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a link from a DARF reminder opens the year and the payment; the Carnê-Leão carries its member", async () => {
    const { user, workspace, ledger, router } = await openImposto(`/imposto-de-renda?ref=year:${YEAR - 1}`);
    await reactAct(async () => void workspace.act((l) => seedVariableIncome(l)));
    await reactAct(async () => {
      workspace.act((l) => {
        const rent = seedRent(l);
        tax.records.classify(l, "category", rent.id, "carne_leao");
      });
    });
    await reactAct(() =>
      router.navigate({ to: "/imposto-de-renda", search: { ref: `variable_income:${YEAR}-04`, act: "darf" } }),
    );
    const box = await dialog("DARF de renda variável");
    expect((within(box).getByLabelText("Valor pago") as HTMLInputElement).value).toBe("3.000,00");
    expect(screen.getByText(/ano-calendário 2026\)/)).toBeTruthy();
    await user.click(within(box).getByRole("button", { name: "Cancelar" }));
    await closed("DARF de renda variável");
    const ana = memberNamed(ledger, "Ana");
    await reactAct(() =>
      router.navigate({ to: "/imposto-de-renda", search: { ref: `carne_leao:${YEAR}-03:${ana.id}`, act: "darf" } }),
    );
    const carne = await dialog("DARF do Carnê-Leão");
    expect(flat(carne.textContent)).toContain("Apuração de 03/2026 · Ana");
    expect((within(carne).getByLabelText("Valor pago") as HTMLInputElement).value).toBe("");
    await fill(user, carne, "Valor pago", "120,00");
    await submit(user, carne, "Registrar pagamento");
    await closed("DARF do Carnê-Leão");
    const [payment] = [...tax.records.payments(ledger).values()];
    expect(payment).toMatchObject({ purpose: "carne_leao", member_id: ana.id });
    const sheet = await table("Carnê-Leão mês a mês");
    expect(flat(rowOf(sheet, "03/2026").textContent)).toContain("R$ 120,00");
    // the address is clean again: following the same link later is a new request
    await addressSettles(router, {});
  });

  it("a link with only the year opens that year and starts nothing; a link for another screen is ignored", async () => {
    const { router } = await openImposto("/imposto-de-renda");
    await reactAct(() => router.navigate({ to: "/imposto-de-renda", search: { ref: "year:2024" } }));
    await waitFor(() => expect(screen.getByText(/\(ano-calendário 2024\)/)).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();
    await reactAct(() => router.navigate({ to: "/imposto-de-renda", search: { ref: "loan:x:1" } }));
    expect(screen.getByText(/\(ano-calendário 2024\)/)).toBeTruthy();
  });
});
