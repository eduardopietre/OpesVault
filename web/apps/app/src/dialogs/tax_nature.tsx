/**
 * Natureza dos rendimentos (desktop `NatureDialog`): how each income category and each investment goes in the
 * return. The choice is the person's: nothing is classified on its own, and what is left "A definir" is a
 * pending item of the page.
 */
import { AccountType, investments, sortedBy, tax, type Id, type Ledger } from "@opesvault/domain";
import { Select, type SelectOption } from "@opesvault/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { Caption, FormDialog, NONE, useFormAct } from "./livro_form.tsx";

export interface NatureEntry {
  /** "category:<id>" or "position:<id>". */
  key: string;
  name: string;
  subject: tax.model.NatureSubject;
  ref: Id;
}

export const natureKey = (subject: tax.model.NatureSubject, ref: Id): string => `${subject}:${ref}`;

/** The income categories and the open investments, in the order the dialog lists them. */
export function natureEntries(ledger: Ledger): NatureEntry[] {
  const categories = sortedBy(
    ledger.categories(AccountType.INCOME).filter((a) => !a.archived),
    (a) => a.name.toLowerCase(),
  );
  const entries: NatureEntry[] = categories.map((a) => ({
    key: natureKey(tax.model.NatureSubject.CATEGORY, a.id),
    name: a.name,
    subject: tax.model.NatureSubject.CATEGORY,
    ref: a.id,
  }));
  const assets = investments.service.assets(ledger);
  for (const position of investments.service.positions(ledger).values()) {
    if (position.closed) continue;
    entries.push({
      key: natureKey(tax.model.NatureSubject.POSITION, position.id),
      name: `Investimento: ${assets.get(position.asset_id)?.name ?? "?"}`,
      subject: tax.model.NatureSubject.POSITION,
      ref: position.id,
    });
  }
  return entries;
}

const OPTIONS: SelectOption[] = [
  { id: NONE, label: "A definir" },
  ...Object.entries(tax.model.NATURE_LABELS).map(([id, label]) => ({ id, label })),
];

export interface NatureDialogProps {
  open: boolean;
  onClose: () => void;
  /** The line to start on (a row of the income sheet or a pending item). */
  focus?: { subject: tax.model.NatureSubject; ref: Id } | null;
  onDone?: () => void;
}

export function NatureDialog({ open, onClose, focus = null, onDone }: NatureDialogProps) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const entries = useMemo(() => natureEntries(ledger), [ledger]);
  const [chosen, setChosen] = useState<Record<string, string>>(() =>
    Object.fromEntries(entries.map((e) => [e.key, tax.records.natureOf(ledger, e.subject, e.ref) ?? NONE])),
  );
  const focusKey = focus ? natureKey(focus.subject, focus.ref) : null;
  const list = useRef<HTMLUListElement>(null);

  // The line asked for comes into view with its choice ready to change.
  useEffect(() => {
    if (focusKey === null) return;
    const row = list.current?.querySelector<HTMLElement>(`[data-nature="${CSS.escape(focusKey)}"]`);
    row?.scrollIntoView({ block: "center" });
    row?.querySelector<HTMLElement>("[role=combobox]")?.focus();
  }, [focusKey]);

  const confirm = () => {
    act((l) => {
      for (const entry of entries) {
        const value = chosen[entry.key] ?? NONE;
        const nature = value === NONE ? null : (value as tax.model.IncomeNature);
        if (tax.records.natureOf(l, entry.subject, entry.ref) !== nature) {
          tax.records.classify(l, entry.subject, entry.ref, nature);
        }
      }
    });
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Natureza dos rendimentos"
      size="lg"
      confirmLabel="Salvar"
      onConfirm={confirm}
    >
      {entries.length === 0 ? (
        <p className="text-body text-secondary">
          Ainda não há categorias de receita nem investimentos. Cadastre-os em Contas e cartões › Categorias e em
          Investimentos.
        </p>
      ) : (
        <ul ref={list} aria-label="Natureza de cada receita" className="flex flex-col divide-y divide-separator">
          {entries.map((entry) => (
            <li
              key={entry.key}
              data-nature={entry.key}
              className="grid grid-cols-1 items-center gap-x-4 gap-y-1 py-2 tablet:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]"
            >
              <span className="min-w-0 text-body font-medium [overflow-wrap:anywhere]">{entry.name}</span>
              <Select
                label={`Natureza: ${entry.name}`}
                hideLabel
                options={OPTIONS}
                value={chosen[entry.key] ?? NONE}
                onChange={(value) => setChosen((all) => ({ ...all, [entry.key]: value }))}
              />
            </li>
          ))}
        </ul>
      )}
      <Caption>
        Rendimentos de investimento (proventos e ganhos em resgates) seguem a natureza do investimento. Vendas de ações,
        ETF e fundos imobiliários ficam em Renda variável. Nada é classificado sozinho.
      </Caption>
    </FormDialog>
  );
}
