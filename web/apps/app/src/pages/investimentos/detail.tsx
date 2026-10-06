/**
 * The selected investment (desktop `detail.py`): what it is, its key figures and, for each chart, the table it
 * comes from, side by side when there is room. The evolution carries the contributions, redemptions and
 * distributions as markers; gross and net values are separate series; the accumulated result never counts
 * capital as gain; the return is shown by every method the data allow, each unavailable one with its reason.
 * The calculation that takes time (the internal rate of return) runs for this investment only, after the
 * screen paints, and is kept by the ledger's version.
 */
import { charts, dom, formatDateBr, investments, type Id, type IsoDate } from "@opesvault/domain";
import {
  Adaptive,
  Button,
  ChartPanel,
  Collapsible,
  ElidedText,
  Figure,
  NumberTicker,
  Select,
  Skeleton,
  formatDecimalBR,
  type SelectOption,
} from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useLedger } from "../../data/react.tsx";
import { returnsChartOf, toInvestmentChart, toPercentChart } from "./chart.ts";
import { EVENT_COLUMNS, LOT_COLUMNS, RETURN_COLUMNS, VALUATION_COLUMNS } from "./columns.tsx";
import { useDeferred } from "./deferred.ts";
import {
  assembleReturns,
  eventRows,
  figures,
  lotRows,
  periodDates,
  planReturns,
  profileSummary,
  returnRows,
  valuationRows,
} from "./rows.ts";
import { EditButton, Empty, ListTable, useLock } from "../contas/parts.tsx";
import { finishXirr } from "./xirr.ts";
import { solveXirr } from "./xirr_client.ts";

const { service, model, benchmarks } = investments;
const { banking } = dom;

const NO_BENCHMARK = "__none";

export interface DetailProps {
  positionId: Id;
  today: IsoDate;
  /** The rows chosen in the tables (kept by the page: its menus act on them too). */
  valuation: Id | null;
  onValuation: (id: Id) => void;
  event: Id | null;
  onEvent: (id: Id) => void;
  onValuate: () => void;
  onProfile: () => void;
  onSeeEntries: () => void;
  onUse: () => void;
  onFix: (valuationId?: Id) => void;
  onComplete: () => void;
  onBank: (bankId: Id) => void;
}

/** "R$ 1.234,56" and "-R$ 1.234,56": the sign before the currency, as everywhere else in the screen. */
const money = (text: string) =>
  text.startsWith("-")
    ? `-${formatDecimalBR(text.slice(1), { places: 2, currency: true })}`
    : formatDecimalBR(text, { places: 2, currency: true });

function FigureCard({
  label,
  text,
  raw,
  tone,
  note,
}: {
  label: string;
  text: string;
  raw: string | null;
  tone?: "positive" | "negative" | "warning" | undefined;
  note?: string | undefined;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-separator bg-raised px-4 py-3 shadow-sm max-tablet:px-3 max-tablet:[&_.text-figure]:text-headline">
      <Figure
        label={label}
        {...(tone ? { tone } : {})}
        {...(note ? { note } : {})}
        value={
          raw !== null ? <NumberTicker value={raw} format={money} /> : <span className="text-secondary">{text}</span>
        }
      />
    </div>
  );
}

export function Detail({
  positionId,
  today,
  valuation,
  onValuation,
  event,
  onEvent,
  onValuate,
  onProfile,
  onSeeEntries,
  onUse,
  onFix,
  onComplete,
  onBank,
}: DetailProps) {
  const { locked } = useLock();
  const key = `${positionId}|${today}`;
  const position = useLedger((l) => service.position(l, positionId), key);
  const name = useLedger((l) => service.assets(l).get(position.asset_id)?.name ?? "", key);
  const summary = useLedger((l) => profileSummary(l, positionId), key);
  const bankId = useLedger((l) => investments.profile.profileOf(l, positionId)?.bank_account_id ?? null, key);
  const bank = useLedger(
    (l) => (bankId ? (banking.bankAccounts(l).get(bankId)?.name ?? null) : null),
    `${key}|${bankId}`,
  );
  const numbers = useLedger((l) => figures(l, positionId, today), key);
  const valuations = useLedger((l) => valuationRows(l, positionId), key);
  const events = useLedger((l) => eventRows(l, positionId), key);
  const lots = useLedger((l) => lotRows(l, positionId), key);
  const dates = useLedger((l) => periodDates(l, positionId), key);
  const rules = useLedger((l) => [...benchmarks.benchmarks(l).values()].map((b) => ({ id: b.id, name: b.name })), key);
  const evolution = useLedger((l) => toInvestmentChart(charts.data.investmentEvolution(l, positionId)), key);
  const result = useLedger((l) => toInvestmentChart(charts.data.investmentResult(l, positionId)), key);

  const [startPick, setStart] = useState<IsoDate | null>(null);
  const [endPick, setEnd] = useState<IsoDate | null>(null);
  const [benchPick, setBench] = useState<string>(NO_BENCHMARK);

  const start = startPick && dates.includes(startPick) ? startPick : (dates[0] ?? null);
  const end = endPick && dates.includes(endPick) ? endPick : (dates[dates.length - 1] ?? null);
  const bench = benchPick !== NO_BENCHMARK && rules.some((r) => r.id === benchPick) ? benchPick : null;
  const periodOk = start !== null && end !== null && start < end;
  // the quick methods first (after the paint); the internal rate of return, the slow one, in a worker
  const returnsKey = `${positionId}|${start}|${end}|${bench}`;
  const plan = useDeferred(`plan|${returnsKey}`, (l) => planReturns(l, positionId, start!, end!, bench), periodOk);
  const solved = useDeferred(
    `xirr|${returnsKey}`,
    async () => {
      const found = plan.value!.xirr;
      if (found.settled) return found.settled;
      const [rate, reason] = await solveXirr(found.dated);
      return finishXirr(found, rate, reason);
    },
    plan.value !== null,
  );
  const returnRowsNow = useMemo(
    () => (plan.value ? returnRows(assembleReturns(plan.value, solved.value)) : null),
    [plan.value, solved.value],
  );
  const returnsChart = useMemo(
    () =>
      plan.value && solved.value && start && end
        ? toPercentChart(returnsChartOf(assembleReturns(plan.value, solved.value), start, end))
        : null,
    [plan.value, solved.value, start, end],
  );

  const dateOptions: SelectOption[] = useMemo(() => dates.map((d) => ({ id: d, label: formatDateBr(d) })), [dates]);
  const benchOptions: SelectOption[] = [
    { id: NO_BENCHMARK, label: "(nenhum)" },
    ...rules.map((r) => ({ id: r.id, label: r.name })),
  ];

  const showLots = lots.length > 0 || position.mode === model.TrackingMode.QUANTITY;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="text-headline font-semibold text-text">
            <ElidedText className="block">{name}</ElidedText>
          </h2>
          <p className="mt-1 text-body text-secondary">{summary.join(" · ")}</p>
        </div>
        <div role="toolbar" aria-label="Comandos do investimento" className="flex flex-wrap items-center gap-2">
          <EditButton onClick={onValuate}>Avaliar…</EditButton>
          <EditButton onClick={onProfile}>Características…</EditButton>
          <Button onClick={onSeeEntries}>Ver lançamentos</Button>
          {bankId && bank ? <Button onClick={() => onBank(bankId)}>Ver conta bancária</Button> : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 medium:grid-cols-4">
        <FigureCard label="Último valor" text={numbers.value} raw={numbers.valueRaw} />
        <FigureCard label="Custo remanescente" text={numbers.cost} raw={numbers.costRaw} />
        <FigureCard
          label="Não realizado"
          text={numbers.unrealized}
          raw={numbers.unrealizedRaw}
          tone={numbers.unrealizedTone ?? undefined}
          note={numbers.reason ?? undefined}
        />
        <FigureCard label="Vencimento" text={numbers.maturity} raw={null} tone={numbers.maturityTone ?? undefined} />
      </div>
      <p className="-mt-3 text-caption text-secondary">{numbers.method}</p>

      <section aria-label="Evolução" className="min-w-0">
        {valuations.length > 0 ? (
          <ChartPanel chart={evolution} prefKey="investimentos/evolucao" height={300} />
        ) : (
          <Empty title="Sem avaliações">
            Registre a primeira em Registrar › Avaliação (ou em Avaliar…): sem valores observados não há evolução nem
            rentabilidade, e o resultado fica indisponível, nunca zero.
          </Empty>
        )}
      </section>

      <Adaptive at={1300} columns="1fr 1fr" gap={24}>
        <Collapsible
          title="Avaliações"
          prefKey="investimentos/avaliacoes"
          description="Os pontos do gráfico de evolução. Com mais de uma fonte na mesma data, escolha a usada."
          actions={
            <>
              <EditButton size="sm" onClick={onUse}>
                Usar esta observação
              </EditButton>
              <EditButton size="sm" onClick={() => onFix()}>
                Corrigir observação…
              </EditButton>
            </>
          }
        >
          {valuations.length ? (
            <ListTable
              label="Avaliações"
              rows={valuations}
              columns={VALUATION_COLUMNS}
              getRowId={(r) => r.id}
              selectedId={valuation}
              onSelect={onValuation}
              onActivate={(id) => {
                onValuation(id);
                if (!locked) onFix(id);
              }}
              max={8}
            />
          ) : (
            <Empty title="Nenhuma avaliação">Os valores observados do investimento aparecem aqui.</Empty>
          )}
        </Collapsible>
        <Collapsible
          title="Movimentos"
          prefKey="investimentos/movimentos"
          description="Aportes, resgates, proventos e impostos. Um resgate só com o líquido fica incompleto até ser completado."
          actions={
            <EditButton size="sm" onClick={onComplete}>
              Completar resgate…
            </EditButton>
          }
        >
          {events.length ? (
            <ListTable
              label="Movimentos"
              rows={events}
              columns={EVENT_COLUMNS}
              getRowId={(r) => r.id}
              selectedId={event}
              onSelect={onEvent}
              max={8}
            />
          ) : (
            <Empty title="Nenhum movimento">Aportes, resgates e proventos registrados aparecem aqui.</Empty>
          )}
        </Collapsible>
      </Adaptive>

      <section aria-label="Resultado acumulado" className="min-w-0">
        {result.series[0]?.values.some((v) => v !== null) ? (
          <ChartPanel chart={result} prefKey="investimentos/resultado" height={260} />
        ) : (
          <Empty title="Resultado acumulado indisponível">
            O resultado acumulado precisa de avaliações brutas; o capital aportado nunca conta como ganho.
          </Empty>
        )}
      </section>

      <Collapsible
        title="Rentabilidade"
        prefKey="investimentos/rentabilidade"
        description="Cada método só calcula quando os dados permitem; os que não podem mostram o motivo, nunca zero."
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40 max-tablet:flex-1">
              <Select
                label="Início do período"
                options={dateOptions}
                value={start}
                onChange={(id) => setStart(id as IsoDate)}
                placeholder="Sem avaliações"
              />
            </div>
            <div className="w-40 max-tablet:flex-1">
              <Select
                label="Fim do período"
                options={dateOptions}
                value={end}
                onChange={(id) => setEnd(id as IsoDate)}
                placeholder="Sem avaliações"
              />
            </div>
            <div className="w-56 max-tablet:w-full">
              <Select
                label="Índice de referência"
                options={benchOptions}
                value={bench ?? NO_BENCHMARK}
                onChange={setBench}
              />
            </div>
          </div>
          {!periodOk ? (
            <Empty title="Escolha um período">
              {dates.length < 2
                ? "A rentabilidade precisa de ao menos duas avaliações em datas diferentes."
                : "Escolha duas datas diferentes, com o início antes do fim."}
            </Empty>
          ) : returnRowsNow === null ? (
            <div role="status" aria-label="Calculando a rentabilidade" className="flex flex-col gap-3">
              <Skeleton lines={4} />
              <Skeleton className="h-40 w-full rounded-lg" />
            </div>
          ) : (
            <>
              <ListTable
                label="Rentabilidade por método"
                rows={returnRowsNow}
                columns={RETURN_COLUMNS}
                getRowId={(r) => r.id}
                max={7}
              />
              {returnsChart ? (
                <ChartPanel chart={returnsChart} prefKey="investimentos/rentabilidade-grafico" height={240} />
              ) : (
                <div role="status" aria-label="Calculando o gráfico da rentabilidade">
                  <Skeleton className="h-40 w-full rounded-lg" />
                </div>
              )}
            </>
          )}
        </div>
      </Collapsible>

      {showLots ? (
        <Collapsible
          title="Lotes"
          prefKey="investimentos/lotes"
          description="Custo por aquisição (acompanhamento por quantidade)."
        >
          {lots.length ? (
            <ListTable label="Lotes" rows={lots} columns={LOT_COLUMNS} getRowId={(r) => r.id} max={8} />
          ) : (
            <Empty title="Nenhum lote">
              Compras e posições iniciais criam os lotes, com o custo de cada aquisição.
            </Empty>
          )}
        </Collapsible>
      ) : null}
    </div>
  );
}
