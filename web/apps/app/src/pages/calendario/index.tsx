/**
 * Calendário: card bills, recurrences, loan installments and investment maturities of the month, day by
 * day (desktop `ui/pages/agenda_page.py`). A bill or installment is paid and a forecast linked right here, with
 * the dialogs of Contas and Recorrências; each entry also opens the place where it lives. "Só atrasados" keeps
 * the late ones. The days are a keyboard grid; on phones the month becomes a list of days. Forecasts never
 * change balances.
 */
import { dom, ymAdd, ymOf, ymFirstDay, ymStr, type IsoDate, type YearMonth } from "@opesvault/domain";
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
import { useLock } from "../../data/read_only.ts";
import { FigureCard, Money } from "../../components/figures.tsx";
import { useAgendaActions } from "./actions.tsx";
import { DayList, EntriesTable, entryRows } from "./entries.tsx";
import { MonthGrid } from "./month_grid.tsx";
import { agendaFigures, entriesOf, lateOnly, monthWeeks } from "./rows.ts";
import { plural } from "../../data/text.ts";

/** The picker reaches two years back and one ahead, as on the desktop. */
const MONTHS_BACK = 24;
const MONTHS_AHEAD = 12;

const NOTE =
  "Faturas de cartão, contas recorrentes e parcelas de financiamento. Compras parceladas aparecem dentro da fatura. Previsões não alteram saldos.";

export function Page() {
  const workspace = useWorkspace();
  const go = useGoTo();
  const { locked } = useLock();
  const [month, setMonth] = useSharedMonth();
  const [day, setDay] = useState<IsoDate | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [onlyLate, setOnlyLate] = useState(false);
  const [cursor, setCursor] = useState<IsoDate | null>(null);
  const wide = useMediaQuery("(min-width: 640px)");
  const today = workspace.today();
  const monthKey = ymStr(month);
  const label = formatMonth(month);
  const min = ymAdd(ymOf(today), -MONTHS_BACK);
  const max = ymAdd(ymOf(today), MONTHS_AHEAD);
  const actions = useAgendaActions();

  const events = useLedger((ledger) => dom.agenda.monthEvents(ledger, month, today), `${monthKey}|${today}`);
  const figures = useMemo(() => agendaFigures(events), [events]);
  const weeks = monthWeeks(month, events, today);
  const late = useMemo(() => lateOnly(events), [events]);
  const listed = onlyLate ? late : events;
  const shown = useMemo(() => entriesOf(listed, day), [listed, day]);
  const rows = entryRows(shown, actions.actionOf);
  const allRows = entryRows(listed, actions.actionOf);

  // The day in the grid's tab order: the one the keyboard is on, else the chosen one, today or the 1st.
  const focused =
    cursor && cursor.startsWith(monthKey)
      ? cursor
      : day && day.startsWith(monthKey)
        ? day
        : today.startsWith(monthKey)
          ? today
          : ymFirstDay(month);

  const chooseMonth = (next: YearMonth) => {
    setDay(null);
    setSelectedId(null);
    setMonth(next);
  };
  const moveTo = (date: IsoDate) => {
    const target = ymOf(date);
    if (ymStr(target) < ymStr(min) || ymStr(target) > ymStr(max)) return;
    if (ymStr(target) !== monthKey) chooseMonth(target);
    setCursor(date);
  };
  const chooseDay = (date: IsoDate | null) => {
    setDay(date);
    setSelectedId(null);
    if (date) setCursor(date);
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
  const toggleLate = () => {
    setOnlyLate((value) => !value);
    setSelectedId(null);
  };

  const what = onlyLate ? "Atrasados" : "Vencimentos";
  const title = day ? `${what} de ${day.split("-").reverse().join("/")}` : `${what} do mês`;
  const emptyText = onlyLate ? "Nenhum vencimento atrasado neste período." : "Nenhum vencimento neste período.";
  const picker = <MonthPicker value={month} onChange={chooseMonth} min={min} max={max} />;
  const count = events.length;
  const lateButton = (
    <Button
      size="sm"
      variant={onlyLate ? "secondary" : "ghost"}
      aria-pressed={onlyLate}
      disabled={!onlyLate && late.length === 0}
      onClick={toggleLate}
      title={late.length ? "Mostra só o que venceu e não foi pago" : "Nada atrasado neste mês"}
    >
      Só atrasados ({late.length})
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Calendário" context={`${plural(count, "vencimento", "vencimentos")} em ${label}`}>
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
              onSelect={chooseDay}
              focused={focused}
              onMove={moveTo}
            />
            <p className="text-caption text-secondary">{NOTE}</p>
          </div>
          <Collapsible
            title={title}
            prefKey="calendario/lista"
            actions={
              <>
                {lateButton}
                {day ? (
                  <Button size="sm" variant="ghost" onClick={() => chooseDay(null)}>
                    Mês inteiro
                  </Button>
                ) : null}
                <Button size="sm" onClick={openSelected} title="Abre a tela onde se paga ou vincula">
                  Abrir…
                </Button>
              </>
            }
          >
            <EntriesTable
              rows={rows}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onOpen={open}
              locked={locked}
              emptyText={emptyText}
            />
          </Collapsible>
        </Adaptive>
      ) : (
        <>
          <div className="flex justify-end">{lateButton}</div>
          <DayList
            rows={allRows}
            monthName={label}
            today={today}
            onOpen={open}
            {...(onlyLate ? { emptyText: `Nenhum vencimento atrasado em ${label}.` } : {})}
          />
          <p className="text-caption text-secondary">{NOTE}</p>
        </>
      )}
      {actions.dialogs}
    </div>
  );
}
