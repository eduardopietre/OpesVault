/**
 * Corrections of one operation (desktop `ui/operation_edit.py`, RF-22): `SimpleEditDialog` for a day-to-day
 * entry in the words it was recorded with, and `OperationEditDialog`, the full editor with dates,
 * competence, member and every posting (debits and credits, and who each share belongs to: the rateio).
 * Every change goes through `Ledger.updateOperation`, so validation, closed-month guards and the history with
 * a reason stay in the domain.
 */
import {
  AccountType,
  Dec,
  DomainError,
  OperationKind,
  ZERO,
  cashDate,
  dom,
  formatBrl,
  type Id,
  type Ledger,
  type Operation,
  type Posting,
} from "@opesvault/domain";
import { Button, DateField, MoneyField, Select, TextField, type SelectOption } from "@opesvault/ui";
import { Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { assetAccounts, balanceAccounts, categoryItems, postableAccounts, withCurrent } from "./account_choices.ts";
import {
  Caption,
  FormDialog,
  FormGrid,
  FullRow,
  NONE,
  OptionalDateField,
  competenceChoice,
  competenceFromChoice,
  competenceOptions,
  dateText,
  memberFromChoice,
  memberOptions,
  optionalDateValue,
  plainMoney,
  readDate,
  readMoney,
  readOptionalDate,
  useFormAct,
  type OptionalDateValue,
} from "./livro_form.tsx";

// ── shared rules ────────────────────────────────

/** A posting's side text as an amount: empty is none, anything else must be a positive value. */
export function parseSide(text: string): Dec | null {
  const typed = text.trim();
  if (!typed) return null;
  const value = readMoney(typed);
  if (!value.isPositive()) throw new DomainError("Débito e crédito são informados como valores positivos.");
  return value;
}

export interface PostingRow {
  key: number;
  account: string | null;
  debit: string;
  credit: string;
  member: string;
}

/** Rows are (account, debit text, credit text, member). Exactly one side per row. */
export function buildPostings(rows: readonly PostingRow[]): Posting[] {
  const postings: Posting[] = [];
  for (const row of rows) {
    const debit = parseSide(row.debit);
    const credit = parseSide(row.credit);
    if (row.account === null && debit === null && credit === null) continue;
    if (row.account === null) throw new DomainError("Escolha a conta de cada partida.");
    if ((debit === null) === (credit === null))
      throw new DomainError("Cada partida tem débito ou crédito, não os dois.");
    const amount = debit ?? (credit as Dec).negate();
    postings.push({ account_id: row.account, amount, member_id: memberFromChoice(row.member) });
  }
  if (postings.length < 2) throw new DomainError("Uma operação precisa de pelo menos duas partidas.");
  return postings;
}

/** Debits minus credits, or null while some value is unreadable. */
export function imbalance(rows: readonly PostingRow[]): Dec | null {
  let total = ZERO;
  for (const row of rows) {
    try {
      total = total.add(parseSide(row.debit) ?? ZERO).sub(parseSide(row.credit) ?? ZERO);
    } catch {
      return null;
    }
  }
  return total;
}

/** Value equality of two operations (12.5 and 12.50 are the same amount). */
export function sameOperation(a: Operation, b: Operation): boolean {
  const scalars = [
    "description",
    "occurred_on",
    "booked_on",
    "settled_on",
    "due_on",
    "member_id",
    "notes",
    "kind",
    "status",
    "card_id",
  ] as const;
  if (scalars.some((key) => a[key] !== b[key])) return false;
  const ma = a.accrual_month;
  const mb = b.accrual_month;
  if ((ma === null) !== (mb === null) || (ma && mb && (ma.year !== mb.year || ma.month !== mb.month))) return false;
  if (a.postings.length !== b.postings.length) return false;
  return a.postings.every((p, i) => {
    const q = b.postings[i] as Posting;
    return p.account_id === q.account_id && p.amount.eq(q.amount) && p.member_id === q.member_id;
  });
}

export const SIMPLE_KINDS: Readonly<
  Partial<Record<OperationKind, readonly [string, string, "both" | "debit" | "credit"]>>
> = {
  // kind: (label of the credited side, label of the debited side, which side may change)
  [OperationKind.EXPENSE]: ["Conta de origem", "Categoria", "both"],
  [OperationKind.INCOME]: ["Categoria", "Conta de destino", "both"],
  [OperationKind.TRANSFER]: ["De", "Para", "both"],
  [OperationKind.CARD_PURCHASE]: ["Cartão", "Categoria", "debit"],
  [OperationKind.CARD_PAYMENT]: ["Pago pela conta", "Cartão", "credit"],
};

/** One amount between two accounts, not part of an installment plan: editable without postings. */
export function isSimple(ledger: Ledger, op: Operation): boolean {
  if (!(op.kind in SIMPLE_KINDS) || op.postings.length !== 2) return false;
  const [first, second] = op.postings as [Posting, Posting];
  if (!first.amount.add(second.amount).isZero() || first.amount.isZero()) return false;
  for (const plan of dom.cards.plans(ledger).values()) if (plan.operation_ids.includes(op.id)) return false;
  return true;
}

function sideChoices(ledger: Ledger, kind: OperationKind, debit: boolean): SelectOption[] {
  if (kind === OperationKind.TRANSFER) return balanceAccounts(ledger);
  if (kind === OperationKind.EXPENSE || kind === OperationKind.CARD_PURCHASE) {
    return debit ? categoryItems(ledger, AccountType.EXPENSE) : assetAccounts(ledger);
  }
  if (kind === OperationKind.INCOME) {
    return debit ? assetAccounts(ledger) : categoryItems(ledger, AccountType.INCOME);
  }
  return assetAccounts(ledger); // card payment: the paying account (credited)
}

const REASON_HINT = "Obrigatório; fica no histórico com a versão anterior.";

// ── the day-to-day form ─────────────────────────

export interface EditDialogProps {
  open: boolean;
  onClose: () => void;
  operation: Operation;
  onDone?: () => void;
}

export function SimpleEditDialog({
  open,
  onClose,
  operation: op,
  onDone,
  onFullEditor,
}: EditDialogProps & { onFullEditor?: () => void }) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const [creditLabel, debitLabel, editable] = SIMPLE_KINDS[op.kind] as readonly [
    string,
    string,
    "both" | "debit" | "credit",
  ];
  const debitPosting = op.postings.find((p) => p.amount.isPositive()) as Posting;
  const creditPosting = op.postings.find((p) => p.amount.isNegative()) as Posting;
  const base = op.occurred_on ?? cashDate(op);

  const creditOptions = useMemo(
    () => withCurrent(ledger, sideChoices(ledger, op.kind, false), creditPosting.account_id),
    [ledger, op.kind, creditPosting.account_id],
  );
  const debitOptions = useMemo(
    () => withCurrent(ledger, sideChoices(ledger, op.kind, true), debitPosting.account_id),
    [ledger, op.kind, debitPosting.account_id],
  );
  const members = useMemo(() => memberOptions(ledger, op.member_id), [ledger, op.member_id]);
  const competences = useMemo(
    () => competenceOptions(op.accrual_month, base ?? workspace.today()),
    [op, base, workspace],
  );

  const [description, setDescription] = useState(op.description);
  const [amount, setAmount] = useState(plainMoney(debitPosting.amount));
  const [when, setWhen] = useState(dateText(base));
  const [credit, setCredit] = useState<string | null>(creditPosting.account_id);
  const [debit, setDebit] = useState<string | null>(debitPosting.account_id);
  const [competence, setCompetence] = useState(competenceChoice(op.accrual_month));
  const [member, setMember] = useState(op.member_id ?? NONE);
  const [notes, setNotes] = useState(op.notes ?? "");
  const [reason, setReason] = useState("");
  const withCompetence =
    op.kind === OperationKind.EXPENSE || op.kind === OperationKind.INCOME || op.kind === OperationKind.CARD_PURCHASE;

  const build = (): Operation => {
    const text = description.trim();
    if (!text) throw new DomainError("Informe a descrição.");
    const value = readMoney(amount);
    if (!value.isPositive()) throw new DomainError("Informe um valor positivo.");
    if (!debit || !credit || debit === credit) {
      throw new DomainError("Escolha contas diferentes para a origem e o destino.");
    }
    const newDate = readDate(when, "A data");
    const moved = (current: typeof op.occurred_on) => (current === base ? newDate : current);
    // The day-to-day forms record one date in several fields; move those that held it.
    return {
      ...op,
      description: text,
      occurred_on: moved(op.occurred_on),
      booked_on: moved(op.booked_on),
      settled_on: moved(op.settled_on),
      accrual_month: competenceFromChoice(competence),
      member_id: memberFromChoice(member),
      notes: notes.trim() || null,
      postings: op.postings.map((p) =>
        p.amount.isPositive()
          ? { ...p, account_id: debit as Id, amount: value }
          : { ...p, account_id: credit as Id, amount: value.negate() },
      ),
    };
  };

  const confirm = () => {
    if (!reason.trim()) throw new DomainError("O motivo da correção é obrigatório.");
    const updated = build();
    if (sameOperation(updated, op)) throw new DomainError("Nada foi alterado.");
    ledger.validateOperation(updated);
    act((l) => l.updateOperation(updated, reason.trim()));
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Corrigir lançamento"
      description="A versão anterior fica no histórico, com o motivo."
      confirmLabel="Salvar correção"
      onConfirm={confirm}
      extraActions={
        onFullEditor ? (
          <Button
            variant="ghost"
            onClick={onFullEditor}
            title="Editor completo, com débitos e créditos"
            className="tablet:mr-auto"
          >
            Corrigir partidas…
          </Button>
        ) : null
      }
    >
      <FormGrid>
        <FullRow>
          <TextField label="Descrição" value={description} onChange={setDescription} autoComplete="off" />
        </FullRow>
        <MoneyField label="Valor" value={amount} onChange={setAmount} />
        <DateField label="Data" value={when} onChange={setWhen} />
        <Select
          label={creditLabel}
          options={creditOptions}
          value={credit}
          onChange={setCredit}
          disabled={editable === "debit"}
        />
        <Select
          label={debitLabel}
          options={debitOptions}
          value={debit}
          onChange={setDebit}
          disabled={editable === "credit"}
        />
        {withCompetence ? (
          <>
            <Select label="Competência" options={competences} value={competence} onChange={setCompetence} />
            <Select label="Responsável" options={members} value={member} onChange={setMember} />
          </>
        ) : null}
        <FullRow>
          <TextField label="Observações" value={notes} onChange={setNotes} autoComplete="off" />
        </FullRow>
        <FullRow>
          <TextField
            label="Motivo da correção"
            value={reason}
            onChange={setReason}
            hint={REASON_HINT}
            autoComplete="off"
            required
          />
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}

// ── the full editor ─────────────────────────────

export function OperationEditDialog({ open, onClose, operation: op, onDone }: EditDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const base = op.occurred_on ?? cashDate(op) ?? workspace.today();
  const accounts = useMemo(
    () => postableAccounts(ledger, new Set(op.postings.map((p) => p.account_id))),
    [ledger, op.postings],
  );
  const members = useMemo(() => memberOptions(ledger, op.member_id), [ledger, op.member_id]);
  const postingMembers = useMemo(() => memberOptions(ledger, null, "—"), [ledger]);
  const competences = useMemo(() => competenceOptions(op.accrual_month, base), [op.accrual_month, base]);
  const nextKey = useRef(op.postings.length);

  const [description, setDescription] = useState(op.description);
  const [occurred, setOccurred] = useState<OptionalDateValue>(optionalDateValue(op.occurred_on));
  const [booked, setBooked] = useState<OptionalDateValue>(optionalDateValue(op.booked_on));
  const [settled, setSettled] = useState<OptionalDateValue>(optionalDateValue(op.settled_on));
  const [due, setDue] = useState<OptionalDateValue>(optionalDateValue(op.due_on));
  const [competence, setCompetence] = useState(competenceChoice(op.accrual_month));
  const [member, setMember] = useState(op.member_id ?? NONE);
  const [notes, setNotes] = useState(op.notes ?? "");
  const [rows, setRows] = useState<PostingRow[]>(
    op.postings.map((p, key) => ({
      key,
      account: p.account_id,
      // Plain digits, no rounding: what is shown is exactly what is stored.
      debit: p.amount.isPositive() ? plainMoney(p.amount) : "",
      credit: p.amount.isNegative() ? plainMoney(p.amount) : "",
      member: p.member_id ?? NONE,
    })),
  );
  const [reason, setReason] = useState("");

  const update = (key: number, changes: Partial<PostingRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...changes } : row)));
  const diff = imbalance(rows);
  const balance =
    diff === null
      ? "Valor ilegível"
      : diff.isZero()
        ? "Equilibrada ✓"
        : `Sobram ${formatBrl(diff.abs())} em ${diff.isPositive() ? "débitos" : "créditos"}`;

  const build = (): Operation => {
    const text = description.trim();
    if (!text) throw new DomainError("Informe a descrição.");
    return {
      ...op,
      description: text,
      occurred_on: readOptionalDate(occurred, "A data de ocorrência"),
      booked_on: readOptionalDate(booked, "A data de lançamento"),
      settled_on: readOptionalDate(settled, "A data de liquidação"),
      due_on: readOptionalDate(due, "A data de vencimento"),
      accrual_month: competenceFromChoice(competence),
      member_id: memberFromChoice(member),
      notes: notes.trim() || null,
      postings: buildPostings(rows),
    };
  };

  const confirm = () => {
    if (!reason.trim()) throw new DomainError("O motivo da correção é obrigatório.");
    const updated = build();
    if (sameOperation(updated, op)) throw new DomainError("Nada foi alterado.");
    ledger.validateOperation(updated);
    act((l) => l.updateOperation(updated, reason.trim()));
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Editar lançamento"
      description="Editor completo: datas, competência e cada partida. A versão anterior fica no histórico."
      confirmLabel="Salvar correção"
      onConfirm={confirm}
      size="lg"
    >
      <div className="flex flex-col gap-4">
        <TextField label="Descrição" value={description} onChange={setDescription} autoComplete="off" />
        <div className="grid grid-cols-1 gap-3 tablet:grid-cols-2 medium:grid-cols-4">
          <OptionalDateField label="Ocorrência" value={occurred} onChange={setOccurred} />
          <OptionalDateField label="Lançamento" value={booked} onChange={setBooked} />
          <OptionalDateField label="Liquidação" value={settled} onChange={setSettled} />
          <OptionalDateField label="Vencimento" value={due} onChange={setDue} />
        </div>
        <FormGrid>
          <Select label="Competência" options={competences} value={competence} onChange={setCompetence} />
          <Select label="Responsável" options={members} value={member} onChange={setMember} />
        </FormGrid>
        <TextField label="Observações" value={notes} onChange={setNotes} autoComplete="off" />

        <fieldset className="flex flex-col gap-3 rounded-lg border border-separator p-3">
          <legend className="px-1 text-body font-medium">Partidas</legend>
          <div
            aria-hidden="true"
            className="hidden grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_2rem] gap-2 px-1 text-caption font-semibold text-secondary tablet:grid"
          >
            <span>Conta</span>
            <span>Débito</span>
            <span>Crédito</span>
            <span>Integrante</span>
            <span />
          </div>
          {rows.map((row, index) => (
            <div
              key={row.key}
              className="grid grid-cols-2 gap-2 rounded-md border border-separator/60 p-2 tablet:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_2rem] tablet:border-0 tablet:p-0"
            >
              <div className="col-span-2 tablet:col-span-1">
                <Select
                  label={`Conta da partida ${index + 1}`}
                  hideLabel
                  options={accounts}
                  value={row.account}
                  placeholder="(escolha)"
                  onChange={(id) => update(row.key, { account: id })}
                />
              </div>
              <MoneyField
                label={`Débito da partida ${index + 1}`}
                hideLabel
                placeholder="Débito"
                value={row.debit}
                onChange={(text) => update(row.key, { debit: text })}
              />
              <MoneyField
                label={`Crédito da partida ${index + 1}`}
                hideLabel
                placeholder="Crédito"
                value={row.credit}
                onChange={(text) => update(row.key, { credit: text })}
              />
              <div className="col-span-2 flex items-start gap-2 tablet:col-span-2">
                <div className="min-w-0 flex-1">
                  <Select
                    label={`Integrante da partida ${index + 1}`}
                    hideLabel
                    options={postingMembers}
                    value={row.member}
                    onChange={(id) => update(row.key, { member: id })}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="md"
                  className="shrink-0"
                  aria-label={`Remover a partida ${index + 1}`}
                  title="Remover a partida"
                  disabled={rows.length <= 2}
                  onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </Button>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              size="sm"
              icon={<Plus />}
              onClick={() =>
                setRows((current) => [
                  ...current,
                  { key: ++nextKey.current, account: null, debit: "", credit: "", member: NONE },
                ])
              }
            >
              Adicionar partida
            </Button>
            <span
              className={diff !== null && diff.isZero() ? "text-caption text-positive" : "text-caption text-secondary"}
              aria-live="polite"
            >
              {balance}
            </span>
          </div>
          <Caption>O integrante de uma partida é o rateio: quem dividiu aquela parte da despesa ou da receita.</Caption>
        </fieldset>

        <TextField
          label="Motivo da correção"
          value={reason}
          onChange={setReason}
          hint={REASON_HINT}
          autoComplete="off"
          required
        />
      </div>
    </FormDialog>
  );
}
