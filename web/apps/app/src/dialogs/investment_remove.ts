/**
 * Excluir investimento, from Investimentos and from Contas bancárias' composition: a confirmation that says what
 * goes and what stays, then one action (one undo), and a notice that offers Desfazer.
 */
import { investments, type Id } from "@opesvault/domain";
import { confirm } from "@opesvault/ui";
import { useAct, useNotifyDone } from "../data/react.tsx";

/** Asks first; resolves to whether the investment was removed. */
export function useRemoveInvestment(): (positionId: Id, name: string) => Promise<boolean> {
  const act = useAct();
  const notifyDone = useNotifyDone();
  return async (positionId, name) => {
    const ok = await confirm({
      title: `Excluir “${name}”?`,
      text:
        "O investimento sai do projeto com as avaliações, os aportes, os resgates e as características. Os " +
        "lançamentos dele são cancelados e o dinheiro volta às contas de onde saiu; o cancelamento fica no " +
        "histórico do Livro. Dá para desfazer logo em seguida.",
      confirmLabel: "Excluir",
      danger: true,
    });
    if (!ok) return false;
    let removed = false;
    act(
      (l) => {
        investments.service.removePosition(l, positionId);
        removed = true;
      },
      { label: "excluir investimento" },
    );
    if (removed) notifyDone("Investimento excluído.");
    return removed;
  };
}
