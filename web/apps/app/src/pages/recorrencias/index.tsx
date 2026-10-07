/**
 * Recorrências (desktop `ui/pages/recurrences_page.py`, RF-11): the rules of fixed bills and expected income,
 * the forecasts they generate (3 months back to 6 ahead), the link of a forecast to the operation that
 * realized it, subscriptions with their yearly cost and price changes, and the charges that look recurring.
 * Forecasts never change balances. A late forecast in a notice or the calendar arrives here ready to link.
 */
import { Dec, DomainError, ZERO, dom, formatBrl, formatDateBr, type Operation } from "@opesvault/domain";
import {
  Adaptive,
  Button,
  Collapsible,
  DataTable,
  EmptyState,
  MenuButton,
  PageHeader,
  Section,
  confirm,
  notify,
  useMediaQuery,
  useMotionPreset,
  useStoredFlag,
} from "@opesvault/ui";
import { Repeat } from "lucide-react";
import { motion } from "motion/react";
import { useRef, useState } from "react";
import { useAct, useLedger, useWorkspace } from "../../data/react.tsx";
import { useGoTo, useReveal } from "../../data/navigation.ts";
import { tableHeight } from "../../data/table_height.ts";
import { RecurrenceLinkDialog } from "../../dialogs/recurrence_link.tsx";
import { RecurrenceRuleDialog } from "../../dialogs/recurrence_rule.tsx";
import { useUndo } from "../../shell/undo.tsx";
import { FORECAST_LABELS, candidateKey, forecastId, forecastWindow, parseRecurrenceRef, summaryLine } from "./rows.ts";
import { CANDIDATE_COLUMNS, COMMITMENT_COLUMNS, FORECAST_COLUMNS, RULE_COLUMNS } from "./tables.tsx";

type Rule = dom.recurrence.RecurrenceRule;
type Forecast = dom.recurrence.Forecast;
type Candidate = dom.subscriptions.Candidate;

const LOCKED = "Outra aba ou outro aparelho está editando este projeto. Atualize para editar.";

interface RuleDialogState {
  key: number;
  rule: Rule | null;
  suggestion: Candidate | null;
}

interface LinkDialogState {
  key: number;
  forecast: Forecast;
  candidates: Operation[];
}

export function Page() {
  const workspace = useWorkspace();
  const act = useAct();
  const goTo = useGoTo();
  const { undo } = useUndo();
  const preset = useMotionPreset();
  const phone = useMediaQuery("(max-width: 639px)");
  const locked = workspace.readOnly;
  const lockTip = locked ? LOCKED : undefined;
  const today = workspace.today();
  const [start, end] = forecastWindow(today);

  const rules = useLedger((ledger) => [...dom.recurrence.rules(ledger).values()], "");
  const forecasts = useLedger((ledger) => dom.recurrence.forecasts(ledger, start, end, today), today);
  const commitments = useLedger((ledger) => dom.subscriptions.commitments(ledger), "");
  const candidates = useLedger((ledger) => dom.subscriptions.candidates(ledger, today), today);

  const [pickRule, setPickRule] = useState<string | null>(null);
  const [pickForecast, setPickForecast] = useState<string | null>(null);
  const [pickCandidate, setPickCandidate] = useState<string | null>(null);
  const [ruleDialog, setRuleDialog] = useState<RuleDialogState | null>(null);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [linkDialog, setLinkDialog] = useState<LinkDialogState | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const counter = useRef(0);
  const forecastBox = useRef<HTMLDivElement>(null);
  const commitmentBox = useRef<HTMLDivElement>(null);

  // The subscriptions section opens by itself when a link names a rule; the person's own choice is kept.
  const [storedOpen, setStoredOpen] = useStoredFlag("secoes/recorrencias/assinaturas", true);
  const [forcedOpen, setForcedOpen] = useState(false);

  const late = forecasts.filter((f) => f.status === "late").length;
  const selectedRule = rules.find((r) => r.id === pickRule) ?? null;
  const selectedForecast = forecasts.find((f) => forecastId(f.ruleId, f.dueOn) === pickForecast) ?? null;
  const selectedCandidate = candidates.find((c) => candidateKey(c) === pickCandidate) ?? null;

  // ── rules ───────────────────────────────────────

  const openRuleDialog = (rule: Rule | null, suggestion: Candidate | null = null) => {
    setRuleDialog({ key: ++counter.current, rule, suggestion });
    setRuleOpen(true);
  };

  const edit = (id: string | null = pickRule) => {
    const rule = rules.find((r) => r.id === id);
    if (!rule) {
      notify("Selecione uma regra.");
      return;
    }
    openRuleDialog(rule);
  };

  const toggle = () => {
    if (!selectedRule) {
      notify("Selecione uma regra.");
      return;
    }
    const rule = selectedRule;
    act(
      (ledger) => dom.recurrence.updateRule(ledger, { ...rule, paused: !rule.paused }, "pausar/retomar"),
      {
        done: rule.paused
          ? `Recorrência “${rule.description}” retomada.`
          : `Recorrência “${rule.description}” pausada.`,
        label: rule.paused ? "retomar recorrência" : "pausar recorrência",
      },
    );
  };

  const createFromCandidate = (key: string | null = pickCandidate) => {
    const found = candidates.find((c) => candidateKey(c) === key);
    if (!found) {
      notify("Selecione uma cobrança.");
      return;
    }
    openRuleDialog(null, found);
  };

  // ── forecasts ───────────────────────────────────

  const startLink = (forecast: Forecast) => {
    if (forecast.status === "realized" || forecast.status === "skipped") {
      notify("Esta previsão já foi resolvida.");
      return;
    }
    const found = dom.recurrence.candidates(workspace.ledger, forecast);
    if (!found.length) {
      notify("Nenhum lançamento compatível (conta, valor e data).");
      return;
    }
    setLinkDialog({ key: ++counter.current, forecast, candidates: found });
    setLinkOpen(true);
  };

  const linkSelected = () => {
    if (!selectedForecast) {
      notify("Selecione uma previsão.");
      return;
    }
    startLink(selectedForecast);
  };

  const skipSelected = () => {
    const forecast = selectedForecast;
    if (!forecast) {
      notify("Selecione uma previsão.");
      return;
    }
    if (forecast.status === "realized" || forecast.status === "skipped") {
      notify("Esta previsão já foi resolvida.");
      return;
    }
    const skipped = act((ledger) => dom.recurrence.skip(ledger, forecast.ruleId, forecast.dueOn), {
      label: "pular previsão",
    });
    if (skipped === undefined) return;
    notify(`Previsão de ${formatDateBr(forecast.dueOn)} pulada.`, { action: { label: "Desfazer", run: undo } });
  };

  const linkSuggestions = async () => {
    const pairs = dom.recurrence.autoSuggestions(workspace.ledger, start, end, today);
    if (!pairs.length) {
      notify("Nenhuma previsão com um único lançamento compatível.");
      return;
    }
    const ok = await confirm({
      title: `Vincular ${pairs.length} previsão(ões) aos lançamentos?`,
      text: (
        <ul className="flex flex-col gap-1">
          {pairs.map(([forecast, op]) => (
            <li key={forecastId(forecast.ruleId, forecast.dueOn)}>
              {formatDateBr(forecast.dueOn)} {forecast.description} ← {op.description}
            </li>
          ))}
        </ul>
      ),
      confirmLabel: "Vincular",
    });
    if (!ok) return;
    // One action, one undo step; a pair that the domain refuses does not stop the others.
    let refused = 0;
    const linked = act((ledger) => {
      let count = 0;
      for (const [forecast, op] of pairs) {
        try {
          dom.recurrence.realize(ledger, forecast.ruleId, forecast.dueOn, op.id);
          count++;
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          refused++;
        }
      }
      return count;
    });
    if (linked === undefined) return;
    notify(
      `${linked} previsão(ões) vinculada(s)${refused ? `; ${refused} recusada(s) pelo livro` : ""}.`,
      linked ? { action: { label: "Desfazer", run: undo } } : {},
    );
  };

  // ── links from other pages ──────────────────────

  useReveal((ref, action) => {
    const target = parseRecurrenceRef(ref);
    if (!target) return;
    if (target.kind === "rule") {
      setForcedOpen(true);
      setPickRule(target.ruleId);
      requestAnimationFrame(() => commitmentBox.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      return;
    }
    const forecast = forecasts.find((f) => f.ruleId === target.ruleId && f.dueOn === target.dueOn);
    if (!forecast) {
      notify("Esta previsão já não está no período mostrado.");
      return;
    }
    setPickForecast(forecastId(forecast.ruleId, forecast.dueOn));
    requestAnimationFrame(() => forecastBox.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    if (action === "vincular" && !locked) startLink(forecast);
  });

  // ── layout ──────────────────────────────────────

  const nothing = rules.length === 0 && candidates.length === 0;
  const newButton = (primary: boolean) => (
    <Button
      variant={primary ? "primary" : "secondary"}
      onClick={() => openRuleDialog(null)}
      disabled={locked}
      title={lockTip}
    >
      Nova recorrência…
    </Button>
  );
  const commitmentsOpen = storedOpen || forcedOpen;
  const total = Dec.sum(
    commitments.map((c) => c.perYear),
    ZERO,
  );

  const commitmentsSection = commitments.length ? (
    <motion.div key="commitments" ref={commitmentBox} {...preset.enter} className="min-w-0">
      <Collapsible
        title="Assinaturas e contas fixas"
        description="Despesas recorrentes ativas, do maior custo anual para o menor. A última cobrança vem do lançamento vinculado à previsão."
        open={commitmentsOpen}
        onOpenChange={(next) => {
          setForcedOpen(false);
          setStoredOpen(next);
        }}
      >
        <p className="mb-2 text-body font-semibold">
          {commitments.length} compromisso(s) · {formatBrl(total)} por ano
        </p>
        <DataTable
          label="Assinaturas e contas fixas"
          rows={commitments}
          columns={COMMITMENT_COLUMNS}
          getRowId={(c) => c.rule.id}
          selectedId={selectedRule?.id ?? null}
          onSelect={setPickRule}
          onActivate={(id) => {
            setPickRule(id);
            if (!locked) edit(id);
          }}
          height={tableHeight(commitments.length, 10, phone)}
        />
      </Collapsible>
    </motion.div>
  ) : null;
  const candidatesSection = candidates.length ? (
    <motion.div key="candidates" {...preset.enter} className="min-w-0">
      <Collapsible
        title="Parecem recorrentes"
        prefKey="recorrencias/candidatas"
        description="Cobranças com a mesma descrição e valor parecido em meses seguidos, sem recorrência. Nada é criado sozinho."
        actions={
          <Button size="sm" onClick={() => createFromCandidate()} disabled={locked} title={lockTip}>
            Criar recorrência…
          </Button>
        }
      >
        <DataTable
          label="Cobranças que parecem recorrentes"
          rows={candidates}
          columns={CANDIDATE_COLUMNS}
          getRowId={candidateKey}
          selectedId={selectedCandidate ? candidateKey(selectedCandidate) : null}
          onSelect={setPickCandidate}
          onActivate={(id) => {
            setPickCandidate(id);
            if (!locked) createFromCandidate(id);
          }}
          height={tableHeight(candidates.length, 8, phone)}
        />
      </Collapsible>
    </motion.div>
  ) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Recorrências" context={summaryLine(rules, late)} primary={newButton(true)} />

      {nothing ? (
        <div className="rounded-xl border border-dashed border-separator-strong bg-window/40">
          <EmptyState
            icon={<Repeat />}
            title="Nenhuma recorrência"
            description="Cadastre contas fixas e receitas esperadas (aluguel, salário, escola). O aplicativo prevê cada vencimento, avisa quando atrasa e liga a previsão ao lançamento quando ele acontece. Previsões nunca alteram saldos."
            actions={newButton(false)}
          />
        </div>
      ) : (
        <>
          <Adaptive at={1300} columns="1fr 1fr" gap={32}>
            <Section
              title="Regras"
              description="Contas fixas e receitas esperadas."
              actions={
                <>
                  <Button size="sm" onClick={() => edit()} disabled={locked} title={lockTip}>
                    Editar…
                  </Button>
                  <Button size="sm" onClick={toggle} disabled={locked} title={lockTip}>
                    {selectedRule ? (selectedRule.paused ? "Retomar" : "Pausar") : "Pausar ou retomar"}
                  </Button>
                </>
              }
            >
              <DataTable
                label="Regras de recorrência"
                rows={rules}
                columns={RULE_COLUMNS}
                getRowId={(r) => r.id}
                selectedId={selectedRule?.id ?? null}
                onSelect={setPickRule}
                onActivate={(id) => {
                  setPickRule(id);
                  if (!locked) edit(id);
                }}
                height={tableHeight(rules.length, 8, phone)}
                empty={<p className="px-4 py-6 text-center text-body text-secondary">Nenhuma regra cadastrada.</p>}
              />
            </Section>
            <div ref={forecastBox} className="min-w-0">
              <Section
                title="Previsões"
                description="De 3 meses atrás a 6 meses à frente. Previsões nunca alteram saldos."
                actions={
                  <>
                    <Button size="sm" onClick={linkSelected} disabled={locked} title={lockTip}>
                      Vincular realizado…
                    </Button>
                    <MenuButton
                      label="Mais"
                      items={[
                        {
                          id: "unique",
                          label: "Vincular sugestões únicas",
                          onSelect: () => void linkSuggestions(),
                          disabled: locked,
                        },
                        { id: "skip", label: "Pular previsão", onSelect: skipSelected, disabled: locked },
                        { kind: "separator", id: "sep" },
                        {
                          id: "projection",
                          label: "Projeção de compromissos (Relatórios)",
                          onSelect: () => goTo("relatorios", { ref: "projected_balance" }),
                        },
                      ]}
                    />
                  </>
                }
              >
                <DataTable
                  label="Previsões"
                  rows={forecasts}
                  columns={FORECAST_COLUMNS}
                  getRowId={(f) => forecastId(f.ruleId, f.dueOn)}
                  selectedId={selectedForecast ? forecastId(selectedForecast.ruleId, selectedForecast.dueOn) : null}
                  onSelect={setPickForecast}
                  onActivate={(id) => {
                    setPickForecast(id);
                    const forecast = forecasts.find((f) => forecastId(f.ruleId, f.dueOn) === id);
                    if (forecast && !locked) startLink(forecast);
                  }}
                  height={tableHeight(forecasts.length, 12, phone)}
                  empty={
                    <p className="px-4 py-6 text-center text-body text-secondary">
                      Nenhuma previsão no período. {FORECAST_LABELS.pending} aparece aqui quando houver uma regra ativa.
                    </p>
                  }
                />
              </Section>
            </div>
          </Adaptive>

          {commitments.length && candidates.length ? (
            <Adaptive at={1400} columns="3fr 2fr" gap={32}>
              {commitmentsSection}
              {candidatesSection}
            </Adaptive>
          ) : (
            <>
              {commitmentsSection}
              {candidatesSection}
            </>
          )}
        </>
      )}

      {ruleDialog ? (
        <RecurrenceRuleDialog
          key={ruleDialog.key}
          open={ruleOpen}
          onClose={() => setRuleOpen(false)}
          rule={ruleDialog.rule}
          suggestion={ruleDialog.suggestion}
          onDone={(rule, created) => {
            setPickRule(rule.id);
            notify(
              created
                ? ruleDialog.suggestion
                  ? "Recorrência criada a partir das cobranças repetidas."
                  : "Recorrência criada."
                : "Recorrência atualizada.",
            );
          }}
        />
      ) : null}
      {linkDialog ? (
        <RecurrenceLinkDialog
          key={linkDialog.key}
          open={linkOpen}
          onClose={() => setLinkOpen(false)}
          forecast={linkDialog.forecast}
          candidates={linkDialog.candidates}
          onDone={() => notify("Previsão vinculada ao lançamento.")}
        />
      ) : null}
    </div>
  );
}
