/**
 * Investimento (desktop `InvestmentDialog`): a new investment held at a bank account, or the characteristics
 * of an existing one (IRPF type, issuer, indexer, rate, dates, liquidity, tax treatment and the code of the
 * income). Type and income follow the IRPF tables; no rate or limit is embedded (docs/00 §5).
 */
import { DomainError, catalogs, dom, formatDecimalBr, investments, tax, type Dec, type Id } from "@opesvault/domain";
import { Checkbox, Combobox, MoneyField, Select, TextField, type SelectOption } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import {
  Caption,
  FormDialog,
  FormGrid,
  FullRow,
  NONE,
  OptionalDateField,
  optionalDateValue,
  readOptionalDate,
  useFormAct,
  type OptionalDateValue,
} from "./livro_form.tsx";
import { typedPercent, readMoney } from "./form_readers.ts";

const { banking } = dom;
const { profile: prof, model } = investments;

export interface InvestmentDialogProps {
  open: boolean;
  onClose: () => void;
  /** A new investment held at this bank account (or none). */
  bankId?: Id | null;
  /** The investment whose characteristics are edited. */
  positionId?: Id | null;
  onDone?: (profile: investments.profile.InvestmentProfile, created: boolean) => void;
}

const optionsOf = (labels: Readonly<Record<string, string>>, none?: string): SelectOption[] => [
  ...(none ? [{ id: NONE, label: none }] : []),
  ...Object.entries(labels).map(([id, label]) => ({ id, label })),
];

const CLASSES = optionsOf(model.ASSET_CLASS_LABELS);
const INDEXERS = optionsOf(prof.INDEXER_LABELS, "Não informado");
const LIQUIDITIES = optionsOf(prof.LIQUIDITY_LABELS, "Não informada");
const TAXES = optionsOf(prof.TAX_LABELS, "Não informada");
const FGC: SelectOption[] = [
  { id: NONE, label: "Não informado" },
  { id: "sim", label: "Sim" },
  { id: "nao", label: "Não" },
];
const INCOME_CODES: SelectOption[] = [
  { id: NONE, label: "Não informado" },
  ...[...catalogs.irpf.EXEMPT_CODES].map(([code, text]) => ({
    id: `isento:${code}`,
    label: `Isentos ${code} — ${text}`,
  })),
  ...[...catalogs.irpf.EXCLUSIVE_CODES].map(([code, text]) => ({
    id: `exclusivo:${code}`,
    label: `Tributação exclusiva ${code} — ${text}`,
  })),
];

/** "Tipo (IRPF)" choices: the groups an investment can be in, found by code or by words. */
export function investmentKindOptions(): SelectOption[] {
  return catalogs.irpf.investmentCodes().map(([group, code, text]) => ({
    id: `${group}.${code}`,
    label: `${group}.${code} — ${text}`,
  }));
}

/** A percentage typed as "110" or "6,5"; empty is unknown. */
const readRate = (text: string): Dec | null => typedPercent(text, "Taxa: use um número como 110 ou 6,5.");

export function InvestmentDialog({ open, onClose, bankId = null, positionId = null, onDone }: InvestmentDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const current = positionId ? prof.profileOf(ledger, positionId) : null;
  const kinds = useMemo(() => investmentKindOptions(), []);
  const banks = useMemo<SelectOption[]>(
    () => [
      { id: NONE, label: "(nenhuma)" },
      ...[...banking.bankAccounts(ledger).values()]
        .filter((b) => !b.archived)
        .map((b) => ({ id: b.id, label: b.name })),
    ],
    [ledger],
  );
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string | null>(
    current?.irpf_group && current.irpf_code ? `${current.irpf_group}.${current.irpf_code}` : null,
  );
  const [assetClass, setAssetClass] = useState<string>(model.AssetClass.OTHER);
  const [bank, setBank] = useState<string>(current?.bank_account_id ?? bankId ?? NONE);
  const [value, setValue] = useState("");
  const [fromChecking, setFromChecking] = useState(true);
  const [issuer, setIssuer] = useState(current?.issuer ?? "");
  const [issuerId, setIssuerId] = useState(current?.issuer_tax_id ? tax.ids.display(current.issuer_tax_id) : "");
  const [indexer, setIndexer] = useState<string>(current?.indexer ?? NONE);
  const [rate, setRate] = useState(current?.rate ? formatDecimalBr(current.rate) : "");
  const [applied, setApplied] = useState<OptionalDateValue>(
    optionalDateValue(current ? current.applied_on : workspace.today()),
  );
  const [maturity, setMaturity] = useState<OptionalDateValue>(optionalDateValue(current?.maturity ?? null));
  const [liquidity, setLiquidity] = useState<string>(current?.liquidity ?? NONE);
  const [days, setDays] = useState(String(current?.liquidity_days ?? 0));
  const [taxTreatment, setTaxTreatment] = useState<string>(current?.tax ?? NONE);
  const [incomeCode, setIncomeCode] = useState<string>(current?.income_code ?? NONE);
  const [fgc, setFgc] = useState<string>(current?.fgc === true ? "sim" : current?.fgc === false ? "nao" : NONE);
  const [notes, setNotes] = useState(current?.notes ?? "");

  const pickKind = (id: string) => {
    setKind(id);
    const [group, code] = id.split(".") as [string, string];
    if (positionId === null) setAssetClass(prof.classFor(group, code));
    if (taxTreatment === NONE) {
      const suggested = prof.taxFor(group, code);
      if (suggested) setTaxTreatment(suggested);
    }
  };

  const confirm = () => {
    if (positionId === null && !name.trim()) throw new DomainError("Informe o nome do investimento.");
    const cost = positionId === null ? readMoney(value) : null;
    if (kind === null) throw new DomainError("Escolha o tipo do investimento na tabela do IRPF.");
    const [group, code] = kind.split(".") as [string, string];
    const rawId = issuerId.trim();
    const issuerTaxId = rawId ? tax.ids.normalize(rawId, [tax.ids.TaxIdKind.CNPJ]) : null;
    const quantity = Number(days.trim());
    if (liquidity === prof.Liquidity.DAYS && (!Number.isInteger(quantity) || quantity < 0 || quantity > 3650)) {
      throw new DomainError("Dias para o resgate: informe de 0 a 3650.");
    }
    const percent = readRate(rate);
    const appliedOn = readOptionalDate(applied, "A data da aplicação");
    const maturityOn = readOptionalDate(maturity, "O vencimento");
    const saved = act((l) => {
      let id = positionId;
      if (id === null) {
        const held = bank === NONE ? null : (banking.bankAccounts(l).get(bank) ?? null);
        const position = investments.service.createPosition(
          l,
          name.trim(),
          assetClass as investments.model.AssetClass,
          appliedOn ?? workspace.today(),
          {
            holder_id: held ? held.holder_id : null,
            initial_cost: cost,
            from_account: held && fromChecking ? held.checking_id : null,
          },
        );
        id = position.id;
      }
      return prof.saveProfile(
        l,
        prof.InvestmentProfileSchema.parse({
          position_id: id,
          bank_account_id: bank === NONE ? null : bank,
          irpf_group: group,
          irpf_code: code,
          issuer: issuer.split(/\s+/).filter(Boolean).join(" ").slice(0, 120) || null,
          issuer_tax_id: issuerTaxId,
          indexer: indexer === NONE ? null : indexer,
          rate: percent,
          applied_on: appliedOn,
          maturity: maturityOn,
          liquidity: liquidity === NONE ? null : liquidity,
          liquidity_days: liquidity === prof.Liquidity.DAYS ? quantity : null,
          tax: taxTreatment === NONE ? null : taxTreatment,
          income_code: incomeCode === NONE ? null : incomeCode,
          fgc: fgc === "sim" ? true : fgc === "nao" ? false : null,
          notes: notes.trim() || null,
        }),
      );
    });
    onDone?.(saved, positionId === null);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={positionId ? "Características do investimento" : "Novo investimento"}
      confirmLabel="Salvar"
      size="lg"
      onConfirm={confirm}
    >
      <FormGrid>
        {positionId === null ? (
          <FullRow>
            <TextField
              label="Nome do investimento"
              value={name}
              onChange={setName}
              maxLength={120}
              placeholder="ex.: CDB Banco X 2027, Tesouro IPCA+ 2035, PETR4"
              autoComplete="off"
              data-autofocus=""
              required
            />
          </FullRow>
        ) : null}
        <FullRow>
          <Combobox
            label="Tipo do investimento (IRPF)"
            options={kinds}
            value={kind}
            onChange={pickKind}
            placeholder="Escolha o tipo…"
          />
        </FullRow>
        {positionId === null ? (
          <Select label="Classe no aplicativo" options={CLASSES} value={assetClass} onChange={setAssetClass} />
        ) : null}
        <Select label="Conta bancária ou corretora" options={banks} value={bank} onChange={setBank} />
        {positionId === null ? (
          <>
            <MoneyField label="Valor aplicado" value={value} onChange={setValue} />
            <div className="flex items-end pb-1.5">
              <Checkbox
                label="O dinheiro saiu da conta corrente desta conta bancária"
                checked={fromChecking}
                onCheckedChange={setFromChecking}
              />
            </div>
          </>
        ) : null}
        <TextField
          label="Emissor"
          value={issuer}
          onChange={setIssuer}
          maxLength={120}
          placeholder="banco, empresa ou Tesouro Nacional"
          autoComplete="off"
        />
        <TextField
          label="CNPJ do emissor"
          value={issuerId}
          onChange={setIssuerId}
          placeholder="00.000.000/0000-00"
          autoComplete="off"
        />
        <Select label="Indexador" options={INDEXERS} value={indexer} onChange={setIndexer} />
        <TextField
          label="Taxa (%)"
          value={rate}
          onChange={setRate}
          inputMode="decimal"
          placeholder="ex.: 110 (% do CDI), 6,5 (IPCA +)"
          autoComplete="off"
        />
        <OptionalDateField label="Data da aplicação" value={applied} onChange={setApplied} />
        <OptionalDateField label="Vencimento" value={maturity} onChange={setMaturity} />
        <Select label="Liquidez" options={LIQUIDITIES} value={liquidity} onChange={setLiquidity} />
        <TextField
          label="Dias para o resgate (D+N)"
          value={days}
          onChange={setDays}
          type="number"
          min={0}
          max={3650}
          inputMode="numeric"
          disabled={liquidity !== prof.Liquidity.DAYS}
        />
        <FullRow>
          <Select label="Tributação" options={TAXES} value={taxTreatment} onChange={setTaxTreatment} />
        </FullRow>
        <FullRow>
          <Select
            label="Código do rendimento no IRPF"
            options={INCOME_CODES}
            value={incomeCode}
            onChange={setIncomeCode}
          />
        </FullRow>
        <Select label="Cobertura do FGC" options={FGC} value={fgc} onChange={setFgc} />
        <TextField label="Observações" value={notes} onChange={setNotes} maxLength={500} autoComplete="off" />
        <FullRow>
          <Caption>
            Tipo e rendimento seguem as tabelas do IRPF e preenchem Bens e Direitos e os rendimentos; a tributação diz
            como o imposto é cobrado, sem alíquota embutida. O valor ao longo do tempo fica nas avaliações (Valores em
            uma data).
            {positionId
              ? ""
              : " Ações e fundos negociados por quantidade são registrados em Investimentos › Negociação."}
          </Caption>
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}
