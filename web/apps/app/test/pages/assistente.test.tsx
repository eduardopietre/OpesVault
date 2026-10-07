/**
 * Assistente (desktop `tests/test_assistant.py`, the five "on screen" tests, plus what the web adds): whole
 * conversations with a scripted model. Reads run at once and never change the project; every change opens
 * "Aprovar alteração" and runs, when approved, as ONE undo step; a refusal changes nothing and tells the
 * model; three wrong answers in a row stop the question; a model that is off, unreachable, not allowed from
 * this origin or without tools is explained; CPF and CNPJ never reach the model nor the screen.
 */
import { dom, edits, tax } from "@opesvault/domain";
import { act as reactAct, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatFor } from "../../src/pages/assistente/chat.ts";
import { setServerProbe } from "../../src/pages/assistente/reach.ts";
import {
  ask,
  idle,
  log,
  openAssistente,
  opsNamed,
  resetModel,
  said,
  shortId,
  useScriptedModel,
  type ScriptedModel,
} from "./assistente_harness.tsx";
import { undoOnce } from "../dom.ts";
import { categoryNamed } from "../lookup.ts";

let model: ScriptedModel;
beforeEach(() => {
  model = useScriptedModel();
});
afterEach(resetModel);

const approval = () => screen.findByRole("dialog", { name: "Aprovar alteração" });

/** The model asks to move the rent to Lazer, then answers once the tool result comes back. */
function reclassifyRent(o: Awaited<ReturnType<typeof openAssistente>>, final = "Pronto, moveu o aluguel para Lazer.") {
  const rent = opsNamed(o, "Aluguel")[0]!;
  model.turns.push(
    {
      calls: [
        {
          name: "reclassify_operations",
          arguments: { ids: [shortId(rent)], category: "Lazer", reason: "Pedido do usuário" },
        },
      ],
    },
    { content: final },
  );
  return rent;
}

const categoryOf = (o: Awaited<ReturnType<typeof openAssistente>>, id: string) => {
  const op = o.workspace.ledger.operations.get(id)!;
  return o.workspace.ledger.account(
    op.postings.find((p) => o.workspace.ledger.account(p.account_id).type === "expense")!.account_id,
  ).name;
};

describe("Assistente: the conversation", () => {
  it("starts with examples and the promise that every change waits for the user", async () => {
    await openAssistente();
    expect(screen.getByText(/Só o Ollama deste computador participa/)).toBeTruthy();
    const examples = screen.getByRole("group", { name: "Perguntas de exemplo" });
    expect(within(examples).getAllByRole("button")).toHaveLength(3);
    expect(screen.getByText("IA local · gemma4:12b")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
  });

  it("an example sends itself; reads run at once, are listed in plain words and change nothing", async () => {
    const o = await openAssistente();
    model.turns.push(
      { calls: [{ name: "search_operations", arguments: { text: "Aluguel", limit: 5 } }] },
      { content: "Há lançamentos de aluguel em vários meses." },
    );
    const version = o.workspace.ledger.changeCount;
    const undo = o.workspace.undoStack.undoLabel();
    await o.user.click(screen.getByRole("button", { name: "Há lançamentos de Uber fora de Transporte?" }));
    expect(await said("Há lançamentos de aluguel em vários meses.")).toBeTruthy();
    const tools = within(log()).getByRole("list", { name: "Ferramentas consultadas" });
    expect(within(tools).getByText("Busca de lançamentos")).toBeTruthy();
    expect(within(tools).getByText(/encontrado\(s\)/)).toBeTruthy();
    expect(within(tools).getByText("Aluguel")).toBeTruthy(); // the argument: texto
    expect(within(tools).getByText(/texto:/)).toBeTruthy();
    expect(within(log()).getByText("Há lançamentos de Uber fora de Transporte?")).toBeTruthy();
    // the model saw the tools and its own answers, in order
    expect(model.chats).toHaveLength(2);
    expect(JSON.stringify(model.chats[1])).toContain('"role":"tool"');
    // nothing changed, no undo step, no examples any more
    expect(o.workspace.ledger.changeCount).toBe(version);
    expect(o.workspace.undoStack.undoLabel()).toBe(undo);
    expect(screen.queryByRole("group", { name: "Perguntas de exemplo" })).toBeNull();
    await idle();
  });

  it("shows the question box empty again, keeps typing free while the model works and refuses a second question", async () => {
    const o = await openAssistente();
    let release!: () => void;
    model.gate = new Promise<void>((resolve) => (release = resolve));
    model.turns.push({ content: "Respondi." });
    await ask(o, "Qual o saldo?");
    const box = screen.getByRole("textbox", { name: "Pergunta ao assistente" }) as HTMLInputElement;
    expect(box.value).toBe("");
    expect(await screen.findByText(/O assistente está pensando/)).toBeTruthy();
    // typing is not blocked; sending is
    await o.user.type(box, "outra pergunta");
    expect(box.value).toBe("outra pergunta");
    expect((screen.getByRole("button", { name: "Enviar" }) as HTMLButtonElement).disabled).toBe(true);
    await o.user.type(box, "{Enter}");
    expect(await screen.findByText("O assistente ainda está respondendo.")).toBeTruthy();
    expect(box.value).toBe("outra pergunta");
    reactAct(() => release());
    expect(await said("Respondi.")).toBeTruthy();
    await idle();
    expect(model.chats).toHaveLength(1);
  });

  it("asks for a question when there is none", async () => {
    const o = await openAssistente();
    await o.user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText("Escreva uma pergunta.")).toBeTruthy();
    expect(model.chats).toHaveLength(0);
  });
});

describe("Assistente: changes need the user", () => {
  it("shows exactly what changes, applies it only on Aprovar and one undo reverts all of it", async () => {
    const o = await openAssistente();
    const rent = reclassifyRent(o);
    const before = categoryOf(o, rent.id);
    expect(before).toBe("Moradia");
    const steps = o.workspace.undoStack.undoLabel();
    const version = o.workspace.ledger.changeCount;
    await ask(o, "Move o aluguel para Lazer");
    const d = await approval();
    // the domain's description, nothing hidden
    expect(within(d).getByText(/Reclassificar|Mudar a categoria|Lazer/, { selector: "p" })).toBeTruthy();
    expect(within(d).getByRole("list", { name: "O que muda" }).textContent).toMatch(/Aluguel/);
    expect(within(d).getByText(/Proposta pelo assistente \(IA local, gemma4:12b\)/)).toBeTruthy();
    expect(within(d).getByText(/pode ser desfeita com Ctrl\+Z/)).toBeTruthy();
    // nothing yet, and focus starts on the safe button
    expect(o.workspace.ledger.changeCount).toBe(version);
    expect(categoryOf(o, rent.id)).toBe("Moradia");
    expect(document.activeElement).toBe(within(d).getByRole("button", { name: "Recusar" }));
    await o.user.click(within(d).getByRole("button", { name: "Aprovar" }));
    expect(await said("Pronto, moveu o aluguel para Lazer.")).toBeTruthy();
    expect(categoryOf(o, rent.id)).toBe("Lazer");
    // the transcript says it, and the model was told "aplicado"
    const card = within(log()).getByRole("region", { name: /Alteração proposta/ });
    expect(within(card).getByText("Aplicada")).toBeTruthy();
    expect(within(card).getByText(/^Aplicado:/)).toBeTruthy();
    expect(model.chats[1] && JSON.stringify(model.chats[1])).toContain("aplicado");
    // one user action, one undo step, and the reason says where it came from
    expect(o.workspace.undoStack.undoLabel()).not.toBe(steps);
    expect(o.workspace.ledger.historyOf(rent.id).at(-1)?.reason).toMatch(/assistente, ollama:gemma4:12b:a1/);
    undoOnce(o.workspace);
    expect(categoryOf(o, rent.id)).toBe("Moradia");
    expect(o.workspace.undoStack.undoLabel()).toBe(steps);
    await idle();
  });

  it("Recusar changes nothing and the model is told", async () => {
    const o = await openAssistente();
    const rent = reclassifyRent(o, "Tudo bem, deixei como estava.");
    const version = o.workspace.ledger.changeCount;
    await ask(o, "Move o aluguel para Lazer");
    const d = await approval();
    await o.user.click(within(d).getByRole("button", { name: "Recusar" }));
    expect(await said("Tudo bem, deixei como estava.")).toBeTruthy();
    expect(categoryOf(o, rent.id)).toBe("Moradia");
    expect(o.workspace.ledger.changeCount).toBe(version);
    const card = within(log()).getByRole("region", { name: /Alteração proposta/ });
    expect(within(card).getByText("Recusada")).toBeTruthy();
    expect(within(card).getByText(/^Você recusou:/)).toBeTruthy();
    expect(JSON.stringify(model.chats[1])).toContain("recusado pelo usuário");
    await idle();
  });

  it("Esc and the corner × are a refusal too", async () => {
    const o = await openAssistente();
    const rent = reclassifyRent(o, "Certo.");
    await ask(o, "Move o aluguel para Lazer");
    const d = await approval();
    await o.user.click(within(d).getAllByRole("button", { name: "Fechar" })[0]!);
    expect(await said("Certo.")).toBeTruthy();
    expect(categoryOf(o, rent.id)).toBe("Moradia");
    expect(JSON.stringify(model.chats[1])).toContain("recusado pelo usuário");
    await idle();
  });

  it("asks each of several changes in its own dialog, in order", async () => {
    const o = await openAssistente();
    const [first, second] = opsNamed(o, "Aluguel");
    model.turns.push(
      {
        calls: [
          {
            name: "reclassify_operations",
            arguments: { ids: [shortId(first!)], category: "Lazer", reason: "Primeira" },
          },
          {
            name: "reclassify_operations",
            arguments: { ids: [shortId(second!)], category: "Lazer", reason: "Segunda" },
          },
        ],
      },
      { content: "Feito o que você aprovou." },
    );
    await ask(o, "Move dois aluguéis");
    await o.user.click(within(await approval()).getByRole("button", { name: "Aprovar" }));
    await o.user.click(within(await approval()).getByRole("button", { name: "Recusar" }));
    expect(await said("Feito o que você aprovou.")).toBeTruthy();
    expect(categoryOf(o, first!.id)).toBe("Lazer");
    expect(categoryOf(o, second!.id)).toBe("Moradia");
    expect(within(log()).getAllByRole("region", { name: /Alteração proposta/ })).toHaveLength(2);
    await idle();
  });

  it("registers an expense with the exact amount, as one undo step", async () => {
    const o = await openAssistente();
    const count = o.workspace.ledger.operations.size;
    model.turns.push(
      {
        calls: [
          {
            name: "record_expense",
            arguments: {
              account: "Banco A",
              category: "Alimentação",
              amount: 87.4,
              date: "2026-10-04",
              description: "Padaria",
            },
          },
        ],
      },
      { content: "Registrei." },
    );
    await ask(o, "Registre 87,40 de padaria");
    const d = await approval();
    expect(d.textContent).toMatch(/87,40/);
    await o.user.click(within(d).getByRole("button", { name: "Aprovar" }));
    expect(await said("Registrei.")).toBeTruthy();
    expect(o.workspace.ledger.operations.size).toBe(count + 1);
    undoOnce(o.workspace);
    expect(o.workspace.ledger.operations.size).toBe(count);
    await idle();
  });

  it("an approved change the project cannot run any more is reported, not shown as applied", async () => {
    const o = await openAssistente();
    const rent = reclassifyRent(o, "Não deu.");
    await ask(o, "Move o aluguel para Lazer");
    const d = await approval();
    // between the proposal and the approval the rent is moved by someone else
    o.workspace.act((ledger) => edits.reclassify(ledger, [rent.id], categoryNamed(ledger, "Lazer").id, "Outra pessoa"));
    const steps = o.workspace.undoStack.undoLabel();
    await o.user.click(within(d).getByRole("button", { name: "Aprovar" }));
    expect(await said("Não deu.")).toBeTruthy();
    const card = within(log()).getByRole("region", { name: /Alteração proposta/ });
    expect(within(card).getByText("Não aplicada")).toBeTruthy();
    expect(within(card).getByText(/Não foi possível aplicar/)).toBeTruthy();
    expect(JSON.stringify(model.chats[1])).toContain("erro");
    expect(o.workspace.undoStack.undoLabel()).toBe(steps);
    await idle();
  });

  it("a project open for reading only can refuse but not approve", async () => {
    const o = await openAssistente({ readOnly: true });
    const rent = reclassifyRent(o, "Entendi.");
    await ask(o, "Move o aluguel para Lazer");
    const d = await approval();
    const approve = within(d).getByRole("button", { name: "Aprovar" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.title).toMatch(/só leitura/);
    expect(d.textContent).toMatch(/Só é possível recusar/);
    await o.user.click(within(d).getByRole("button", { name: "Recusar" }));
    expect(await said("Entendi.")).toBeTruthy();
    expect(categoryOf(o, rent.id)).toBe("Moradia");
    await idle();
  });
});

describe("Assistente: wrong answers", () => {
  it("goes back to the model as an error, and the model corrects itself", async () => {
    const o = await openAssistente();
    model.turns.push(
      { calls: [{ name: "ferramenta_que_nao_existe", arguments: {} }] },
      { calls: [{ name: "list_members", arguments: {} }] },
      { content: "São dois integrantes." },
    );
    await ask(o, "Quem são os integrantes?");
    expect(await said("São dois integrantes.")).toBeTruthy();
    expect(within(log()).getByText(/Resposta inválida do modelo \(1 de 3\)/)).toBeTruthy();
    expect(JSON.stringify(model.chats[1])).toContain("Ferramenta desconhecida");
    expect(within(log()).getByText("Integrantes")).toBeTruthy();
    await idle();
  });

  it("three in a row stop the question; the next question starts fresh", async () => {
    const o = await openAssistente();
    model.turns.push(
      { calls: [{ name: "nada", arguments: {} }] },
      { content: "" },
      { content: '{"name": "list_members", "arguments": {}}' },
      { content: "Esta resposta não deve ser pedida." },
    );
    await ask(o, "Pergunta que dá errado");
    expect(await within(log()).findByText(/errou 3 vezes seguidas e a pergunta foi interrompida/)).toBeTruthy();
    expect(within(log()).getByText(/Resposta inválida do modelo \(3 de 3\)/)).toBeTruthy();
    await idle();
    expect(model.chats).toHaveLength(3);
    expect(model.turns).toHaveLength(1);
    // the question box works again
    model.turns.length = 0;
    model.turns.push({ content: "Agora sim." });
    await ask(o, "Tente outra vez");
    expect(await said("Agora sim.")).toBeTruthy();
  });

  it("a valid answer between wrong ones resets the count", async () => {
    const o = await openAssistente();
    model.turns.push(
      { calls: [{ name: "nada", arguments: {} }] },
      { calls: [{ name: "nada", arguments: {} }] },
      { calls: [{ name: "list_tags", arguments: {} }] },
      { calls: [{ name: "nada", arguments: {} }] },
      { content: "Terminei." },
    );
    await ask(o, "Quais marcadores?");
    expect(await said("Terminei.")).toBeTruthy();
    expect(within(log()).queryByText(/interrompida/)).toBeNull();
    await idle();
  });
});

describe("Assistente: cancel and leaving", () => {
  it("Cancelar stops the question at once, applies nothing and frees the box", async () => {
    const o = await openAssistente();
    const rent = reclassifyRent(o);
    model.gate = new Promise<void>(() => undefined); // the model never answers
    const version = o.workspace.ledger.changeCount;
    await ask(o, "Move o aluguel para Lazer");
    await o.user.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(await said("Consulta cancelada.")).toBeTruthy();
    await idle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(categoryOf(o, rent.id)).toBe("Moradia");
    expect(o.workspace.ledger.changeCount).toBe(version);
    expect((screen.getByRole("button", { name: "Enviar" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Nova conversa forgets everything, but not while the model works", async () => {
    const o = await openAssistente();
    model.turns.push({ content: "Primeira resposta." });
    await ask(o, "Primeira pergunta");
    expect(await said("Primeira resposta.")).toBeTruthy();
    await idle();
    await o.user.click(screen.getByRole("button", { name: "Nova conversa" }));
    expect(within(log()).queryByText("Primeira resposta.")).toBeNull();
    expect(screen.getByRole("group", { name: "Perguntas de exemplo" })).toBeTruthy();
    // a new question does not carry the old one
    model.turns.push({ content: "Segunda resposta." });
    await ask(o, "Segunda pergunta");
    expect(await said("Segunda resposta.")).toBeTruthy();
    const second = JSON.stringify(model.chats[1]);
    expect(second).not.toContain("Primeira pergunta");
    await idle();
    // while it works
    model.gate = new Promise<void>(() => undefined);
    await ask(o, "Terceira pergunta");
    await screen.findByRole("button", { name: "Cancelar" });
    await o.user.click(screen.getByRole("button", { name: "Nova conversa" }));
    expect(await screen.findByText("Aguarde a resposta ou cancele antes de começar outra conversa.")).toBeTruthy();
    expect(within(log()).getByText("Terceira pergunta")).toBeTruthy();
    await o.user.click(screen.getByRole("button", { name: "Cancelar" }));
    await idle();
  });

  it("leaving the page stops the question; coming back finds the conversation in memory only", async () => {
    const o = await openAssistente();
    model.turns.push({ content: "Primeira resposta." });
    await ask(o, "Primeira pergunta");
    expect(await said("Primeira resposta.")).toBeTruthy();
    await idle();
    model.gate = new Promise<void>(() => undefined);
    await ask(o, "Pergunta lenta");
    await screen.findByRole("button", { name: "Cancelar" });
    await o.router.navigate({ to: "/livro" });
    await screen.findByRole("heading", { level: 1, name: "Livro financeiro" });
    await o.router.navigate({ to: "/assistente" });
    await screen.findByRole("heading", { level: 1, name: "Assistente" });
    expect(await said("Primeira resposta.")).toBeTruthy();
    expect(await said("Consulta cancelada.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
    // the conversation belongs to the open project's workspace and to nothing else
    expect(chatFor(o.workspace, () => o.workspace.today()).items.length).toBeGreaterThan(0);
    const other = await openAssistente();
    expect(chatFor(other.workspace, () => other.workspace.today()).items).toHaveLength(0);
  });

  it("writes nothing to browser storage", async () => {
    const o = await openAssistente();
    const keys = () => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].sort();
    const before = keys();
    model.turns.push({ content: "Resposta confidencial." });
    await ask(o, "Pergunta confidencial");
    expect(await said("Resposta confidencial.")).toBeTruthy();
    expect(keys()).toEqual(before);
    for (const store of [localStorage, sessionStorage]) {
      for (const key of Object.keys(store)) expect(store.getItem(key)).not.toMatch(/confidencial/);
    }
  });
});

describe("Assistente: the AI is not available", () => {
  it("is off in Configurações: says so and leads there", async () => {
    const o = await openAssistente();
    o.workspace.act((ledger) => dom.settings.updateSettings(ledger, { ai_enabled: false }));
    expect(await screen.findByRole("heading", { name: "Assistente desligado" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Pergunta ao assistente" })).toBeNull();
    expect(screen.getByText(/O aplicativo funciona inteiro sem ela/)).toBeTruthy();
    await o.user.click(screen.getByRole("button", { name: "Abrir Configurações" }));
    await waitFor(() => expect(o.router.state.location.pathname).toBe("/configuracoes"));
    expect(model.chats).toHaveLength(0);
  });

  it("Ollama unreachable: names the address, leads to Configurações and asks again on request", async () => {
    const o = await openAssistente();
    model.down = true;
    await ask(o, "Qual o saldo?");
    const card = await within(log()).findByRole("alert", { name: "Não foi possível falar com o Ollama" });
    expect(card.textContent).toMatch(/http:\/\/127\.0\.0\.1:11434/);
    expect(within(card).queryByText(/OLLAMA_ORIGINS/)).toBeNull();
    expect(within(card).getByRole("button", { name: "Abrir Configurações" })).toBeTruthy();
    await idle();
    // the server comes back: Tentar de novo asks the same question, once
    model.down = false;
    model.turns.push({ content: "Saldo conferido." });
    await o.user.click(within(card).getByRole("button", { name: "Tentar de novo" }));
    expect(await said("Saldo conferido.")).toBeTruthy();
    expect(within(log()).queryByRole("alert")).toBeNull();
    expect(within(log()).getAllByText("Qual o saldo?")).toHaveLength(1);
    expect(JSON.stringify(model.chats[0]).match(/Qual o saldo\?/g)).toHaveLength(1);
  });

  it("Ollama running but refusing this origin: explains OLLAMA_ORIGINS with the exact origin", async () => {
    const o = await openAssistente();
    model.down = true;
    setServerProbe(() => Promise.resolve(true)); // something answers at the address
    await ask(o, "Qual o saldo?");
    const card = await within(log()).findByRole("alert", { name: /não aceita este endereço/ });
    const origin = window.location.origin;
    expect(origin).toMatch(/^https?:\/\//);
    expect(within(card).getByText(`OLLAMA_ORIGINS=${origin}`)).toBeTruthy();
    expect(card.textContent).toContain(`setx OLLAMA_ORIGINS "${origin}"`);
    expect(within(card).getByRole("button", { name: "Copiar origem" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
    await idle();
  });

  it("a model without tools is explained, with the way out", async () => {
    const o = await openAssistente();
    model.tools = false;
    await ask(o, "Qual o saldo?");
    const card = await within(log()).findByRole("alert", { name: "O modelo não aceita ferramentas" });
    expect(card.textContent).toMatch(/O modelo gemma4:12b não aceita ferramentas/);
    expect(within(card).getByRole("button", { name: "Abrir Configurações" })).toBeTruthy();
    expect(model.chats).toHaveLength(0); // never asked the model to use them
    await idle();
  });
});

describe("Assistente: CPF and CNPJ", () => {
  const CPF = "529.982.247-25";
  const CNPJ = "11.222.333/0001-81";

  it("are not reachable by the tools and appear neither on screen nor in what the model receives", async () => {
    const o = await openAssistente();
    const member = [...o.workspace.ledger.members.values()][0]!;
    o.workspace.act((ledger) =>
      tax.records.setMemberInfo(
        ledger,
        member.id,
        { cpf: CPF, birth_date: null, declared_by: null },
        o.workspace.today(),
      ),
    );
    model.turns.push(
      {
        calls: [
          { name: "list_members", arguments: {} },
          { name: "get_overview", arguments: {} },
        ],
      },
      { content: "Dois integrantes." },
    );
    await ask(o, "Quem são e qual o CPF deles?");
    expect(await said("Dois integrantes.")).toBeTruthy();
    for (const text of [CPF, CPF.replace(/\D/g, "")]) {
      expect(model.sent()).not.toContain(text);
      expect(document.body.textContent).not.toContain(text);
    }
    await idle();
  });

  it("a question that carries one is not sent", async () => {
    const o = await openAssistente();
    await ask(o, `O CPF ${CPF} aparece onde?`);
    expect(await screen.findByText(/Tire o CPF ou CNPJ da pergunta/)).toBeTruthy();
    expect(model.chats).toHaveLength(0);
    expect((screen.getByRole("textbox", { name: "Pergunta ao assistente" }) as HTMLInputElement).value).toContain(CPF);
    await ask(o, `E o CNPJ ${CNPJ}?`);
    expect(model.chats).toHaveLength(0);
  });

  it("one the model writes is hidden before it is shown", async () => {
    const o = await openAssistente();
    model.turns.push({ content: `O documento é ${CPF} e a empresa ${CNPJ}.` });
    await ask(o, "Qual o documento?");
    expect(await said(/\[CPF oculto\].*\[CNPJ oculto\]/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(CPF);
    expect(document.body.textContent).not.toContain(CNPJ);
    await idle();
  });
});

describe("Assistente: shortcuts to the Livro", () => {
  it("offers a button that opens the Livro filtered by a tag", async () => {
    const o = await openAssistente();
    const tag = (await import("@opesvault/domain")).dom.tags.allTags(o.workspace.ledger)[0]!;
    model.turns.push({ calls: [{ name: "show_in_ledger", arguments: { tag } }] }, { content: "Veja no Livro." });
    await ask(o, "Mostre o marcador");
    expect(await said("Veja no Livro.")).toBeTruthy();
    const group = within(log()).getByRole("group", { name: "Atalhos sugeridos pelo assistente" });
    await o.user.click(within(group).getByRole("button", { name: `Ver no Livro: marcador ${tag}` }));
    await screen.findByRole("heading", { level: 1, name: "Livro financeiro" });
    expect(o.router.state.location.pathname).toBe("/livro");
    // the Livro applied the filter (a tag chip) rather than showing every row
    await waitFor(() => expect(screen.getAllByText(new RegExp(tag)).length).toBeGreaterThan(0));
  });

  it("an account with a period carries the period", async () => {
    const o = await openAssistente();
    model.turns.push(
      {
        calls: [{ name: "show_in_ledger", arguments: { account: "Moradia", start: "2026-08-01", end: "2026-08-31" } }],
      },
      { content: "Aqui está." },
    );
    await ask(o, "Mostre a moradia de agosto");
    expect(await said("Aqui está.")).toBeTruthy();
    const group = within(log()).getByRole("group", { name: "Atalhos sugeridos pelo assistente" });
    const button = within(group).getByRole("button", { name: /Ver no Livro: Moradia, de 01\/08\/2026 a 31\/08\/2026/ });
    await o.user.click(button);
    await screen.findByRole("heading", { level: 1, name: "Livro financeiro" });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Período" }).textContent).toContain("Personalizado"),
    );
    expect((screen.getByLabelText("Data inicial") as HTMLInputElement).value).toBe("01/08/2026");
    expect((screen.getByLabelText("Data final") as HTMLInputElement).value).toBe("31/08/2026");
    expect(screen.getByRole("combobox", { name: "Conta ou categoria" }).textContent).toContain("Moradia");
  });
});

describe("Assistente: empty project", () => {
  it("says what the assistant can still do and answers", async () => {
    const o = await openAssistente({ project: "new" });
    // a new project has the AI off: the person turns it on in Configurações
    o.workspace.act((ledger) => dom.settings.updateSettings(ledger, { ai_enabled: true, ai_model: "gemma4:12b" }));
    expect(await screen.findByText(/O projeto ainda não tem lançamentos/)).toBeTruthy();
    model.turns.push({ calls: [{ name: "get_overview", arguments: {} }] }, { content: "O projeto está vazio." });
    await ask(o, "Como está o projeto?");
    expect(await said("O projeto está vazio.")).toBeTruthy();
    await idle();
  });
});
