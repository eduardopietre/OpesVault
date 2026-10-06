/**
 * The local AI in the Livro (desktop `pages/ledger/ai.py`): a second opinion on categories and readable
 * merchant names. Both commands look at the selected operations (two or more) or, otherwise, at every
 * operation the filters show. The model is asked in the background with descriptions only; what it proposes
 * comes back as a review where each change is checked, unchecked or edited. Only then the book changes: a
 * reclassification with its reason in the history, or an approved merchant name, as one undo step.
 */
import { edits, importing, type Id, type Ledger, type Operation, isActive } from "@opesvault/domain";
import { decide, notify } from "@opesvault/ui";
import { AI_OFF, failureText, modelLabel, plural, useAiClient } from "../../data/ai.ts";
import { useWorkspace } from "../../data/react.tsx";
import { useAiRun, type AiReviewDialogProps } from "../../dialogs/ai_review.tsx";
import { useFormAct } from "../../dialogs/livro_form.tsx";

/** Operations per run: a whole year of a busy family, minutes on a GPU. */
export const REVIEW_LIMIT = 2000;

export interface AiScope {
  ids: readonly Id[];
  /** "3 lançamentos selecionados" / "120 lançamentos exibidos". */
  label: string;
}

export type ReviewProps = Omit<AiReviewDialogProps, "open" | "onClose">;

function outcomeNotes(failed: number, cancelled: boolean): string {
  if (cancelled) return " (consulta cancelada antes do fim)";
  if (failed) return ` (${failed} sem resposta válida)`;
  return "";
}

function invert(names: ReadonlyMap<string, Id>): Map<Id, string> {
  return new Map([...names].map(([name, id]) => [id, name]));
}

interface CategoryEntry {
  ids: Id[];
  target: Id;
  source: string;
}

export function useLedgerAi(scope: () => AiScope, onReview: (props: ReviewProps) => void) {
  const workspace = useWorkspace();
  const client = useAiClient();
  const run = useAiRun();
  const act = useFormAct();

  const ready = (): boolean => {
    if (run.running) {
      notify("A IA local ainda está respondendo; aguarde ou cancele.");
      return false;
    }
    if (client === null) {
      notify(AI_OFF);
      return false;
    }
    return true;
  };

  const failed = (result: unknown) =>
    void decide({ title: "IA local", text: failureText(result), choices: [], cancelLabel: "Entendi" });

  const show = onReview;

  const suggestCategories = () => {
    if (!ready() || client === null) return;
    const ledger = workspace.ledger;
    const { ids, label } = scope();
    if (ids.length > REVIEW_LIMIT) {
      notify(`São ${ids.length} lançamentos; filtre até ${REVIEW_LIMIT} (um período ou uma conta).`);
      return;
    }
    const requests = importing.aiSuggestions.planOperations(ledger, ids);
    if (!requests.length) {
      notify(`IA local: nada a classificar em ${label} (só receitas e despesas de uma categoria).`);
      return;
    }
    const total = requests.reduce((n, r) => n + r.descriptions.length, 0);
    run.start(
      client,
      (report, cancel) => importing.aiSuggestions.ask(client, requests, report, cancel),
      total,
      "descrição(ões)",
      (result) => {
        if (typeof result !== "object" || result === null || !("planned" in result)) return failed(result);
        reviewCategories(result as importing.aiSuggestions.AiOutcome, label);
      },
    );
  };

  const reviewCategories = (outcome: importing.aiSuggestions.AiOutcome, label: string) => {
    const ledger: Ledger = workspace.ledger;
    const names = new Map<Id, string>();
    for (const kind of importing.learning.KINDS) {
      for (const [id, name] of invert(importing.aiSuggestions.categoryNames(ledger, kind))) names.set(id, name);
    }
    // One line per description and suggested category, only where something would change.
    const lines = new Map<string, { ops: Operation[]; target: Id; source: string }>();
    for (const plan of outcome.planned) {
      const op = ledger.operations.get(plan.item_id);
      const found = op !== undefined && isActive(op) ? importing.learning.categoryOf(ledger, op) : null;
      if (op === undefined || found === null || found[0] === plan.category_id) continue;
      const key = `${importing.aiSuggestions.questionKey(op.description)}\u0000${plan.category_id}`;
      const line = lines.get(key) ?? { ops: [], target: plan.category_id, source: plan.source };
      line.ops.push(op);
      lines.set(key, line);
    }
    const notes = outcomeNotes(outcome.failed, outcome.cancelled);
    if (!lines.size) {
      notify(`IA local: concorda com as categorias de ${label}${notes}.`);
      return;
    }
    const entries = [...lines.values()].sort(
      (a, b) => b.ops.length - a.ops.length || (a.ops[0]?.description ?? "").localeCompare(b.ops[0]?.description ?? ""),
    );
    const rows = entries.map(({ ops, target }) => {
      const current = new Set(
        ops.flatMap((op) => {
          const c = importing.learning.categoryOf(ledger, op);
          return c ? [names.get(c[0]) ?? "?"] : [];
        }),
      );
      return [ops[0]?.description ?? "", String(ops.length), [...current].sort().join(", "), names.get(target) ?? "?"];
    });
    const picked: CategoryEntry[] = entries.map((e) => ({
      ids: e.ops.map((o) => o.id),
      target: e.target,
      source: e.source,
    }));
    show({
      title: "Sugestões de categoria",
      intro:
        `A IA local (${modelLabel(entries[0]?.source)}) sugere outra categoria para ` +
        `${plural(rows.length, "descrição", "descrições")} de ${label}${notes}. Desmarque o que não for; ` +
        "as marcadas serão reclassificadas, com o motivo no histórico de cada lançamento.",
      headers: ["Descrição", "Lançamentos", "Categoria atual", "Sugerida"],
      rows,
      confirmLabel: "Reclassificar marcadas",
      onApply: (chosen) => {
        let changed = 0;
        let skipped = 0;
        const errors: string[] = [];
        act((l) => {
          for (const [row] of chosen) {
            const entry = picked[row];
            if (entry === undefined) continue;
            const reason = `Sugestão da IA local conferida na revisão (${entry.source})`;
            const result = edits.reclassify(l, entry.ids, entry.target, reason);
            changed += result.changed;
            skipped += result.skipped;
            errors.push(...result.errors);
          }
        });
        const message = `IA local: ${changed} reclassificado(s), ${skipped} mantido(s).`;
        if (errors.length) {
          void decide({
            title: "Reclassificação",
            text: [message, ...errors.slice(0, 10)].join("\n"),
            choices: [],
            cancelLabel: "Entendi",
          });
        } else notify(message);
      },
    });
  };

  const suggestNames = () => {
    if (!ready() || client === null) return;
    const ledger = workspace.ledger;
    const { ids, label } = scope();
    if (ids.length > REVIEW_LIMIT) {
      notify(`São ${ids.length} lançamentos; filtre até ${REVIEW_LIMIT} (um período ou uma conta).`);
      return;
    }
    const request = importing.aiMerchants.planNames(ledger, ids);
    if (!request.descriptions.length) {
      notify(`IA local: todos os estabelecimentos de ${label} já têm nome aprovado.`);
      return;
    }
    run.start(
      client,
      (report, cancel) => importing.aiMerchants.askNames(client, request, report, cancel),
      request.descriptions.length,
      "estabelecimento(s)",
      (result) => {
        if (typeof result !== "object" || result === null || !("proposals" in result)) return failed(result);
        reviewNames(result as importing.aiMerchants.NameOutcome, label);
      },
    );
  };

  const reviewNames = (outcome: importing.aiMerchants.NameOutcome, label: string) => {
    const notes = outcomeNotes(outcome.failed, outcome.cancelled);
    const proposals = [...outcome.proposals].sort(
      (a, b) => b.count - a.count || a.description.localeCompare(b.description),
    );
    if (!proposals.length) {
      notify(`IA local: nenhum nome novo para os estabelecimentos de ${label}${notes}.`);
      return;
    }
    show({
      title: "Nomes de estabelecimentos",
      intro:
        `A IA local (${modelLabel(proposals[0]?.source)}) sugere nomes para ` +
        `${plural(proposals.length, "estabelecimento", "estabelecimentos")} de ${label}${notes}. Ajuste um nome ` +
        "no campo ou desmarque-o; os marcados passam a valer em busca, relatórios e regras. " +
        "As descrições do banco não mudam.",
      headers: ["Descrição do banco", "Lançamentos", "Nome atual", "Nome sugerido"],
      rows: proposals.map((p) => [p.description, String(p.count), p.current, p.name]),
      editable: 3,
      confirmLabel: "Aprovar marcados",
      onApply: (chosen) => {
        const [count, refused] = act((l) =>
          importing.aiMerchants.applyNames(
            l,
            chosen.map(([row, name]) => [proposals[row] as importing.aiMerchants.NameProposal, name] as const),
          ),
        );
        const message = `IA local: ${plural(count, "nome aprovado", "nomes aprovados")}.`;
        if (refused.length) {
          void decide({
            title: "Nomes de estabelecimentos",
            text: [message, ...refused.slice(0, 10)].join("\n"),
            choices: [],
            cancelLabel: "Entendi",
          });
        } else notify(message);
      },
    });
  };

  return {
    client,
    run,
    suggestCategories,
    suggestNames,
  };
}
