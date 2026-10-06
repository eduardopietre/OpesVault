/**
 * Investimentos (desktop `ui/pages/investments/`): the portfolio, then the selected investment with its
 * figures, charts and tables, the commands that register what happens to it (valuation, contribution,
 * distribution, redemption, trades), the redemption simulator, the characteristics, the brokerage notes and
 * the reference indices. One scrolling page. A link from another screen selects the position (a maturity
 * notice) and may start an action: "avaliar" opens the new valuation, "simular" the simulator.
 */
import { investments, type Id } from "@opesvault/domain";
import {
  Button,
  EmptyState,
  MenuButton,
  PageHeader,
  Section,
  notify,
  useMotionPreset,
  type MenuEntry,
} from "@opesvault/ui";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
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
import { InvestmentFixDialog, InvestmentValuationDialog } from "../../dialogs/investment_valuation.tsx";
import { useAct, useLedger, useWorkspace } from "../../data/react.tsx";
import { useGoTo, useReveal } from "../../data/navigation.ts";
import { Empty, EditButton, ListTable, Toolbar, useDialog, useLock } from "../../components/list_parts.tsx";
import { NOTE_COLUMNS, PORTFOLIO_COLUMNS } from "./columns.tsx";
import { Detail } from "./detail.tsx";
import { eventRows, noteRows, parseReveal, portfolioRows, summaryLine, valuationRows, type NoteRow } from "./rows.ts";

const { service, model } = investments;

type Spec =
  | { kind: "position" }
  | { kind: "valuation"; positionId: Id }
  | { kind: "fix"; valuationId: Id }
  | { kind: "contribution" | "distribution" | "netonly" | "simulate" | "profile"; positionId: Id }
  | { kind: "redeem"; positionId: Id; prefill: RedemptionPrefill | null }
  | { kind: "complete"; eventId: Id }
  | { kind: "trade"; trade: TradeKind; positionId: Id }
  | { kind: "tax" | "rule" | "benchmark" };

export function Page() {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useAct();
  const goTo = useGoTo();
  const { locked } = useLock();
  const preset = useMotionPreset();
  const today = workspace.today();
  const rows = useLedger((l) => portfolioRows(l, today), today);
  const summary = useLedger((l) => summaryLine(l));
  const notes = useLedger((l) => noteRows(l));
  const dialog = useDialog<Spec>();

  const [pick, setPick] = useState<Id | null>(null);
  const selected = rows.find((r) => r.id === pick) ?? rows[0] ?? null;
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
    if (!selected) {
      notify("Selecione um investimento.");
      return null;
    }
    return selected.id;
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
    if (ledger.entities("tax_rule").size === 0) {
      notify("Cadastre antes uma regra de imposto (Mais › Regra de imposto…).");
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
    act((l) => service.selectValuation(l, found.id), "Observação usada nos cálculos.");
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

  // A maturity notice or a link: select the position; "avaliar" and "simular" start the action.
  useReveal((ref, action) => {
    const id = parseReveal(ref, ledger);
    if (!id) return;
    setPick(id);
    if (action === "avaliar") dialog.show({ kind: "valuation", positionId: id });
    else if (action === "simular") simulate(id);
  });

  /** Commands that change the project are disabled while another tab or device is editing it. */
  const lock = (items: MenuEntry[], free: readonly string[] = []): MenuEntry[] =>
    items.map((item) =>
      item.kind === "separator" || item.kind === "label" || item.kind === "radio" || free.includes(item.id)
        ? item
        : { ...item, disabled: item.disabled || locked },
    );

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
          <MenuButton
            label="Registrar"
            items={lock([
              {
                id: "valuation",
                label: "Avaliação…",
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
        <div className="rounded-xl border border-dashed border-separator-strong bg-window/40">
          <EmptyState
            title="Nenhum investimento"
            description="Cadastre um investimento para acompanhar avaliações, aportes, resgates e rentabilidade."
            actions={
              <EditButton variant="primary" onClick={() => dialog.show({ kind: "position" })}>
                Novo investimento…
              </EditButton>
            }
          />
        </div>
      ) : (
        <>
          <section aria-label="Carteira" className="flex min-w-0 flex-col gap-2">
            <ListTable
              label="Investimentos"
              rows={rows}
              columns={PORTFOLIO_COLUMNS}
              getRowId={(r) => r.id}
              selectedId={selected?.id ?? null}
              onSelect={setPick}
              onActivate={(id) => {
                setPick(id);
                if (!locked) dialog.show({ kind: "profile", positionId: id });
              }}
              max={8}
            />
            <p className="text-caption text-secondary">
              Custo remanescente: o que você aplicou e ainda não resgatou. Não realizado: último valor menos esse custo,
              ganho ou perda que ainda não saiu do investimento. Realizado: o resultado do que já foi resgatado ou
              vendido. “Indisponível” e “sem avaliação” indicam falta de dado, nunca zero.
            </p>
          </section>

          <AnimatePresence mode="wait" initial={false}>
            {selected ? (
              <motion.div key={selected.id} {...preset.enter}>
                <Detail
                  positionId={selected.id}
                  today={today}
                  valuation={valuationPick}
                  onValuation={(id) => setChosen({ positionId: selected.id, valuation: id, event: eventPick })}
                  event={eventPick}
                  onEvent={(id) => setChosen({ positionId: selected.id, valuation: valuationPick, event: id })}
                  onValuate={() => dialog.show({ kind: "valuation", positionId: selected.id })}
                  onProfile={profile}
                  onSeeEntries={() =>
                    goTo("livro", { ref: `conta:${service.position(ledger, selected.id).account_id}` })
                  }
                  onUse={useValuation}
                  onFix={fixValuation}
                  onComplete={completeRedemption}
                  onBank={(bankId) => goTo("contas", { ref: `banco:${bankId}` })}
                />
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
          onClose={close}
          onDone={() => notify("Regra salva.")}
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
