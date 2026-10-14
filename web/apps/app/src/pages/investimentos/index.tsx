/**
 * Investimentos (desktop `ui/pages/investments/`): the portfolio, then the selected investment with its
 * figures, charts and tables, the commands that register what happens to it (valuation, contribution,
 * distribution, redemption, trades), the redemption simulator, the characteristics, the brokerage notes and
 * the reference indices. One scrolling page. A link from another screen selects the position (a maturity
 * notice) and may start an action: "avaliar" opens the new valuation, "simular" the simulator.
 */
import { dom, investments, type Id } from "@opesvault/domain";
import {
  Button,
  EmptyState,
  MenuButton,
  PageHeader,
  Section,
  notify,
  useMotionPreset,
  type MenuEntry,
  type TableFilter,
  type TableSearch,
} from "@opesvault/ui";
import { useNavigate } from "@tanstack/react-router";
import { Table2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";
import { InvestmentDialog } from "../../dialogs/bank_investment.tsx";
import { InvestmentBenchmarkDialog } from "../../dialogs/investment_benchmark.tsx";
import {
  InvestmentContributionDialog,
  InvestmentDistributionDialog,
  InvestmentTaxPaymentDialog,
} from "../../dialogs/investment_flow.tsx";
import { InvestmentPositionDialog } from "../../dialogs/investment_position.tsx";
import {
  InvestmentCompleteDialog,
  InvestmentNetOnlyDialog,
  InvestmentRedemptionDialog,
  type RedemptionPrefill,
} from "../../dialogs/investment_redeem.tsx";
import { InvestmentRuleDialog } from "../../dialogs/investment_rule.tsx";
import { InvestmentSimulateDialog } from "../../dialogs/investment_simulate.tsx";
import { InvestmentTradeDialog, type TradeKind } from "../../dialogs/investment_trade.tsx";
import { useRemoveInvestment } from "../../dialogs/investment_remove.ts";
import { InvestmentFixDialog, InvestmentValuationDialog } from "../../dialogs/investment_valuation.tsx";
import { useAct, useLedger, useWorkspace } from "../../data/react.tsx";
import { useGoTo, useReveal } from "../../data/navigation.ts";
import { Empty, EditButton, ListTable, Toolbar, usePick } from "../../components/list_parts.tsx";
import { NOTE_COLUMNS, PORTFOLIO_COLUMNS } from "./columns.tsx";
import { Detail } from "./detail.tsx";
import { SavingsPanel } from "./savings_panel.tsx";
import {
  eventRows,
  noteRows,
  parseReveal,
  portfolioRows,
  summaryLine,
  valuationRows,
  type NoteRow,
  type PortfolioRow,
} from "./rows.ts";
import { useDialog } from "../../data/dialog.ts";
import { lockEntries, useLock } from "../../data/read_only.ts";
import { accountRef } from "../livro/rows.ts";

const { service, model } = investments;

const PORTFOLIO_SEARCH: TableSearch<PortfolioRow> = {
  text: (row) => `${row.name} ${row.assetClass} ${row.mode}`,
  placeholder: "Buscar investimento",
};
const PORTFOLIO_FILTERS: readonly TableFilter<PortfolioRow>[] = [
  { id: "closed", label: "Ocultar posições encerradas", keep: (row) => !row.closed },
];
const NOTE_SEARCH: TableSearch<NoteRow> = {
  text: (row) => `${row.number} ${row.date} ${row.assets}`,
  placeholder: "Buscar nota ou ativo",
};

type Spec =
  | { kind: "position" }
  | { kind: "valuation"; positionId: Id }
  | { kind: "fix"; valuationId: Id }
  | { kind: "contribution" | "distribution" | "netonly" | "simulate" | "profile"; positionId: Id }
  | { kind: "redeem"; positionId: Id; prefill: RedemptionPrefill | null }
  | { kind: "complete"; eventId: Id }
  | { kind: "trade"; trade: TradeKind; positionId: Id }
  | { kind: "tax" | "benchmark" }
  /** `then`: the simulator asked for the rule first; it opens on this position once the rule is saved. */
  | { kind: "rule"; then?: Id };

export function Page() {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useAct();
  const goTo = useGoTo();
  const navigate = useNavigate();
  const { locked } = useLock();
  const preset = useMotionPreset();
  const today = workspace.today();
  const rows = useLedger((l) => portfolioRows(l, today), today);
  const summary = useLedger((l) => summaryLine(l));
  const notes = useLedger((l) => noteRows(l));
  const dialog = useDialog<Spec>();
  const ruleSaved = useRef(false);

  const { setPick, selected, need: needRow } = usePick(rows, (r) => r.id, { first: true });
  // the rows chosen in the tables of the detail belong to one investment
  const [chosen, setChosen] = useState<{ positionId: Id | null; valuation: Id | null; event: Id | null }>({
    positionId: null,
    valuation: null,
    event: null,
  });
  const valuationPick = chosen.positionId === selected?.id ? chosen.valuation : null;
  const eventPick = chosen.positionId === selected?.id ? chosen.event : null;
  const [notePick, setNotePick] = useState<string | null>(null);
  const note: NoteRow | null = notes.find((n) => n.id === notePick) ?? null;

  const nameOf = (id: Id): string => {
    const position = service.positions(ledger).get(id);
    return position ? (service.assets(ledger).get(position.asset_id)?.name ?? "") : "";
  };

  // ── commands ─────────────────────────────────────

  const need = (): Id | null => {
    const row = needRow("Selecione um investimento.");
    if (row?.savings) {
      notify("A poupança acompanha os lançamentos da conta: registre depósitos, retiradas e juros no Livro.");
      return null;
    }
    return row?.id ?? null;
  };

  const withPosition = (make: (positionId: Id) => Spec) => () => {
    const id = need();
    if (id) dialog.show(make(id));
  };

  const trade = (kind: TradeKind) => () => {
    const id = need();
    if (!id) return;
    if (service.position(ledger, id).mode !== model.TrackingMode.QUANTITY) {
      notify("Negociações são para ativos acompanhados por quantidade; este investimento é acompanhado por valor.");
      return;
    }
    dialog.show({ kind: "trade", trade: kind, positionId: id });
  };

  const simulate = (positionId: Id | null = need()) => {
    if (!positionId) return;
    // The application brings no rule: the simulator needs one of the person's own, so that comes first.
    if (ledger.entities("tax_rule").size === 0) {
      dialog.show({ kind: "rule", then: positionId });
      return;
    }
    dialog.show({ kind: "simulate", positionId });
  };

  const useValuation = () => {
    const found = valuationPick ? valuationRows(ledger, selected!.id).find((v) => v.id === valuationPick) : undefined;
    if (!found) {
      notify("Selecione uma observação na tabela Avaliações.");
      return;
    }
    if (found.used) {
      notify("Esta observação já é a usada nesta data.");
      return;
    }
    act((l) => service.selectValuation(l, found.id), {
      done: "Observação usada nos cálculos.",
      label: "usar observação nos cálculos",
    });
  };

  const fixValuation = (id: Id | undefined = valuationPick ?? undefined) => {
    if (!id) {
      notify("Selecione uma observação na tabela Avaliações.");
      return;
    }
    dialog.show({ kind: "fix", valuationId: id });
  };

  const completeRedemption = () => {
    const found = eventPick && selected ? eventRows(ledger, selected.id).find((e) => e.id === eventPick) : undefined;
    if (!found || !found.incomplete) {
      notify("Selecione o resgate incompleto em Movimentos.");
      return;
    }
    dialog.show({ kind: "complete", eventId: found.id });
  };

  const profile = withPosition((positionId) => ({ kind: "profile", positionId }));

  const removeInvestment = useRemoveInvestment();
  const removeAt = async (id: Id) => {
    if (await removeInvestment(id, nameOf(id))) setPick(null);
  };
  const remove = async () => {
    const id = need();
    if (id) await removeAt(id);
  };

  /** The bank account where a position (its characteristics) or a savings account is held. */
  const bankOf = (row: PortfolioRow): Id | null =>
    row.savings
      ? ([...dom.banking.bankAccounts(ledger).values()].find((b) => b.savings_id === row.id)?.id ?? null)
      : (investments.profile.profileOf(ledger, row.id)?.bank_account_id ?? null);

  /**
   * A row's context menu: the commands of that investment, the rarer ones in cascades, and Excluir apart and in
   * red. A savings account only leads to its entries and its bank account (it follows Livro).
   */
  const rowMenu = (row: PortfolioRow): MenuEntry[] => {
    const bankId = bankOf(row);
    const seeBank: MenuEntry[] = bankId
      ? [{ id: "bank", label: "Ver conta bancária", onSelect: () => goTo("contas", { ref: `banco:${bankId}` }) }]
      : [];
    if (row.savings) {
      return [
        { id: "entries", label: "Ver lançamentos", onSelect: () => goTo("livro", { ref: accountRef(row.id) }) },
        ...seeBank,
      ];
    }
    const id = row.id;
    const show = (spec: Spec) => () => dialog.show(spec);
    const byQuantity = service.position(ledger, id).mode === model.TrackingMode.QUANTITY;
    const trading: MenuEntry[] = byQuantity
      ? [
          {
            kind: "submenu",
            id: "trade",
            label: "Negociação",
            items: [
              { id: "buy", label: "Compra…", onSelect: show({ kind: "trade", trade: "buy", positionId: id }) },
              { id: "sell", label: "Venda…", onSelect: show({ kind: "trade", trade: "sell", positionId: id }) },
              {
                id: "opening",
                label: "Posição inicial…",
                onSelect: show({ kind: "trade", trade: "opening", positionId: id }),
              },
              { kind: "separator", id: "t1" },
              {
                id: "split",
                label: "Desdobramento ou grupamento…",
                onSelect: show({ kind: "trade", trade: "split", positionId: id }),
              },
              { id: "bonus", label: "Bonificação…", onSelect: show({ kind: "trade", trade: "bonus", positionId: id }) },
            ],
          },
        ]
      : [];
    return lockEntries(
      [
        { id: "valuation", label: "Atualizar valor…", onSelect: show({ kind: "valuation", positionId: id }) },
        { id: "contribution", label: "Aporte…", onSelect: show({ kind: "contribution", positionId: id }) },
        {
          kind: "submenu",
          id: "register",
          label: "Registrar",
          items: [
            { id: "distribution", label: "Provento…", onSelect: show({ kind: "distribution", positionId: id }) },
            { id: "redeem", label: "Resgate…", onSelect: show({ kind: "redeem", positionId: id, prefill: null }) },
            {
              id: "netonly",
              label: "Resgate só com o líquido…",
              onSelect: show({ kind: "netonly", positionId: id }),
            },
            { kind: "separator", id: "r1" },
            { id: "simulate", label: "Simular resgate (não grava)…", onSelect: () => simulate(id) },
          ],
        },
        ...trading,
        { kind: "separator", id: "s1" },
        { id: "profile", label: "Características…", onSelect: show({ kind: "profile", positionId: id }) },
        {
          id: "entries",
          label: "Ver lançamentos",
          onSelect: () => goTo("livro", { ref: accountRef(service.position(ledger, id).account_id) }),
        },
        ...seeBank,
        { kind: "separator", id: "s2" },
        { id: "remove", label: "Excluir investimento…", danger: true, onSelect: () => void removeAt(id) },
      ],
      locked,
      ["entries", "bank", "simulate"],
    );
  };

  // A maturity notice or a link: select the position; "avaliar" and "simular" start the action.
  useReveal((ref, action) => {
    const id = parseReveal(ref, ledger);
    if (!id) return;
    setPick(id);
    if (action === "avaliar") dialog.show({ kind: "valuation", positionId: id });
    else if (action === "simular") simulate(id);
  });

  /** Commands that change the project are disabled while another tab or device is editing it. */
  const lock = (items: MenuEntry[], free: readonly string[] = []): MenuEntry[] => lockEntries(items, locked, free);

  const header = (
    <PageHeader
      title="Investimentos"
      context={summary}
      primary={
        <EditButton variant="primary" onClick={() => dialog.show({ kind: "position" })}>
          Novo investimento…
        </EditButton>
      }
      actions={
        <>
          <Button icon={<Table2 />} onClick={() => void navigate({ to: "/imprimir/investimentos" })}>
            Tabela completa
          </Button>
          <MenuButton
            label="Registrar"
            items={lock([
              {
                id: "valuation",
                label: "Atualizar valor…",
                onSelect: withPosition((positionId) => ({ kind: "valuation", positionId })),
              },
              { kind: "separator", id: "s1" },
              {
                id: "contribution",
                label: "Aporte…",
                onSelect: withPosition((positionId) => ({ kind: "contribution", positionId })),
              },
              {
                id: "distribution",
                label: "Provento…",
                onSelect: withPosition((positionId) => ({ kind: "distribution", positionId })),
              },
              {
                id: "redeem",
                label: "Resgate…",
                onSelect: withPosition((positionId) => ({ kind: "redeem", positionId, prefill: null })),
              },
              { id: "simulate", label: "Simular resgate (não grava)…", onSelect: () => simulate() },
              {
                id: "netonly",
                label: "Resgate só com o líquido…",
                onSelect: withPosition((positionId) => ({ kind: "netonly", positionId })),
              },
              { id: "complete", label: "Completar resgate…", onSelect: completeRedemption },
              { kind: "separator", id: "s2" },
              { id: "tax", label: "Pagamento de imposto…", onSelect: () => dialog.show({ kind: "tax" }) },
            ])}
          />
          <MenuButton
            label="Negociação"
            items={lock([
              { id: "buy", label: "Compra…", onSelect: trade("buy") },
              { id: "sell", label: "Venda…", onSelect: trade("sell") },
              { id: "opening", label: "Posição inicial…", onSelect: trade("opening") },
              { kind: "separator", id: "s1" },
              { id: "split", label: "Desdobramento ou grupamento…", onSelect: trade("split") },
              { id: "bonus", label: "Bonificação…", onSelect: trade("bonus") },
            ])}
          />
          <MenuButton
            label="Mais"
            items={lock(
              [
                {
                  id: "profile",
                  label: "Características (tipo, emissor, taxa, vencimento, tributação)…",
                  onSelect: profile,
                },
                { id: "remove", label: "Excluir investimento…", onSelect: () => void remove() },
                { kind: "separator", id: "s1" },
                {
                  id: "composition",
                  label: "Composição da carteira (Relatórios)",
                  onSelect: () => goTo("relatorios", { ref: "composition" }),
                },
                { kind: "separator", id: "s2" },
                { id: "rule", label: "Regra de imposto…", onSelect: () => dialog.show({ kind: "rule" }) },
                { kind: "separator", id: "s3" },
                {
                  id: "benchmark",
                  label: "Importar índice de referência…",
                  onSelect: () => dialog.show({ kind: "benchmark" }),
                },
              ],
              ["composition"],
            )}
          />
        </>
      }
    />
  );

  const spec = dialog.spec;
  const close = dialog.close;

  return (
    <div className="flex flex-col gap-6">
      {header}

      {rows.length === 0 ? (
        <EmptyState
          framed
          title="Nenhum investimento"
          description="Cadastre uma conta de investimento no banco onde ela fica, com as características (tipo, rentabilidade, vencimento). Depois, acompanhe aqui avaliações, aportes, resgates e rentabilidade."
          actions={
            <>
              <EditButton variant="primary" onClick={() => goTo("contas", { ref: "bancarias", act: "investimento" })}>
                Cadastrar conta de investimento…
              </EditButton>
              <EditButton onClick={() => dialog.show({ kind: "position" })}>Novo investimento…</EditButton>
            </>
          }
        />
      ) : (
        <>
          <section aria-label="Carteira" className="flex min-w-0 flex-col gap-2">
            <ListTable
              label="Investimentos"
              rows={rows}
              search={PORTFOLIO_SEARCH}
              filters={PORTFOLIO_FILTERS}
              columns={PORTFOLIO_COLUMNS}
              getRowId={(r) => r.id}
              selectedId={selected?.id ?? null}
              onSelect={setPick}
              rowMenu={rowMenu}
              rowMenuLabel={(r) => `Ações de ${r.name}`}
              onActivate={(id) => {
                setPick(id);
                if (rows.find((r) => r.id === id)?.savings) goTo("livro", { ref: accountRef(id) });
                else if (!locked) dialog.show({ kind: "profile", positionId: id });
              }}
              max={8}
            />
            <p className="text-caption text-secondary">
              Total investido: o que você aplicou e ainda não resgatou, sem o rendimento. Rendimento: último valor menos
              o total investido, ganho ou perda que ainda está no investimento. Realizado: o resultado do que já foi
              resgatado ou vendido. “Indisponível” e “sem avaliação” indicam falta de dado, nunca zero.
            </p>
          </section>

          <AnimatePresence mode="wait" initial={false}>
            {selected ? (
              <motion.div key={selected.id} {...preset.enter}>
                {selected.savings ? (
                  <SavingsPanel
                    accountId={selected.id}
                    today={today}
                    onSeeEntries={() => goTo("livro", { ref: accountRef(selected.id) })}
                    onBank={(bankId) => goTo("contas", { ref: `banco:${bankId}` })}
                  />
                ) : (
                  <Detail
                    positionId={selected.id}
                    today={today}
                    valuation={valuationPick}
                    onValuation={(id) => setChosen({ positionId: selected.id, valuation: id, event: eventPick })}
                    event={eventPick}
                    onEvent={(id) => setChosen({ positionId: selected.id, valuation: valuationPick, event: id })}
                    onValuate={() => dialog.show({ kind: "valuation", positionId: selected.id })}
                    onContribute={() => dialog.show({ kind: "contribution", positionId: selected.id })}
                    onProfile={profile}
                    onSeeEntries={() =>
                      goTo("livro", { ref: accountRef(service.position(ledger, selected.id).account_id) })
                    }
                    onUse={useValuation}
                    onFix={fixValuation}
                    onComplete={completeRedemption}
                    onBank={(bankId) => goTo("contas", { ref: `banco:${bankId}` })}
                  />
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </>
      )}

      <Section
        title="Notas de negociação"
        description="Os negócios das notas de corretagem aprovadas na importação entram aqui, com os custos rateados entre eles."
        actions={
          <Button size="sm" onClick={() => goTo("importar")}>
            Importar nota…
          </Button>
        }
      >
        {notes.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Toolbar label="Comandos da nota">
              <Button
                size="sm"
                onClick={() => {
                  if (!note) notify("Selecione uma nota na tabela.");
                  else if (note.pending && note.batchId) goTo("importar", { ref: note.batchId });
                  else if (note.firstPositionId) setPick(note.firstPositionId);
                }}
              >
                {note?.pending ? "Revisar na importação" : "Ver investimento"}
              </Button>
            </Toolbar>
            <ListTable
              label="Notas de negociação"
              rows={notes}
              search={NOTE_SEARCH}
              columns={NOTE_COLUMNS}
              getRowId={(r) => r.id}
              selectedId={notePick}
              onSelect={setNotePick}
              max={6}
            />
          </div>
        ) : (
          <Empty title="Nenhuma nota de negociação">
            Importe o PDF da nota em Importar; ao aprovar, as compras e vendas entram na carteira e as notas aparecem
            aqui.
          </Empty>
        )}
      </Section>

      {spec?.kind === "position" ? (
        <InvestmentPositionDialog
          key={dialog.key}
          open={dialog.open}
          onClose={close}
          onDone={(id) => {
            setPick(id);
            notify("Investimento criado. Descreva tipo, taxa e vencimento em Mais › Características.");
          }}
        />
      ) : null}
      {spec?.kind === "valuation" ? (
        <InvestmentValuationDialog
          key={dialog.key}
          open={dialog.open}
          onClose={close}
          positionId={spec.positionId}
          name={nameOf(spec.positionId)}
          onFix={(valuationId) => dialog.show({ kind: "fix", valuationId })}
          onDone={() => notify("Avaliação registrada.")}
        />
      ) : null}
      {spec?.kind === "fix" ? (
        <InvestmentFixDialog
          key={dialog.key}
          open={dialog.open}
          onClose={close}
          valuationId={spec.valuationId}
          onDone={() => notify("Observação corrigida; o histórico guarda o valor anterior.")}
        />
      ) : null}
      {spec?.kind === "contribution" ? (
        <InvestmentContributionDialog
          key={dialog.key}
          open={dialog.open}
          onClose={close}
          positionId={spec.positionId}
          name={nameOf(spec.positionId)}
          onDone={() => notify("Aporte registrado.")}
        />
      ) : null}
      {spec?.kind === "distribution" ? (
        <InvestmentDistributionDialog
          key={dialog.key}
          open={dialog.open}
          onClose={close}
          positionId={spec.positionId}
          name={nameOf(spec.positionId)}
          onDone={() => notify("Provento registrado.")}
        />
      ) : null}
      {spec?.kind === "redeem" ? (
        <InvestmentRedemptionDialog
          key={dialog.key}
          open={dialog.open}
          onClose={close}
          positionId={spec.positionId}
          name={nameOf(spec.positionId)}
          prefill={spec.prefill}
          onDone={() => notify("Resgate registrado.")}
        />
      ) : null}
      {spec?.kind === "netonly" ? (
        <InvestmentNetOnlyDialog
          key={dialog.key}
          open={dialog.open}
          onClose={close}
          positionId={spec.positionId}
          name={nameOf(spec.positionId)}
          onDone={() => notify("Resgate registrado com deduções a discriminar.")}
        />
      ) : null}
      {spec?.kind === "complete" ? (
        <InvestmentCompleteDialog
          key={dialog.key}
          open={dialog.open}
          onClose={close}
          eventId={spec.eventId}
          onDone={() => notify("Resgate completado.")}
        />
      ) : null}
      {spec?.kind === "tax" ? (
        <InvestmentTaxPaymentDialog
          key={dialog.key}
          open={dialog.open}
          onClose={close}
          onDone={() => notify("Pagamento de imposto registrado.")}
        />
      ) : null}
      {spec?.kind === "trade" ? (
        <InvestmentTradeDialog
          key={dialog.key}
          open={dialog.open}
          onClose={close}
          kind={spec.trade}
          positionId={spec.positionId}
          name={nameOf(spec.positionId)}
          onDone={() => notify("Negociação registrada.")}
        />
      ) : null}
      {spec?.kind === "simulate" ? (
        <InvestmentSimulateDialog
          key={dialog.key}
          open={dialog.open}
          onClose={close}
          positionId={spec.positionId}
          name={nameOf(spec.positionId)}
          onRegister={(prefill) => dialog.show({ kind: "redeem", positionId: spec.positionId, prefill })}
        />
      ) : null}
      {spec?.kind === "profile" ? (
        <InvestmentDialog
          key={dialog.key}
          open={dialog.open}
          onClose={close}
          positionId={spec.positionId}
          onDone={() => notify("Características salvas.")}
        />
      ) : null}
      {spec?.kind === "rule" ? (
        <InvestmentRuleDialog
          key={dialog.key}
          open={dialog.open}
          onClose={() => {
            close();
            // Saved for the simulator: it opens next, on the position that asked for it.
            if (spec.then !== undefined && ruleSaved.current) dialog.show({ kind: "simulate", positionId: spec.then });
            ruleSaved.current = false;
          }}
          forSimulation={spec.then !== undefined}
          onDone={() => {
            ruleSaved.current = true;
            notify("Regra salva.");
          }}
        />
      ) : null}
      {spec?.kind === "benchmark" ? (
        <InvestmentBenchmarkDialog
          key={dialog.key}
          open={dialog.open}
          onClose={close}
          onDone={(_, name) => notify(`Índice ${name} importado.`)}
        />
      ) : null}
    </div>
  );
}
