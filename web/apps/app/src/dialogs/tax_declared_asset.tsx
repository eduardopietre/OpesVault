/**
 * Bem (desktop `DeclaredAssetDialog`): a good that is not an account (a house, a car), declared at acquisition
 * cost. Nothing is guessed: the group and the code come from the IRPF table, chosen by the person.
 */
import { DomainError, tax, type Id } from "@opesvault/domain";
import { DateField, MoneyField, Select, TextField } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import {
  Caption,
  FormDialog,
  FormGrid,
  FullRow,
  NONE,
  OptionalDateField,
  memberFromChoice,
  memberOptions,
  optionalDateValue,
  readOptionalDate,
  useFormAct,
} from "./livro_form.tsx";
import { AssetCodeField, splitCode } from "./tax_fields.tsx";
import { dateText, editableMoney, readDate, readMoney } from "./form_readers.ts";

/** House, car, other real estate and the like: the groups a good outside the accounts can be in. */
const GROUPS = ["01", "02", "03", "05", "99"] as const;

export interface DeclaredAssetDialogProps {
  open: boolean;
  onClose: () => void;
  /** The good being edited; none for a new one. */
  assetId?: Id | null;
  onDone?: (created: boolean) => void;
}

export function DeclaredAssetDialog({ open, onClose, assetId = null, onDone }: DeclaredAssetDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const asset = assetId ? (tax.records.declaredAssets(ledger).get(assetId) ?? null) : null;
  const owners = useMemo(() => memberOptions(ledger, asset?.owner_id ?? null), [ledger, asset]);
  const [name, setName] = useState(asset?.name ?? "");
  const [kind, setKind] = useState<string | null>(asset ? `${asset.group}.${asset.code}` : null);
  const [description, setDescription] = useState(asset?.description ?? "");
  const [owner, setOwner] = useState<string>(asset?.owner_id ?? NONE);
  const [acquired, setAcquired] = useState(dateText(asset?.acquired_on ?? workspace.today()));
  const [cost, setCost] = useState(asset ? editableMoney(asset.cost) : "");
  const [sold, setSold] = useState(optionalDateValue(asset?.sold_on ?? null));
  const [sale, setSale] = useState(asset?.sale_value ? editableMoney(asset.sale_value) : "");

  const confirm = () => {
    const title = name.trim();
    if (!title) throw new DomainError("Informe o nome do bem.");
    if (kind === null) throw new DomainError("Escolha o grupo e o código na tabela do IRPF.");
    const [group, code] = splitCode(kind);
    const fields = {
      name: title,
      group,
      code,
      description: description.split(/\s+/).filter(Boolean).join(" "),
      owner_id: memberFromChoice(owner),
      acquired_on: readDate(acquired, "A data de aquisição"),
      cost: readMoney(cost),
      sold_on: readOptionalDate(sold, "A data de venda"),
      sale_value: readMoney(sale, { allowEmpty: true }),
    };
    act((l) =>
      tax.records.saveDeclaredAsset(
        l,
        asset === null ? tax.model.DeclaredAssetSchema.parse(fields) : { ...asset, ...fields },
      ),
    );
    onDone?.(asset === null);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={asset ? "Bem" : "Novo bem"}
      size="lg"
      confirmLabel="Salvar"
      onConfirm={confirm}
    >
      <FormGrid>
        <FullRow>
          <TextField
            label="Nome do bem"
            value={name}
            onChange={setName}
            maxLength={120}
            autoComplete="off"
            data-autofocus=""
            required
          />
        </FullRow>
        <FullRow>
          <AssetCodeField label="Tipo (grupo e código do IRPF)" value={kind} onChange={setKind} groups={GROUPS} />
        </FullRow>
        <FullRow>
          <TextField
            label="Discriminação"
            value={description}
            onChange={setDescription}
            maxLength={512}
            placeholder="endereço, matrícula, placa, de quem foi comprado…"
            autoComplete="off"
          />
        </FullRow>
        <Select label="Dono" options={owners} value={owner} onChange={setOwner} />
        <DateField label="Data de aquisição" value={acquired} onChange={setAcquired} />
        <MoneyField label="Custo de aquisição" value={cost} onChange={setCost} />
        <OptionalDateField label="Data de venda" value={sold} onChange={setSold} />
        <MoneyField label="Valor de venda" value={sale} onChange={setSale} placeholder="não vendido" />
        <FullRow>
          <Caption>
            Imóveis e veículos vão pelo custo de aquisição (com reformas somadas), não pelo valor de mercado.
          </Caption>
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}
