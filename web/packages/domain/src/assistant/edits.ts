/**
 * Edit tools: changes the assistant may propose. None of them changes anything by itself.
 * Port of `assistant/edits.py`.
 *
 * `prepare` resolves names and ids, runs every check it can and describes the change in words
 * (`PreparedEdit`); a wrong argument is a ToolError the model can fix. The ledger only changes in
 * `PreparedEdit.apply`, which the page calls after the user approves, as one undo step. Changes that
 * keep history carry the origin ("assistente, ollama:<modelo>:a1@…") in the reason.
 */
import * as budget from "../domain/budget.ts";
import { reclassify } from "../domain/edits.ts";
import type { Ledger } from "../domain/ledger.ts";
import * as merchants from "../domain/merchants.ts";
import { AccountType, cashDate, isActive, type Operation } from "../domain/model.ts";
import { formatBrl } from "../domain/money.ts";
import * as tags from "../domain/tags.ts";
import { formatDateBr, ymBr } from "../lib/dates.ts";
import type { Id } from "../lib/ids.ts";
import { ItemStatus } from "../importing/model.ts";
import * as learning from "../importing/learning.ts";
import * as pipeline from "../importing/pipeline.ts";
import * as rules from "../importing/rules.ts";
import { collapseSpaces, pyLen, pyStrip } from "../lib/py.ts";
import { casefold } from "../lib/text.ts";
import { amountOf } from "./reads.ts";
import {
  type ArgSpec,
  type Args,
  accountLabel,
  day,
  findAccount,
  findCategory,
  findOperation,
  guarded,
  hex,
  money,
  month,
  type PreparedEdit,
  Registry,
  text,
  type Tool,
  ToolError,
  ToolKind,
  type ToolContext,
} from "./tools.ts";

export const MAX_DETAILS = 20; // lines listed in the approval; the rest are counted
export const MAX_IDS = 200;

const IDS_FIELD = { kind: "strlist", description: "'id' dos lançamentos", min: 1, max: MAX_IDS } as const;
const AMOUNT = (description: string) => ({ kind: "any", description }) as const;

const RECLASSIFY_ARGS: ArgSpec = [
  ["ids", IDS_FIELD],
  ["category", text("Nome da nova categoria")],
  ["reason", text("Motivo, que fica no histórico", 3, 200)],
];
const TAG_ARGS: ArgSpec = [
  ["ids", IDS_FIELD],
  ["tag", text("Marcador, ex.: Viagem 2026", 1, 40)],
  ["remove", { kind: "bool", description: "true para tirar o marcador em vez de pôr", default: false }],
];
const MERCHANT_ARGS: ArgSpec = [
  ["description", text("Descrição do banco, como no lançamento", 1, 200)],
  ["name", text("Nome legível, ex.: iFood", 1, 60)],
];
const RULE_ARGS: ArgSpec = [
  ["pattern", text("Trecho que a descrição contém", 3, 80)],
  ["category", text("Categoria que a regra sugere")],
];
const BUDGET_ARGS: ArgSpec = [
  ["month", text("Mês AAAA-MM")],
  ["category", text("Categoria de despesa")],
  ["amount", AMOUNT("Valor planejado, ex.: 800.00")],
];
const ENTRY_ARGS: ArgSpec = [
  ["account", text("Conta de onde sai (despesa) ou para onde vai (receita) o dinheiro")],
  ["category", text("Categoria")],
  ["amount", AMOUNT("Valor, ex.: 87.40")],
  ["date", text("Data AAAA-MM-DD")],
  ["description", text("", 1, 200)],
];
const ITEM_ARGS: ArgSpec = [
  ["item", text("'id' do item, devolvido por list_pending_import_items")],
  ["category", text("Categoria escolhida")],
];

const s = (v: unknown) => v as string;

function when(op: Operation): string {
  const found = op.occurred_on ?? cashDate(op);
  return found ? formatDateBr(found) : "sem data";
}

function listing(lines: string[]): string[] {
  if (lines.length <= MAX_DETAILS) return lines;
  return [...lines.slice(0, MAX_DETAILS), `… e mais ${lines.length - MAX_DETAILS}`];
}

function operationsOf(ledger: Ledger, ids: readonly string[]): Operation[] {
  const found = new Map<Id, Operation>();
  for (const ref of ids) {
    const op = findOperation(ledger, ref);
    if (!isActive(op)) throw new ToolError(`O lançamento ${ref} está cancelado e não pode ser alterado.`);
    found.set(op.id, op);
  }
  return [...found.values()];
}

function reasonOf(origin: string, reason: string): string {
  return `${collapseSpaces(reason)} (assistente, ${origin})`;
}

// ── reclassify ──────────────────────────────────────

function prepareReclassify(ledger: Ledger, args: Args, origin: string): PreparedEdit {
  const target = findCategory(ledger, s(args["category"]));
  const lines: string[] = [];
  const moving: Operation[] = [];
  for (const op of operationsOf(ledger, args["ids"] as string[])) {
    const current = learning.categoryOf(ledger, op);
    if (current === null) {
      throw new ToolError(
        `O lançamento ${hex(op.id).slice(0, 8)} não tem uma única categoria (é transferência ou rateio); ` +
          "reclassifique pela tela do Livro.",
      );
    }
    if (current[1] !== target.type)
      throw new ToolError(
        `O lançamento ${hex(op.id).slice(0, 8)} é de outro tipo que a categoria '${s(args["category"])}'.`,
      );
    if (current[0] === target.id) continue;
    moving.push(op);
    const old = accountLabel(ledger, ledger.account(current[0]));
    lines.push(`${when(op)} · ${op.description} · ${formatBrl(amountOf(ledger, op))}: ${old} → `);
  }
  if (!moving.length) throw new ToolError(`Os lançamentos já estão na categoria '${s(args["category"])}'.`);
  const label = accountLabel(ledger, target);
  const reason = reasonOf(origin, s(args["reason"]));

  const apply = (): Record<string, unknown> => {
    const result = guarded(() =>
      reclassify(
        ledger,
        moving.map((op) => op.id),
        target.id,
        reason,
      ),
    );
    if (!result.changed) {
      // the operations changed between the proposal and the approval
      throw new ToolError("Nada foi reclassificado: " + (result.errors.join("; ") || "os lançamentos mudaram."));
    }
    return { resultado: "aplicado", reclassificados: result.changed, mantidos: result.skipped };
  };

  return {
    tool: "reclassify_operations",
    summary: `Reclassificar ${moving.length} lançamento(s) para ${label}`,
    details: [...listing(lines.map((line) => line + label)), `Motivo no histórico: ${pyStrip(s(args["reason"]))}`],
    apply,
  };
}

// ── tags ────────────────────────────────────────────

function prepareTag(ledger: Ledger, args: Args): PreparedEdit {
  const tag = tags.normalize(s(args["tag"]));
  if (!tag) throw new ToolError("Informe o marcador.");
  const ops = operationsOf(ledger, args["ids"] as string[]);
  const remove = args["remove"] as boolean;
  const has = ops.filter((op) => tags.tagsOf(ledger, op.id).some((t) => casefold(t) === casefold(tag)));
  const hasIds = new Set(has.map((op) => op.id));
  const affected = remove ? has : ops.filter((op) => !hasIds.has(op.id));
  if (!affected.length)
    throw new ToolError("Nada a mudar: " + (remove ? "nenhum tem esse marcador." : "todos já o têm."));
  const lines = affected.map((op) => `${when(op)} · ${op.description} · ${formatBrl(amountOf(ledger, op))}`);
  const ids = affected.map((op) => op.id);

  const apply = (): Record<string, unknown> => {
    const count = guarded(() => (remove ? tags.removeTag(ledger, ids, tag) : tags.addTag(ledger, ids, tag)));
    if (!count) throw new ToolError("Nada mudou: os lançamentos mudaram depois da proposta.");
    return { resultado: "aplicado", lancamentos: count };
  };

  const verb = remove ? "Tirar o marcador" : "Marcar com";
  return {
    tool: "tag_operations",
    summary: `${verb} “${tag}” ${affected.length} lançamento(s)`,
    details: listing(lines),
    apply,
  };
}

// ── merchant name ───────────────────────────────────

function prepareMerchant(ledger: Ledger, args: Args, origin: string): PreparedEdit {
  const name = collapseSpaces(s(args["name"]));
  const key = merchants.keyOf(s(args["description"]));
  const alike = [...ledger.activeOperations()].filter((op) => merchants.keyOf(op.description) === key);
  if (!alike.length) throw new ToolError("Nenhum lançamento tem essa descrição; copie-a de search_operations.");
  const current = merchants.merchantOf(ledger, s(args["description"]));
  if (current === name) throw new ToolError(`O estabelecimento já se chama '${name}'.`);

  const apply = (): Record<string, unknown> => {
    guarded(() => merchants.nameMerchant(ledger, s(args["description"]), name, `assistente, ${origin}`));
    return { resultado: "aplicado", lancamentos: alike.length };
  };

  return {
    tool: "name_merchant",
    summary: `Chamar “${current}” de “${name}”`,
    details: [
      `Vale para ${alike.length} lançamento(s) com descrições como “${alike[0]!.description}”.`,
      "As descrições do banco não mudam; busca, relatórios e regras passam a mostrar o nome.",
    ],
    apply,
  };
}

// ── category rule ───────────────────────────────────

function prepareRule(ledger: Ledger, args: Args): PreparedEdit {
  const target = findCategory(ledger, s(args["category"]));
  const pattern = rules.normalize(s(args["pattern"]));
  if (pyLen(pattern) < rules.MIN_PATTERN)
    throw new ToolError(`O trecho precisa ter ao menos ${rules.MIN_PATTERN} letras.`);
  if ([...rules.rules(ledger).values()].some((r) => r.pattern === pattern && r.active))
    throw new ToolError(`Já existe uma regra para '${pattern}'.`);
  let matched = 0;
  for (const op of ledger.activeOperations()) if (rules.normalize(op.description).includes(pattern)) matched += 1;
  const label = accountLabel(ledger, target);

  const apply = (): Record<string, unknown> => {
    guarded(() => rules.addRule(ledger, pattern, target.id));
    return { resultado: "aplicado" };
  };

  return {
    tool: "create_category_rule",
    summary: `Criar a regra “contém ${pattern}” → ${label}`,
    details: [
      `Hoje ${matched} lançamento(s) contêm esse trecho; a regra vale para as próximas importações.`,
      "Regras só sugerem: a escolha feita à mão na revisão continua valendo.",
    ],
    apply,
  };
}

// ── budget ──────────────────────────────────────────

function prepareBudget(ledger: Ledger, args: Args): PreparedEdit {
  const at = month(s(args["month"]));
  if (at === null) throw new ToolError("Informe o mês, AAAA-MM.");
  const target = findCategory(ledger, s(args["category"]), AccountType.EXPENSE);
  const value = money(args["amount"]);
  const current = budget.lineFor(ledger, target.id, at);
  if (current !== null && current.amount.eq(value)) throw new ToolError("O orçamento já tem esse valor.");
  const label = accountLabel(ledger, target);
  const before = current !== null ? formatBrl(current.amount) : "sem plano";

  const apply = (): Record<string, unknown> => {
    guarded(() => budget.setBudget(ledger, target.id, at, value));
    return { resultado: "aplicado" };
  };

  return {
    tool: "set_budget",
    summary: `Orçamento de ${label} em ${ymBr(at)}: ${formatBrl(value)}`,
    details: [`Antes: ${before}.`],
    apply,
  };
}

// ── new operations ──────────────────────────────────

function prepareEntry(ledger: Ledger, args: Args, kind: AccountType, ctx: ToolContext): PreparedEdit {
  const account = findAccount(ledger, s(args["account"]), false);
  if (account.type !== AccountType.ASSET)
    throw new ToolError(
      `'${s(args["account"])}' não é conta corrente, poupança ou carteira; compras no cartão: pela tela.`,
    );
  const category = findCategory(ledger, s(args["category"]), kind);
  const value = money(args["amount"]);
  const at = day(s(args["date"]));
  if (at === null) throw new ToolError("Informe a data, AAAA-MM-DD.");
  if (at > ctx.today) throw new ToolError("A data está no futuro; para algo previsto, use Recorrências.");
  const description = collapseSpaces(s(args["description"]));
  const expense = kind === AccountType.EXPENSE;

  const apply = (): Record<string, unknown> => {
    const op = guarded(() =>
      expense
        ? ledger.recordExpense(account.id, category.id, value, at, description)
        : ledger.recordIncome(account.id, category.id, value, at, description),
    );
    return { resultado: "aplicado", id: hex(op.id).slice(0, 8) };
  };

  const label = expense ? "Despesa" : "Receita";
  const flow = expense
    ? `${account.name} → ${accountLabel(ledger, category)}`
    : `${accountLabel(ledger, category)} → ${account.name}`;
  return {
    tool: expense ? "record_expense" : "record_income",
    summary: `${label}: ${description}, ${formatBrl(value)} em ${formatDateBr(at)}`,
    details: [flow],
    apply,
  };
}

// ── import review ───────────────────────────────────

function prepareItem(ledger: Ledger, args: Args, origin: string): PreparedEdit {
  const ref = pyStrip(s(args["item"])).toLowerCase().replaceAll("-", "");
  const found = [...pipeline.items(ledger).values()].filter((i) => pyLen(ref) >= 8 && hex(i.id).startsWith(ref));
  if (found.length !== 1)
    throw new ToolError(`Não existe item com id '${s(args["item"])}'. Use list_pending_import_items.`);
  const item = found[0]!;
  if (item.status !== ItemStatus.READY && item.status !== ItemStatus.NEEDS_REVIEW)
    throw new ToolError("Esse item já foi revisado.");
  const category = findCategory(ledger, s(args["category"]));
  const label = accountLabel(ledger, category);

  const apply = (): Record<string, unknown> => {
    guarded(() => pipeline.correctItem(ledger, item.id, "target_account_id", category.id, `assistente, ${origin}`));
    return { resultado: "aplicado", observacao: "o item continua aguardando aprovação na revisão" };
  };

  const amount = item.amount !== null ? formatBrl(item.amount) : "sem valor";
  return {
    tool: "set_import_item_category",
    summary: `Categoria do item importado: ${label}`,
    details: [`${item.description} · ${amount}`, "O item continua na revisão; aprovar continua sendo com você."],
    apply,
  };
}

type PrepareFn = (ledger: Ledger, args: Args, origin: string, ctx: ToolContext) => PreparedEdit;

export const EDITS: readonly (readonly [string, string, ArgSpec, PrepareFn])[] = [
  [
    "reclassify_operations",
    "Propõe mudar a categoria de lançamentos (precisa da aprovação do usuário).",
    RECLASSIFY_ARGS,
    prepareReclassify,
  ],
  ["tag_operations", "Propõe pôr ou tirar um marcador de lançamentos (precisa de aprovação).", TAG_ARGS, prepareTag],
  [
    "name_merchant",
    "Propõe um nome legível para um estabelecimento, a partir da descrição do banco (precisa de aprovação).",
    MERCHANT_ARGS,
    prepareMerchant,
  ],
  [
    "create_category_rule",
    "Propõe uma regra: descrições com um trecho recebem uma categoria (precisa de aprovação).",
    RULE_ARGS,
    prepareRule,
  ],
  [
    "set_budget",
    "Propõe o valor do orçamento de uma categoria num mês (precisa de aprovação).",
    BUDGET_ARGS,
    prepareBudget,
  ],
  [
    "record_expense",
    "Propõe registrar uma despesa paga por uma conta (precisa de aprovação).",
    ENTRY_ARGS,
    (ledger, args, _origin, ctx) => prepareEntry(ledger, args, AccountType.EXPENSE, ctx),
  ],
  [
    "record_income",
    "Propõe registrar uma receita numa conta (precisa de aprovação).",
    ENTRY_ARGS,
    (ledger, args, _origin, ctx) => prepareEntry(ledger, args, AccountType.INCOME, ctx),
  ],
  [
    "set_import_item_category",
    "Propõe a categoria de um item importado que aguarda revisão (precisa de aprovação).",
    ITEM_ARGS,
    prepareItem,
  ],
];

export function register(registry: Registry): void {
  for (const [name, description, spec, prepare] of EDITS) {
    const tool: Tool = { name, description, arguments: spec, kind: ToolKind.EDIT, run: null, prepare };
    registry.add(tool);
  }
}
