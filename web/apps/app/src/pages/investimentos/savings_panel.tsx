/**
 * A savings account in Investimentos: its balance, what was put in and the interest, and the balance month by
 * month. It is read from Livro, where its deposits, withdrawals and interest are recorded (`investments.savings`).
 */
import { charts, investments, ymAdd, ymOf, type Id, type IsoDate } from "@opesvault/domain";
import { Button, ChartPanel, ElidedText } from "@opesvault/ui";
import { toChartData } from "../../data/chart_data.ts";
import { useLedger } from "../../data/react.tsx";
import { FigureCard } from "./detail.tsx";
import { savingsDetail } from "./rows.ts";

/** Months of balance in the chart. */
const HISTORY_MONTHS = 24;

export function SavingsPanel({
  accountId,
  today,
  onSeeEntries,
  onBank,
}: {
  accountId: Id;
  today: IsoDate;
  onSeeEntries: () => void;
  onBank: (bankId: Id) => void;
}) {
  const key = `${accountId}|${today}`;
  // Nothing once the account is gone (archived or undone) while this panel leaves.
  const exists = useLedger((l) => investments.savings.savingsAccounts(l).some((a) => a.id === accountId), key);
  const numbers = useLedger((l) => (exists ? savingsDetail(l, accountId, today) : null), `${key}|${exists}`);
  const history = useLedger((l) => {
    if (!exists) return null;
    const end = ymOf(today);
    return toChartData(charts.data.accountBalanceHistory(l, accountId, ymAdd(end, -(HISTORY_MONTHS - 1)), end));
  }, `${key}|${exists}`);
  if (numbers === null || history === null) return null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="text-headline font-semibold text-text">
            <ElidedText className="block">{numbers.name}</ElidedText>
          </h2>
          <p className="mt-1 text-body text-secondary">
            Conta poupança · depósitos, retiradas e juros são lançados no Livro
          </p>
        </div>
        <div role="toolbar" aria-label="Comandos da poupança" className="flex flex-wrap items-center gap-2">
          <Button onClick={onSeeEntries}>Ver lançamentos</Button>
          {numbers.bankId ? <Button onClick={() => onBank(numbers.bankId!)}>Ver conta bancária</Button> : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 medium:grid-cols-3">
        <FigureCard label="Último valor" text={numbers.value} raw={numbers.valueRaw} />
        <FigureCard label="Total investido" text={numbers.invested} raw={numbers.investedRaw} />
        <FigureCard
          label="Rendimento"
          text={numbers.income}
          raw={numbers.incomeRaw}
          tone={numbers.incomeTone ?? undefined}
        />
      </div>
      <p className="-mt-3 text-caption text-secondary">
        Último valor: o saldo da conta hoje. Rendimento: os juros lançados como receita nesta conta. Total investido: o
        saldo menos esses juros (depósitos menos retiradas).
      </p>

      <section aria-label="Evolução" className="min-w-0">
        <ChartPanel chart={history} prefKey="investimentos/poupanca" height={280} />
      </section>
    </div>
  );
}
