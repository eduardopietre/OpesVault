/**
 * The Livro's filter row (desktop `pages/ledger/filters.py`): period (with the shared month), accounts and
 * categories, members, status, origin and tag. Each choice narrows the table at once; "Limpar filtros" puts
 * everything back. The choices are the project's own accounts, members and tags.
 */
import {
  AccountSubtype,
  AccountType,
  OriginKind,
  casefold,
  dom,
  sortedBy,
  type Ledger,
  type YearMonth,
} from "@opesvault/domain";
import { Button, Collapsible, DateField, MonthPicker, Select, useBand, type SelectOption } from "@opesvault/ui";
import { AnimatePresence, motion } from "motion/react";
import { FilterX } from "lucide-react";
import { useMemo } from "react";
import { useLedger } from "../../data/react.tsx";
import { NONE, monthLabel } from "../../dialogs/livro_form.tsx";
import { ORIGIN_LABELS, PERIODS, STATUS_LABELS, filtersActive, type FilterState, type PeriodKey } from "./rows.ts";
import type { search } from "@opesvault/domain";

export interface FilterChoices {
  accounts: SelectOption[];
  members: SelectOption[];
  tags: string[];
}

/** Accounts, members and tags of this project, for the filter selects. */
export function filterChoices(ledger: Ledger): FilterChoices {
  const accounts = sortedBy(ledger.accounts.values(), (a) => [a.type, casefold(a.name)])
    .filter(
      (a) => a.type === AccountType.ASSET || a.type === AccountType.LIABILITY || a.subtype === AccountSubtype.CATEGORY,
    )
    .map((a) => ({ id: a.id, label: a.subtype === AccountSubtype.CATEGORY ? `Categoria: ${a.name}` : a.name }));
  return {
    accounts,
    members: [...ledger.members.values()].map((m) => ({ id: m.id, label: m.name })),
    tags: dom.tags.allTags(ledger),
  };
}

export function useFilterChoices(): FilterChoices {
  return useLedger(filterChoices);
}

export interface FilterBarProps {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  month: YearMonth;
  onMonth: (month: YearMonth) => void;
  choices: FilterChoices;
  onReset: () => void;
  /** Commands that wrap together with the filters (saved filters, actions, details). */
  children?: React.ReactNode;
}

const w = "w-full tablet:w-auto tablet:min-w-40";

function choose<T extends string>(id: string, empty: T | null = null): T | null {
  return id === NONE ? empty : (id as T);
}

export function FilterBar({ filters, onChange, month, onMonth, choices, onReset, children }: FilterBarProps) {
  const band = useBand();
  const set = (changes: Partial<FilterState>) => onChange({ ...filters, ...changes });
  const periods = useMemo<SelectOption[]>(
    () => PERIODS.map(([id, label]) => ({ id, label: id === "month" ? monthLabel(month) : label })),
    [month],
  );
  const active = filtersActive(filters);
  const count =
    (filters.period !== "all" ? 1 : 0) +
    [filters.account, filters.member, filters.origin, filters.tag].filter((v) => v !== null).length +
    (filters.status !== "all" ? 1 : 0) +
    (filters.text.trim() ? 1 : 0);

  const row = (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtros do livro">
      <Select
        label="Período"
        hideLabel
        className={w}
        options={periods}
        value={filters.period}
        onChange={(id) => set({ period: id as PeriodKey })}
      />
      {filters.period === "month" ? <MonthPicker value={month} onChange={onMonth} label="Mês do livro" /> : null}
      {filters.period === "custom" ? (
        <div className="flex flex-wrap items-center gap-2">
          <DateField
            label="Data inicial"
            hideLabel
            fieldClassName="w-36"
            value={filters.start}
            onChange={(start) => set({ start })}
          />
          <span className="text-body text-secondary">até</span>
          <DateField
            label="Data final"
            hideLabel
            fieldClassName="w-36"
            value={filters.end}
            onChange={(end) => set({ end })}
          />
        </div>
      ) : null}
      <Select
        label="Conta ou categoria"
        hideLabel
        className={`${w} tablet:w-56`}
        options={[{ id: NONE, label: "Todas as contas" }, ...choices.accounts]}
        value={filters.account ?? NONE}
        onChange={(id) => set({ account: choose(id), withChildren: false })}
      />
      <Select
        label="Integrante"
        hideLabel
        className={w}
        options={[{ id: NONE, label: "Todos os integrantes" }, ...choices.members]}
        value={filters.member ?? NONE}
        onChange={(id) => set({ member: choose(id) })}
      />
      <Select
        label="Situação"
        hideLabel
        className={w}
        options={Object.entries(STATUS_LABELS).map(([id, label]) => ({ id, label }))}
        value={filters.status}
        onChange={(id) => set({ status: id as search.StatusFilter })}
      />
      <Select
        label="Origem"
        hideLabel
        className={w}
        options={[
          { id: NONE, label: "Todas as origens" },
          ...Object.values(OriginKind).map((id) => ({ id, label: ORIGIN_LABELS[id] })),
        ]}
        value={filters.origin ?? NONE}
        onChange={(id) => set({ origin: choose<OriginKind>(id) })}
      />
      {choices.tags.length || filters.tag !== null ? (
        <Select
          label="Marcador"
          hideLabel
          className={w}
          options={[{ id: NONE, label: "Todos os marcadores" }, ...choices.tags.map((t) => ({ id: t, label: t }))]}
          value={filters.tag ?? NONE}
          onChange={(id) => set({ tag: choose(id) })}
        />
      ) : null}
      <AnimatePresence initial={false}>
        {active ? (
          <motion.span
            key="clear"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.12 }}
          >
            <Button variant="ghost" icon={<FilterX />} onClick={onReset}>
              Limpar filtros
            </Button>
          </motion.span>
        ) : null}
      </AnimatePresence>
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      {band === "phone" ? (
        <Collapsible
          title={count ? `Filtros (${count} ativos)` : "Filtros"}
          level={3}
          defaultOpen={false}
          prefKey="livro/filtros"
        >
          {row}
        </Collapsible>
      ) : (
        row
      )}
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}
