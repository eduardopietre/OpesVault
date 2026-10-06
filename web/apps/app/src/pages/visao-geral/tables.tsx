/**
 * The short tables of Visão geral (desktop `summary_table`): accounts, spending by category and the
 * comparison with previous months. Each line opens its operations in the Livro financeiro.
 */
import { formatBrl } from "@opesvault/domain";
import { cn, useMotionPreset } from "@opesvault/ui";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { SHARE_BARS_FROM, type BalanceRow, type CategoryRow, type ComparisonRow } from "./rows.ts";

const OPEN_HINT = "Ver os lançamentos deste mês no Livro financeiro";

const head = "py-2 text-caption font-semibold text-secondary";
const cell = "py-2 align-middle";
const num = "pl-3 text-right whitespace-nowrap tabular-nums";

/** The name of a line: a button that opens the line's operations. */
function OpenButton({ id, children, onOpen }: { id: string; children: string; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      title={`${OPEN_HINT}: ${children}`}
      onClick={() => onOpen(id)}
      className="max-w-full rounded-sm text-left text-body text-text [overflow-wrap:anywhere] hover:text-accent"
    >
      {children}
    </button>
  );
}

function Wrapper({ label, children }: { label: string; children: ReactNode }) {
  return (
    // Scrolls inside itself on a very narrow screen, never the page.
    <div role="region" aria-label={label} tabIndex={0} className="max-w-full overflow-x-auto rounded-sm">
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-3 text-body text-secondary">{children}</p>;
}

export function BalancesTable({ rows, onOpen }: { rows: readonly BalanceRow[]; onOpen: (id: string) => void }) {
  if (!rows.length) return <Empty>Nenhuma conta ainda. Cadastre em Contas e cartões.</Empty>;
  return (
    <Wrapper label="Saldos das contas">
      <table className="w-full border-collapse">
        <caption className="sr-only">Saldos das contas no fim do mês</caption>
        <thead>
          <tr className="border-b border-separator">
            <th scope="col" className={cn(head, "pr-3 text-left")}>
              Conta
            </th>
            <th scope="col" className={cn(head, "text-right")}>
              Saldo
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-separator/70 hover:bg-hover">
              <td className={cn(cell, "pr-3")}>
                <OpenButton id={row.id} onOpen={onOpen}>
                  {row.name}
                </OpenButton>
              </td>
              <td className={cn(cell, num)}>{formatBrl(row.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Wrapper>
  );
}

function ShareBar({ share }: { share: number }) {
  const preset = useMotionPreset();
  return (
    <span aria-hidden="true" className="hidden h-1 w-16 overflow-hidden rounded-full bg-separator tablet:inline-block">
      <motion.span
        className="block h-full origin-left rounded-full bg-tertiary"
        initial={preset.reduce ? false : { scaleX: 0 }}
        animate={{ scaleX: share }}
        transition={preset.enter.transition}
      />
    </span>
  );
}

export function CategoriesTable({ rows, onOpen }: { rows: readonly CategoryRow[]; onOpen: (id: string) => void }) {
  if (!rows.length) return <Empty>Sem despesas neste mês.</Empty>;
  // Bars only help when there is something to compare.
  const bars = rows.length >= SHARE_BARS_FROM;
  return (
    <Wrapper label="Despesas por categoria">
      <table className="w-full border-collapse">
        <caption className="sr-only">Despesas por categoria no mês</caption>
        <thead>
          <tr className="border-b border-separator">
            <th scope="col" className={cn(head, "pr-3 text-left")}>
              Categoria
            </th>
            <th scope="col" className={cn(head, "text-right")}>
              Despesa
            </th>
            <th scope="col" className={cn(head, "text-right")}>
              % do total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-separator/70 hover:bg-hover">
              <td className={cn(cell, "pr-3")}>
                <OpenButton id={row.id} onOpen={onOpen}>
                  {row.name}
                </OpenButton>
              </td>
              <td className={cn(cell, num)}>{formatBrl(row.value)}</td>
              <td className={cn(cell, num)}>
                <span className="inline-flex items-center justify-end gap-2">
                  {bars && row.share !== null ? <ShareBar share={row.share} /> : null}
                  <span className="inline-block min-w-[3ch] text-right">{row.percent}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Wrapper>
  );
}

const money = (value: Parameters<typeof formatBrl>[0] | null) => (value === null ? "—" : formatBrl(value));

export function ComparisonTable({ rows, onOpen }: { rows: readonly ComparisonRow[]; onOpen: (id: string) => void }) {
  return (
    <Wrapper label="Comparação com a média">
      <table className="w-full border-collapse">
        <caption className="sr-only">Este mês comparado à média de 3 meses e a um ano antes</caption>
        <thead>
          <tr className="border-b border-separator">
            <th scope="col" className={cn(head, "pr-3 text-left")}>
              <span className="sr-only">Item</span>
            </th>
            <th scope="col" className={cn(head, "text-right")}>
              Este mês
            </th>
            <th scope="col" className={cn(head, "pl-3 text-right")}>
              Média de 3 meses
            </th>
            <th scope="col" className={cn(head, "pl-3 text-right")}>
              Variação
            </th>
            <th scope="col" className={cn(head, "hidden pl-3 text-right tablet:table-cell")}>
              Um ano antes
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              className={cn("border-b border-separator/70", row.categoryId !== null && "hover:bg-hover")}
            >
              <td className={cn(cell, "pr-3", row.category && "pl-4", !row.category && "font-medium")}>
                {row.categoryId !== null ? (
                  <OpenButton id={row.categoryId} onOpen={onOpen}>
                    {row.name}
                  </OpenButton>
                ) : (
                  row.name
                )}
              </td>
              <td className={cn(cell, num)}>{formatBrl(row.current)}</td>
              <td className={cn(cell, num)}>{money(row.average)}</td>
              <td className={cn(cell, num)}>{row.variation}</td>
              <td className={cn(cell, num, "hidden tablet:table-cell")}>{money(row.lastYear)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Wrapper>
  );
}
