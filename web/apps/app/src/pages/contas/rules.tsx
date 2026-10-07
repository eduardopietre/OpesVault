/**
 * Regras (desktop `accounts/rules.py`): the user's categorization rules and the ones their own choices
 * suggest. Three sources of a category, from most to least trusted: a choice made by hand, a rule of the
 * user, what the app learned from the family's choices, the built-in keyword rules. This tab shows the
 * rules, warns when the family keeps choosing something else for one, and offers as rules the descriptions
 * categorized the same way several times (docs/05 §6).
 */
import { importing, type Id } from "@opesvault/domain";
import { Collapsible, notify } from "@opesvault/ui";
import { useState } from "react";
import { useLedger, useWorkspace } from "../../data/react.tsx";
import { ReasonDialog } from "../../dialogs/livro_prompts.tsx";
import { useFormAct } from "../../dialogs/livro_form.tsx";
import { RuleDialog } from "../../dialogs/rule_dialog.tsx";
import {
  type TabReveal,
  EditButton,
  Empty,
  ListTable,
  Toolbar,
  Warn,
  useTabReveal,
} from "../../components/list_parts.tsx";
import type { TierColumn } from "../../components/tier_columns.ts";
import { proposalRows, ruleRows, type ProposalRow, type RuleRow } from "./rows.ts";
import { useDialog } from "../../data/dialog.ts";

const { rules, suggestions } = importing;

const COLUMNS: TierColumn<RuleRow>[] = [
  {
    id: "pattern",
    header: "A descrição contém",
    cell: (r) => r.pattern,
    sortValue: (r) => r.pattern,
    grow: 2,
    width: 170,
    tier: 1,
  },
  {
    id: "category",
    header: "Categoria",
    cell: (r) => r.category,
    sortValue: (r) => r.category,
    grow: 1,
    width: 140,
    tier: 1,
  },
  {
    id: "scope",
    header: "Vale para",
    cell: (r) => r.scope,
    sortValue: (r) => r.scope,
    grow: 1,
    width: 130,
    tier: 2,
  },
  { id: "uses", header: "Usos", cell: (r) => r.uses, sortValue: (r) => r.uses, align: "end", width: 70, tier: 2 },
  {
    id: "state",
    header: "Situação",
    cell: (r) =>
      r.contradicted ? (
        <Warn>{r.state}</Warn>
      ) : (
        <span className={r.active ? undefined : "text-secondary"}>{r.state}</span>
      ),
    sortValue: (r) => r.state,
    grow: 3,
    width: 220,
    tier: 1,
  },
];

const PROPOSAL_COLUMNS: TierColumn<ProposalRow>[] = [
  { id: "pattern", header: "A descrição contém", cell: (r) => r.pattern, grow: 2, width: 170, tier: 1 },
  { id: "category", header: "Categoria", cell: (r) => r.category, grow: 1, width: 140, tier: 1 },
  { id: "count", header: "Vezes", cell: (r) => r.count, align: "end", width: 80, tier: 1 },
];

type Spec =
  | { kind: "rule"; id: Id | null; proposal: ProposalRow | null }
  | { kind: "toggle"; id: Id; active: boolean; pattern: string };

export function RulesTab({ reveal }: { reveal?: TabReveal<Id> | null }) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const rows = useLedger(ruleRows);
  const proposals = useLedger(proposalRows);
  const [pick, setPick] = useState<Id | null>(null);
  const [proposal, setProposal] = useState<string | null>(null);
  const dialog = useDialog<Spec>();
  const selected = rows.find((r) => r.id === pick) ?? null;
  const chosenProposal = proposals.find((p) => p.id === proposal) ?? null;
  useTabReveal(reveal, setPick);

  const needsRule = (id: Id | null = pick): Id | null => {
    if (id === null || !rules.rules(ledger).has(id)) {
      notify("Escolha uma regra.");
      return null;
    }
    return id;
  };
  const edit = (id: Id | null = pick) => {
    const rule = needsRule(id);
    if (rule) dialog.show({ kind: "rule", id: rule, proposal: null });
  };
  const toggle = () => {
    const rule = needsRule();
    const found = rule ? rules.rules(ledger).get(rule) : undefined;
    if (found) dialog.show({ kind: "toggle", id: found.id, active: found.active, pattern: found.pattern });
  };
  const fromProposal = (id: string | null = proposal) => {
    const found = proposals.find((p) => p.id === id);
    if (!found) {
      notify("Escolha uma das regras sugeridas.");
      return;
    }
    dialog.show({ kind: "rule", id: null, proposal: found });
  };

  const editing = dialog.spec?.kind === "rule" && dialog.spec.id ? rules.rules(ledger).get(dialog.spec.id) : undefined;
  const toggling = dialog.spec?.kind === "toggle" ? dialog.spec : null;

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[80ch] text-caption text-secondary">
        Regras sugerem a categoria de itens importados; nada é aprovado sozinho. A escolha feita à mão vale mais que
        tudo; depois vêm as suas regras, o que o OpesVault aprendeu com as escolhas de vocês e, por último, as regras
        padrão.
      </p>
      <Toolbar label="Comandos das regras">
        <EditButton variant="primary" onClick={() => dialog.show({ kind: "rule", id: null, proposal: null })}>
          Nova regra…
        </EditButton>
        <EditButton onClick={() => edit()}>Editar…</EditButton>
        <EditButton onClick={toggle}>Ativar ou desativar…</EditButton>
      </Toolbar>

      {rows.length ? (
        <ListTable
          label="Regras de categoria"
          rows={rows}
          columns={COLUMNS}
          getRowId={(r) => r.id}
          selectedId={selected?.id ?? null}
          onSelect={setPick}
          onActivate={(id) => edit(id)}
          max={12}
        />
      ) : (
        <Empty title="Nenhuma regra sua">
          Uma regra liga um trecho da descrição a uma categoria. Crie a primeira ou aproveite as sugeridas pelo uso.
        </Empty>
      )}

      {proposals.length ? (
        <Collapsible
          title="Sugeridas pelo uso"
          prefKey="contas/regras_sugeridas"
          description="Descrições que vocês categorizaram do mesmo jeito várias vezes. Virar regra é decisão sua: sem regra, o OpesVault continua sugerindo pelo que aprendeu."
          actions={
            <EditButton size="sm" onClick={() => fromProposal()}>
              Criar regra…
            </EditButton>
          }
        >
          <ListTable
            label="Regras sugeridas pelo uso"
            rows={proposals}
            columns={PROPOSAL_COLUMNS}
            getRowId={(r) => r.id}
            selectedId={chosenProposal?.id ?? null}
            onSelect={setProposal}
            onActivate={(id) => fromProposal(id)}
            max={12}
          />
        </Collapsible>
      ) : null}

      {dialog.spec?.kind === "rule" ? (
        <RuleDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          {...(editing ? { rule: editing } : {})}
          {...(dialog.spec.proposal
            ? { description: dialog.spec.proposal.pattern, targetId: dialog.spec.proposal.categoryId }
            : {})}
          onDone={(rule, changed) => {
            setPick(rule.id);
            const pending = `${changed} item(ns) pendente(s) recategorizado(s).`;
            notify(
              editing
                ? "Regra alterada."
                : dialog.spec?.kind === "rule" && dialog.spec.proposal
                  ? `Regra “${rule.pattern}” criada. ${pending}`
                  : `Regra criada. ${pending}`,
            );
          }}
        />
      ) : null}
      {toggling ? (
        <ReasonDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          title={`${toggling.active ? "Desativar" : "Ativar"} regra`}
          confirmLabel={toggling.active ? "Desativar" : "Ativar"}
          description={`A regra “${toggling.pattern}” ${toggling.active ? "deixa de sugerir categorias; o histórico guarda o motivo." : "volta a sugerir categorias aos itens pendentes."}`}
          onSubmit={(reason) => {
            const changed = act((l) => {
              rules.setActive(l, toggling.id, !toggling.active, reason);
              return suggestions.applyRules(l);
            });
            notify(`Regra ${toggling.active ? "desativada" : "ativada"}. ${changed} item(ns) pendente(s) revisto(s).`);
          }}
        />
      ) : null}
    </div>
  );
}
