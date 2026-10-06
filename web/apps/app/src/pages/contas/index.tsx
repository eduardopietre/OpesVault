/**
 * Contas e cartões (desktop `ui/pages/accounts/`): bank accounts, every ledger account, cards, bills,
 * financings, categories, categorization rules and members. Tabs separate different objects; inside a tab a
 * chart and the table of its values sit together. A link from another screen opens the tab of its object,
 * selects it and, with an action, starts it ("pagar" a bill or an installment).
 */
import { Tabs, PageHeader, useMotionPreset, type TabItem } from "@opesvault/ui";
import { motion } from "motion/react";
import { useRef, useState, type ReactNode } from "react";
import { useReveal } from "../../data/navigation.ts";
import { useLedger, useWorkspace } from "../../data/react.tsx";
import { AccountsTab, type AccountReveal } from "./accounts.tsx";
import { BankTab } from "./bank.tsx";
import { BillsTab, type BillReveal } from "./bills.tsx";
import { CardsTab, CategoriesTab, MembersTab } from "./lists.tsx";
import { LoansTab, type LoanReveal } from "./loans.tsx";
import { RulesTab } from "./rules.tsx";
import { TAB_IDS, TAB_LABELS, parseReveal, summaryLine, type TabId } from "./rows.ts";

type Pending =
  | { tab: "bancarias"; seq: number; value: string }
  | { tab: "contas"; seq: number; value: AccountReveal }
  | { tab: "cartoes"; seq: number; value: string }
  | { tab: "faturas"; seq: number; value: BillReveal }
  | { tab: "financiamentos"; seq: number; value: LoanReveal };

/** The tab appears with a short fade: it mounts fresh each time it is chosen. */
function TabPanel({ children }: { children: ReactNode }) {
  const preset = useMotionPreset();
  return <motion.div {...preset.enter}>{children}</motion.div>;
}

export function Page() {
  const ledger = useWorkspace().ledger;
  const [tab, setTab] = useState<TabId>("bancarias");
  const [pending, setPending] = useState<Pending | null>(null);
  const counter = useRef(0);
  const summary = useLedger(summaryLine);

  useReveal((ref, act) => {
    const target = parseReveal(ref, ledger);
    if (!target) return;
    const seq = ++counter.current;
    switch (target.kind) {
      case "bill":
        setPending({
          tab: "faturas",
          seq,
          value: { cardId: target.cardId, month: target.month, pay: act === "pagar" },
        });
        setTab("faturas");
        break;
      case "loan":
        setPending({
          tab: "financiamentos",
          seq,
          value: { planId: target.planId, number: target.number, pay: act === "pagar" },
        });
        setTab("financiamentos");
        break;
      case "check":
        setPending({ tab: "contas", seq, value: { accountId: target.accountId, checks: true } });
        setTab("contas");
        break;
      case "account":
        setPending({ tab: "contas", seq, value: { accountId: target.accountId, checks: false } });
        setTab("contas");
        break;
      case "card":
        setPending({ tab: "cartoes", seq, value: target.cardId });
        setTab("cartoes");
        break;
      case "bank":
        setPending({ tab: "bancarias", seq, value: target.bankId });
        setTab("bancarias");
        break;
    }
  });

  const content: Record<TabId, ReactNode> = {
    bancarias: <BankTab reveal={pending?.tab === "bancarias" ? pending : null} />,
    contas: <AccountsTab reveal={pending?.tab === "contas" ? pending : null} />,
    cartoes: <CardsTab reveal={pending?.tab === "cartoes" ? pending : null} />,
    faturas: <BillsTab reveal={pending?.tab === "faturas" ? pending : null} />,
    financiamentos: <LoansTab reveal={pending?.tab === "financiamentos" ? pending : null} />,
    categorias: <CategoriesTab />,
    regras: <RulesTab />,
    integrantes: <MembersTab />,
  };
  const tabs: TabItem[] = TAB_IDS.map((id) => ({
    id,
    label: TAB_LABELS[id],
    content: <TabPanel>{content[id]}</TabPanel>,
  }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Contas e cartões" context={summary} />
      <Tabs tabs={tabs} value={tab} onValueChange={(id) => setTab(id as TabId)} label="Cadastros" />
    </div>
  );
}
