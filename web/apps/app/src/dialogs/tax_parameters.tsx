/**
 * Tabela e limites do ano (desktop `ParametersDialog`): the year's progressive table and limits, copied by the
 * person from the official source. Nothing comes filled in: the app embeds no rate, bracket or limit (docs/00
 * §5), and without them the simulation says what is missing instead of guessing.
 */
import { DomainError, Dec, MoneyError, parseBrl, tax } from "@opesvault/domain";
import { Button, IconButton, MoneyField, TextField } from "@opesvault/ui";
import { Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { Caption, FormDialog, FormGrid, FullRow, editableMoney, readMoney, useFormAct } from "./livro_form.tsx";
import { percentText, readPercent } from "./tax_fields.tsx";

interface BracketRow {
  key: number;
  upTo: string;
  rate: string;
  deduction: string;
}

const EMPTY_BRACKETS = 5;

export interface ParametersDialogProps {
  open: boolean;
  onClose: () => void;
  year: number;
  onDone?: () => void;
}

/** The typed rows as the domain's brackets; a row left entirely empty is dropped. */
export function readBrackets(rows: readonly BracketRow[]): tax.model.Bracket[] {
  const out: tax.model.Bracket[] = [];
  rows.forEach((row, index) => {
    const cells = [row.upTo, row.rate, row.deduction].map((c) => c.trim());
    if (!cells.some(Boolean)) return;
    try {
      const upTo = cells[0] ? parseBrl(cells[0]) : null;
      const rate = cells[1] ? parseBrl(cells[1].replace("%", "")).div(100) : Dec.from(0);
      const deduction = cells[2] ? parseBrl(cells[2]) : Dec.from(0);
      out.push({ up_to: upTo, rate, deduction });
    } catch (error) {
      if (error instanceof MoneyError) throw new DomainError(`Faixa ${index + 1}: use valores como 2.259,20 e 7,5.`);
      throw error;
    }
  });
  return out;
}

export function ParametersDialog({ open, onClose, year, onDone }: ParametersDialogProps) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const current = tax.records.parameters(ledger, year);
  const counter = useRef(current && current.brackets.length ? current.brackets.length : EMPTY_BRACKETS);
  const blank = (key: number): BracketRow => ({ key, upTo: "", rate: "", deduction: "" });
  const [rows, setRows] = useState<BracketRow[]>(() =>
    current && current.brackets.length
      ? current.brackets.map((b, index) => ({
          key: index,
          upTo: b.up_to !== null ? editableMoney(b.up_to) : "",
          rate: percentText(b.rate),
          deduction: editableMoney(b.deduction),
        }))
      : Array.from({ length: EMPTY_BRACKETS }, (_, index) => blank(index)),
  );
  const [simpleRate, setSimpleRate] = useState(percentText(current?.simplified_rate ?? null));
  const [simpleCap, setSimpleCap] = useState(current?.simplified_cap ? editableMoney(current.simplified_cap) : "");
  const [dependent, setDependent] = useState(
    current?.dependent_deduction ? editableMoney(current.dependent_deduction) : "",
  );
  const [education, setEducation] = useState(current?.education_cap ? editableMoney(current.education_cap) : "");
  const [pension, setPension] = useState(percentText(current?.pension_cap_rate ?? null));
  const [source, setSource] = useState(current?.source ?? "");

  const edit = (key: number, field: "upTo" | "rate" | "deduction", value: string) =>
    setRows((list) => list.map((row) => (row.key === key ? { ...row, [field]: value } : row)));

  const confirm = () => {
    const brackets = readBrackets(rows);
    const params = tax.model.TaxParametersSchema.parse({
      year,
      brackets,
      simplified_rate: readPercent(simpleRate, "Desconto simplificado"),
      simplified_cap: readMoney(simpleCap, { allowEmpty: true }),
      dependent_deduction: readMoney(dependent, { allowEmpty: true }),
      education_cap: readMoney(education, { allowEmpty: true }),
      pension_cap_rate: readPercent(pension, "Previdência privada"),
      source: source.trim() || "informado pelo usuário",
    });
    act((l) => tax.records.setParameters(l, params), "alterar parâmetros do imposto");
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Tabela e limites de ${year}`}
      size="lg"
      confirmLabel="Salvar"
      onConfirm={confirm}
    >
      <Caption>
        Nada vem preenchido: copie os valores do ano da fonte oficial (Receita Federal). Eles valem só para a simulação
        deste projeto.
      </Caption>
      <fieldset className="min-w-0">
        <legend className="mb-2 text-body font-medium text-text">Faixas da tabela anual</legend>
        <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,0.8fr)_minmax(0,1.1fr)_2rem] items-end gap-x-2 gap-y-2">
          <span className="text-caption text-secondary">Base anual até (vazio: acima)</span>
          <span className="text-caption text-secondary">Alíquota (%)</span>
          <span className="text-caption text-secondary">Parcela a deduzir</span>
          <span aria-hidden="true" />
          {rows.map((row, index) => (
            <BracketLine
              key={row.key}
              row={row}
              number={index + 1}
              onEdit={edit}
              onRemove={() => setRows((l) => l.filter((r) => r.key !== row.key))}
            />
          ))}
        </div>
        <div className="mt-2">
          <Button size="sm" icon={<Plus />} onClick={() => setRows((list) => [...list, blank(counter.current++)])}>
            Adicionar faixa
          </Button>
        </div>
      </fieldset>
      <FormGrid>
        <TextField
          label="Desconto simplificado (%)"
          value={simpleRate}
          onChange={setSimpleRate}
          inputMode="decimal"
          autoComplete="off"
          placeholder="em %"
          className="text-right tabular-nums"
        />
        <MoneyField label="Teto do desconto simplificado" value={simpleCap} onChange={setSimpleCap} placeholder="" />
        <MoneyField label="Dedução por dependente" value={dependent} onChange={setDependent} placeholder="" />
        <MoneyField label="Limite de instrução por pessoa" value={education} onChange={setEducation} placeholder="" />
        <TextField
          label="Limite da previdência privada (%)"
          value={pension}
          onChange={setPension}
          inputMode="decimal"
          autoComplete="off"
          placeholder="em %"
          className="text-right tabular-nums"
        />
        <FullRow>
          <TextField
            label="Fonte dos valores"
            value={source}
            onChange={setSource}
            maxLength={300}
            autoComplete="off"
            placeholder="de onde vieram os valores"
          />
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}

function BracketLine({
  row,
  number,
  onEdit,
  onRemove,
}: {
  row: BracketRow;
  number: number;
  onEdit: (key: number, field: "upTo" | "rate" | "deduction", value: string) => void;
  onRemove: () => void;
}) {
  return (
    <>
      <TextField
        label={`Faixa ${number}: base anual até`}
        hideLabel
        value={row.upTo}
        onChange={(v) => onEdit(row.key, "upTo", v)}
        inputMode="decimal"
        autoComplete="off"
        placeholder="acima"
        className="text-right tabular-nums"
      />
      <TextField
        label={`Faixa ${number}: alíquota (%)`}
        hideLabel
        value={row.rate}
        onChange={(v) => onEdit(row.key, "rate", v)}
        inputMode="decimal"
        autoComplete="off"
        className="text-right tabular-nums"
      />
      <TextField
        label={`Faixa ${number}: parcela a deduzir`}
        hideLabel
        value={row.deduction}
        onChange={(v) => onEdit(row.key, "deduction", v)}
        inputMode="decimal"
        autoComplete="off"
        className="text-right tabular-nums"
      />
      <IconButton label={`Remover faixa ${number}`} icon={<X />} size="sm" onClick={onRemove} />
    </>
  );
}
