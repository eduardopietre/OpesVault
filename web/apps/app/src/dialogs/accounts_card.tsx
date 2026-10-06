/**
 * Cartão de crédito (desktop `CardDialog`): a new card also creates its liability account; editing changes
 * the card only. The bill closes and falls due on fixed days of the month.
 */
import {
  AccountSubtype,
  AccountType,
  CardSchema,
  DomainError,
  LedgerAccountSchema,
  type Card,
} from "@opesvault/domain";
import { Select, TextField } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { liquidAccounts } from "./account_choices.ts";
import { BankNameList } from "./accounts_account.tsx";
import { memberChoices } from "./accounts_labels.ts";
import { FormDialog, FormGrid, FullRow, NONE, useFormAct } from "./livro_form.tsx";

export interface CardDialogProps {
  open: boolean;
  onClose: () => void;
  card?: Card;
  onDone?: (card: Card, created: boolean) => void;
}

function readDay(text: string, name: string): number {
  const value = Number(text.trim());
  if (!Number.isInteger(value) || value < 1 || value > 31) throw new DomainError(`${name}: informe um dia de 1 a 31.`);
  return value;
}

export function CardDialog({ open, onClose, card, onDone }: CardDialogProps) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const holders = memberChoices(ledger, [card?.holder_id]);
  const [name, setName] = useState(card?.name ?? "");
  const [institution, setInstitution] = useState("");
  const [holder, setHolder] = useState<string | null>(card?.holder_id ?? holders[0]?.id ?? null);
  const [last4, setLast4] = useState(card?.last4 ?? "");
  const [closing, setClosing] = useState(String(card?.closing_day ?? 1));
  const [due, setDue] = useState(String(card?.due_day ?? 1));
  const [settlement, setSettlement] = useState<string>(card?.settlement_account_id ?? NONE);

  const confirm = () => {
    const title = name.trim();
    if (!title) throw new DomainError("Informe o nome do cartão.");
    const digits = last4.trim();
    if (!/^\d{4}$/.test(digits)) throw new DomainError("Informe os 4 últimos dígitos.");
    if (holder === null) throw new DomainError("Cadastre um integrante antes do cartão.");
    const fields = {
      name: title,
      holder_id: holder,
      last4: digits,
      closing_day: readDay(closing, "Dia de fechamento"),
      due_day: readDay(due, "Dia de vencimento"),
      settlement_account_id: settlement === NONE ? null : settlement,
    };
    const saved = act((l) => {
      if (card) return l.updateCard({ ...card, ...fields }, "Edição do cadastro");
      const liability = l.addAccount(
        LedgerAccountSchema.parse({
          name: title,
          type: AccountType.LIABILITY,
          subtype: AccountSubtype.CREDIT_CARD,
          institution: institution.trim() || null,
          masked_number: `final ${digits}`,
          holders: [holder],
        }),
      );
      return l.addCard(CardSchema.parse({ ...fields, liability_account_id: liability.id }));
    });
    onDone?.(saved, card === undefined);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={card ? "Editar cartão de crédito" : "Novo cartão de crédito"}
      confirmLabel="Salvar cartão"
      onConfirm={confirm}
    >
      <FormGrid>
        <FullRow>
          <TextField
            label="Nome"
            value={name}
            onChange={setName}
            maxLength={120}
            autoComplete="off"
            data-autofocus=""
            required
          />
        </FullRow>
        {card ? null : (
          <TextField
            label="Instituição"
            value={institution}
            onChange={setInstitution}
            list="contas-bancos"
            maxLength={120}
            placeholder="digite para escolher na lista de bancos"
            autoComplete="off"
          />
        )}
        {card ? null : <BankNameList id="contas-bancos" />}
        <Select label="Portador" options={holders} value={holder} onChange={setHolder} placeholder="Sem integrantes" />
        <TextField
          label="Final"
          value={last4}
          onChange={(text) => setLast4(text.replace(/\D/g, "").slice(0, 4))}
          inputMode="numeric"
          maxLength={4}
          placeholder="0000"
          autoComplete="off"
        />
        <TextField
          label="Dia de fechamento"
          value={closing}
          onChange={setClosing}
          type="number"
          min={1}
          max={31}
          inputMode="numeric"
        />
        <TextField
          label="Dia de vencimento"
          value={due}
          onChange={setDue}
          type="number"
          min={1}
          max={31}
          inputMode="numeric"
        />
        <FullRow>
          <Select
            label="Conta de pagamento"
            options={[{ id: NONE, label: "(não definida)" }, ...liquidAccounts(ledger)]}
            value={settlement}
            onChange={setSettlement}
          />
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}
