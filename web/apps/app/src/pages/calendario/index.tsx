/**
 * Calendário: card bills, recurrences, loan installments and investment maturities of the month, day by
 * day (desktop `ui/pages/agenda_page.py`). Each entry opens the place where it is paid or linked; on
 * phones the month becomes a list of days. Forecasts never change balances.
 */
import { dom, ymAdd, ymOf, ymStr, type IsoDate, type YearMonth } from "@opesvault/domain";
import {
  Adaptive,
  Button,
  Collapsible,
  MonthPicker,
  PageHeader,
  formatMonth,
  notify,
  useMediaQuery,
} from "@opesvault/ui";
import { useMemo, useState } from "react";
import type { Link } from "../../data/links.ts";
import { useSharedMonth } from "../../data/month.ts";
import { useGoTo } from "../../data/navigation.ts";
import { useLedger, useWorkspace } from "../../data/react.tsx";
import { FigureCard, Money } from "../visao-geral/figures.tsx";
import { DayList, EntriesTable, entryRows } from "./entries.tsx";
import { MonthGrid } from "./month_grid.tsx";
import { agendaFigures, entriesOf, monthWeeks } from "./rows.ts";

/** The picker reaches two years back and one ahead, as on the desktop. */
const MONTHS_BACK = 24;
const MONTHS_AHEAD = 12;

export function Page() {
  const workspace = useWorkspace();
  const go = useGoTo();
  const [month, setMonth] = useSharedMonth();
  const [day, setDay] = useState<IsoDate | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const wide = useMediaQuery("(min-width: 640px)");
  const today = workspace.today();
  const monthKey = ymStr(month);
  const label = formatMonth(month);

  const events = useLedger((ledger) => dom.agenda.monthEvents(ledger, month, today), `${monthKey}|${today}`);
  const figures = useMemo(() => agendaFigures(events), [events]);
  const weeks = useMemo(() => monthWeeks(month, events, today), [month, events, today]);
  const shown = useMemo(() => entriesOf(events, day), [events, day]);
  const rows = useMemo(() => entryRows(shown), [shown]);
  const allRows = useMemo(() => entryRows(events), [events]);

  const chooseMonth = (next: YearMonth) => {
    setDay(null);
    setSelectedId(null);
    setMonth(next);
  };
  const open = (link: Link) =>
    go(link.page, { ...(link.ref ? { ref: link.ref } : {}), ...(link.act ? { act: link.act } : {}) });
  const openSelected = () => {
    const row = rows.find((r) => r.id === selectedId);
    if (!row) {
      notify("Selecione um vencimento.");
      return;
    }
    open(row.link);
  };

  const title = day ? `Vencimentos de ${day.split("-").reverse().join("/")}` : "Vencimentos do mês";
  const picker = (
    <MonthPicker
      value={month}
      onChange={chooseMonth}
      min={ymAdd(ymOf(today), -MONTHS_BACK)}
      max={ymAdd(ymOf(today), MONTHS_AHEAD)}
    />
  );
  const count = events.length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Calendário" context={`${count} vencimento(s) em ${label}`}>
        {picker}
      </PageHeader>

      <FigureCard
        title="Situação dos vencimentos"
        min="9rem"
        figures={[
          { label: "A pagar", value: <Money value={figures.toPay} /> },
          {
            label: "Atrasado",
            value: <Money value={figures.late} />,
            tone: figures.late.isZero() ? undefined : "negative",
          },
          { label: "Já pago", value: <Money value={figures.paid} /> },
          { label: "A receber", value: <Money value={figures.toReceive} /> },
        ]}
      />

      {wide ? (
        <Adaptive at={1400} columns="1fr 1fr" gap={32}>
          <div className="flex min-w-0 flex-col gap-4">
            <MonthGrid
              month={month}
              monthName={label}
              weeks={weeks}
              selected={day}
              onSelect={(d) => {
                setDay(d);
                setSelectedId(null);
              }}
            />
            <p className="text-caption text-secondary">
              Faturas de cartão, contas recorrentes e parcelas de financiamento. Compras parceladas aparecem dentro da
              fatura. Previsões não alteram saldos.
            </p>
          </div>
          <Collapsible
            title={title}
            prefKey="calendario/lista"
            actions={
              <>
                {day ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDay(null);
                      setSelectedId(null);
                    }}
                  >
                    Mês inteiro
                  </Button>
                ) : null}
                <Button size="sm" onClick={openSelected} title="Abre a tela onde se paga ou vincula">
                  Abrir…
                </Button>
              </>
            }
          >
            <EntriesTable rows={rows} selectedId={selectedId} onSelect={setSelectedId} onOpen={open} />
          </Collapsible>
        </Adaptive>
      ) : (
        <>
          <DayList rows={allRows} monthName={label} today={today} onOpen={open} />
          <p className="text-caption text-secondary">
            Faturas de cartão, contas recorrentes e parcelas de financiamento. Compras parceladas aparecem dentro da
            fatura. Previsões não alteram saldos.
          </p>
        </>
      )}
    </div>
  );
}
