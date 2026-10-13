/**
 * "Parâmetros" of the Imposto de renda page: what the person informs once and the sheets read — who declares and
 * who depends on whom, the nature of each income, the year's table and limits, the rules of variable income. Each
 * says on the screen what is informed and what is missing, with the command that edits it. Nothing fiscal comes
 * with the app (docs/00 §5): a rate, bracket or limit shown here is one the person typed, with its source.
 */
import { formatDateBr, tax, type Ledger } from "@opesvault/domain";
import { Badge, Collapsible } from "@opesvault/ui";
import { EditButton } from "../../components/list_parts.tsx";
import { plural } from "../../data/text.ts";
import { useLedger } from "../../data/react.tsx";

export type ParameterId = "people" | "nature" | "params" | "rules";

export interface ParameterRow {
  id: ParameterId;
  /** The command, which is also the row's name ("Tabela e limites do ano…"). */
  command: string;
  /** What is informed, in words. */
  status: string;
  /** Something the sheets need is not informed: the results that depend on it stay unknown (—). */
  missing: boolean;
}

const BUCKETS = Object.keys(tax.model.BUCKET_LABELS) as tax.model.Bucket[];

/** The four parameters of the year, as the section shows them. */
export function parameterRows(ledger: Ledger, year: number): ParameterRow[] {
  const members = [...ledger.members.values()].filter((m) => m.active);
  const declarants = tax.records.declarants(ledger);
  const infos = [...tax.records.memberInfos(ledger).values()];
  const dependents = infos.filter((info) => info.declared_by !== null).length;
  const withoutCpf = declarants.filter((id) => !tax.records.memberInfo(ledger, id)?.cpf).length;
  const people: ParameterRow = members.length
    ? {
        id: "people",
        command: "Declarantes e dependentes…",
        status:
          `${plural(declarants.length, "declarante", "declarantes")}, ${plural(dependents, "dependente", "dependentes")}` +
          (withoutCpf ? `; falta o CPF de ${plural(withoutCpf, "declarante", "declarantes")}.` : "."),
        missing: withoutCpf > 0,
      }
    : {
        id: "people",
        command: "Declarantes e dependentes…",
        status: "Nenhum integrante cadastrado: cadastre-os em Contas e cartões.",
        missing: true,
      };

  const classified = tax.records.classifications(ledger).size;
  const nature: ParameterRow = {
    id: "nature",
    command: "Natureza dos rendimentos…",
    status: classified
      ? `${plural(classified, "fonte classificada", "fontes classificadas")}; as que faltam aparecem nas pendências.`
      : "Nenhuma fonte classificada: os rendimentos sem natureza aparecem nas pendências.",
    missing: false,
  };

  const table = tax.records.parameters(ledger, year);
  const params: ParameterRow =
    table && table.brackets.length
      ? {
          id: "params",
          command: "Tabela e limites do ano…",
          status: `${year}: ${plural(table.brackets.length, "faixa informada", "faixas informadas")}; fonte: ${table.source || "não informada"}.`,
          missing: false,
        }
      : {
          id: "params",
          command: "Tabela e limites do ano…",
          status: `${year}: não informados. Sem eles, a comparação entre simplificada e completa fica desconhecida (—).`,
          missing: true,
        };

  const current = tax.records.variableRules(ledger);
  const rates = current
    ? BUCKETS.filter((bucket) => (tax.model.ruleOf(current, bucket)?.rate ?? null) !== null).length
    : 0;
  const rules: ParameterRow = current
    ? {
        id: "rules",
        command: "Regras de renda variável…",
        status: `Vigentes desde ${formatDateBr(current.valid_from)}: ${rates} de ${BUCKETS.length} alíquotas informadas; fonte: ${current.source || "não informada"}.`,
        missing: rates < BUCKETS.length,
      }
    : {
        id: "rules",
        command: "Regras de renda variável…",
        status: "Não informadas. Sem as alíquotas, o imposto da renda variável fica desconhecido (—).",
        missing: true,
      };
  return [people, nature, params, rules];
}

export interface ParametersSectionProps {
  year: number;
  onEdit: (id: ParameterId) => void;
}

export function ParametersSection({ year, onEdit }: ParametersSectionProps) {
  const rows = useLedger((ledger) => parameterRows(ledger, year), year);
  const missing = rows.filter((row) => row.missing).length;
  return (
    <Collapsible
      title={missing ? `Parâmetros · ${missing} a informar` : "Parâmetros"}
      prefKey="ir/parametros"
      description="Você informa a partir das fontes oficiais; o aplicativo não traz tabela, alíquota nem limite."
    >
      <ul
        aria-label="Parâmetros do imposto"
        className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,18rem),1fr))]"
      >
        {rows.map((row) => (
          <li key={row.id} className="flex min-w-0 flex-col items-start gap-1.5 rounded-lg border border-separator p-3">
            <span className="flex flex-wrap items-center gap-2">
              <EditButton size="sm" variant="secondary" onClick={() => onEdit(row.id)}>
                {row.command}
              </EditButton>
              {row.missing ? <Badge tone="warning">A informar</Badge> : null}
            </span>
            <p className="text-caption text-secondary [overflow-wrap:anywhere]">{row.status}</p>
          </li>
        ))}
      </ul>
    </Collapsible>
  );
}
