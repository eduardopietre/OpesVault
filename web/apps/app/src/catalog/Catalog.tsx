/**
 * The component catalog (development and e2e builds only): every component of @opesvault/ui in its
 * states, in light and dark, so the screenshots of each band show the whole design system (docs/18 W7).
 */
import {
  Adaptive,
  Badge,
  BottomNav,
  Button,
  ChartPanel,
  Checkbox,
  Collapsible,
  Combobox,
  CommandPalette,
  DataTable,
  DateField,
  Dialog,
  ElidedText,
  EmptyState,
  Figure,
  IconButton,
  Inspector,
  LockScreen,
  MenuButton,
  MoneyField,
  MonthPicker,
  NumberTicker,
  PageHeader,
  RadioGroup,
  Section,
  Select,
  Sheet,
  Sidebar,
  Skeleton,
  StatusPill,
  Switch,
  Tabs,
  TextField,
  confirm,
  decide,
  formatDecimalBR,
  fromScaled,
  notify,
  type ChartData,
  type DataColumn,
  type Month,
  type NavGroup,
  type SyncState,
} from "@opesvault/ui";
import { Link } from "@tanstack/react-router";
import {
  BookOpen,
  Download,
  FolderInput,
  Inbox,
  LayoutDashboard,
  Landmark,
  Pencil,
  PiggyBank,
  Plus,
  Settings,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { PAGES } from "../pages.tsx";
import { Wordmark } from "../shell/Logo.tsx";
import { THEME_LABELS, useTheme } from "../theme.tsx";

/** Deterministic pseudo-random integers (no float reaches a money value). */
function sequence(seed: number) {
  let state = seed;
  return (max: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return (state >> 16) % max;
  };
}

interface Entry {
  id: string;
  date: string;
  description: string;
  account: string;
  category: string;
  amount: string;
}

const DESCRIPTIONS = [
  "Supermercado Bom Preço",
  "Aluguel do apartamento",
  "Farmácia São João",
  "Posto Ipiranga",
  "Salário",
  "Conta de luz",
  "Restaurante Sabor da Terra, almoço de domingo com a família toda",
  "Assinatura de streaming",
  "Padaria",
  "Plano de saúde",
];
const ACCOUNTS = ["Conta corrente", "Cartão Visa", "Poupança", "Cartão Master"];
const CATEGORIES = ["Mercado", "Moradia", "Saúde", "Transporte", "Salário", "Contas", "Lazer", "Assinaturas"];

function entries(count: number): Entry[] {
  const next = sequence(7);
  return Array.from({ length: count }, (_, index) => {
    const description = DESCRIPTIONS[next(DESCRIPTIONS.length)]!;
    const income = description === "Salário";
    const cents = income ? 650000 + next(200000) : 1000 + next(250000);
    const day = 1 + (index % 28);
    return {
      id: `e${index}`,
      date: `${String(day).padStart(2, "0")}/${String(1 + (Math.floor(index / 28) % 12)).padStart(2, "0")}/2026`,
      description,
      account: ACCOUNTS[next(ACCOUNTS.length)]!,
      category: income ? "Salário" : CATEGORIES[next(CATEGORIES.length)]!,
      amount: fromScaled(BigInt(income ? cents : -cents), 2),
    };
  });
}

const columns: DataColumn<Entry>[] = [
  {
    id: "date",
    header: "Data",
    cell: (row) => row.date,
    sortValue: (row) => row.date.split("/").reverse().join(""),
    width: 104,
  },
  {
    id: "description",
    header: "Descrição",
    cell: (row) => row.description,
    sortValue: (row) => row.description,
    width: 200,
    grow: 3,
  },
  {
    id: "account",
    header: "Conta",
    cell: (row) => row.account,
    sortValue: (row) => row.account,
    width: 140,
    grow: 1,
    priority: 2,
  },
  {
    id: "category",
    header: "Categoria",
    cell: (row) => row.category,
    sortValue: (row) => row.category,
    width: 120,
    grow: 1,
    priority: 3,
  },
  {
    id: "amount",
    header: "Valor",
    align: "end",
    width: 128,
    cell: (row) => (
      <span className={row.amount.startsWith("-") ? "text-negative" : "text-positive"}>
        {formatDecimalBR(row.amount, { places: 2, currency: true })}
      </span>
    ),
    sortValue: (row) => BigInt(row.amount.replace(".", "")),
  },
];

const MONTHS = [
  "nov/25",
  "dez/25",
  "jan/26",
  "fev/26",
  "mar/26",
  "abr/26",
  "mai/26",
  "jun/26",
  "jul/26",
  "ago/26",
  "set/26",
  "out/26",
];

function flows(): ChartData {
  const next = sequence(11);
  return {
    title: "Entradas e saídas",
    categories: MONTHS,
    unit: "money",
    flow: true,
    series: [
      { id: "in", name: "Entradas", values: MONTHS.map(() => fromScaled(BigInt(900000 + next(150000)), 2)) },
      {
        id: "out",
        name: "Saídas",
        values: MONTHS.map((_, i) => (i === 4 ? null : fromScaled(BigInt(-(700000 + next(250000))), 2))),
      },
    ],
    note: "Março sem registros de saída: aparece como “—”, nunca como zero.",
  };
}

function loan(): ChartData {
  const balance: string[] = [];
  const interest: string[] = [];
  let left = 18000000n;
  for (let i = 0; i < 12; i++) {
    const juros = (left * 9n) / 1000n;
    interest.push(fromScaled(juros, 2));
    left -= 650000n - juros;
    balance.push(fromScaled(left, 2));
  }
  return {
    title: "Financiamento",
    categories: MONTHS,
    unit: "money",
    rightUnit: "money",
    series: [
      { id: "balance", name: "Saldo devedor", values: balance, kind: "area" },
      { id: "interest", name: "Juros da parcela", values: interest, kind: "line", axis: "right" },
    ],
    note: "Saldo devedor na escala da esquerda; juros da parcela na escala da direita.",
  };
}

const NAV: NavGroup[] = [
  {
    label: "Dia a dia",
    items: [
      { id: "a", label: "Visão geral", href: "#visao", icon: <LayoutDashboard />, count: 3 },
      { id: "b", label: "Orçamento", href: "#orcamento", icon: <PiggyBank /> },
      { id: "c", label: "Livro financeiro", href: "#livro", icon: <BookOpen /> },
      { id: "d", label: "Importar e revisar", href: "#importar", icon: <FolderInput />, count: 12 },
    ],
  },
  {
    label: "Acompanhamento",
    items: [{ id: "e", label: "Investimentos", href: "#investimentos", icon: <TrendingUp /> }],
  },
];

const OPTIONS = [
  { id: "001", label: "001 Banco do Brasil", keywords: "bb" },
  { id: "104", label: "104 Caixa Econômica Federal", keywords: "cef" },
  { id: "237", label: "237 Bradesco" },
  { id: "260", label: "260 Nu Pagamentos", description: "Nubank" },
  { id: "341", label: "341 Itaú Unibanco" },
  { id: "033", label: "033 Santander" },
];

const SYNC_STATES: SyncState[] = ["synced", "pending", "syncing", "offline", "conflict", "readonly", "locked"];

function Block({
  id,
  title,
  children,
  description,
}: {
  id: string;
  title: string;
  children: ReactNode;
  description?: string;
}) {
  return (
    <Section
      id={id}
      title={title}
      {...(description ? { description } : {})}
      className="scroll-mt-6 border-t border-separator pt-6"
    >
      {children}
    </Section>
  );
}

function Swatch({ name, variable }: { name: string; variable: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className="size-8 shrink-0 rounded-md border border-separator shadow-sm"
        style={{ background: `var(${variable})` }}
      />
      <span className="min-w-0">
        <span className="block truncate text-caption font-semibold">{name}</span>
        <span className="block truncate text-caption text-secondary">{variable}</span>
      </span>
    </div>
  );
}

const SWATCHES: [string, string][] = [
  ["Janela", "--ov-window"],
  ["Conteúdo", "--ov-content"],
  ["Elevado", "--ov-raised"],
  ["Afundado", "--ov-sunken"],
  ["Separador", "--ov-separator"],
  ["Texto", "--ov-text"],
  ["Secundário", "--ov-secondary"],
  ["Terciário", "--ov-tertiary"],
  ["Destaque", "--ov-accent"],
  ["Destaque (fundo)", "--ov-accent-fill"],
  ["Destaque suave", "--ov-accent-soft"],
  ["Seleção", "--ov-selection"],
  ["Positivo", "--ov-positive"],
  ["Negativo", "--ov-negative"],
  ["Alerta", "--ov-warning"],
  ["Série 1", "--ov-chart-1"],
  ["Série 2", "--ov-chart-2"],
  ["Série 3", "--ov-chart-3"],
  ["Série 4", "--ov-chart-4"],
  ["Série 5", "--ov-chart-5"],
  ["Série 6", "--ov-chart-6"],
];

export function Catalog() {
  const { theme, setTheme } = useTheme();
  const [month, setMonth] = useState<Month>({ year: 2026, month: 10 });
  const [text, setText] = useState("Mercado do mês");
  const [money, setMoney] = useState("1.234,56");
  const [badMoney, setBadMoney] = useState("12,345");
  const [date, setDate] = useState("05/10/2026");
  const [bank, setBank] = useState<string | null>("341");
  const [kind, setKind] = useState<string | null>(null);
  const [checked, setChecked] = useState(true);
  const [toggle, setToggle] = useState(true);
  const [regime, setRegime] = useState("competencia");
  const [tab, setTab] = useState("contas");
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [palette, setPalette] = useState(false);
  // Open from the start only where it is a side column (on medium screens it would be a sheet over the page).
  const [inspector, setInspector] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1440);
  const [selected, setSelected] = useState<string | null>("e3");
  const [cardSelected, setCardSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const rows = useMemo(() => entries(2000), []);
  const flowChart = useMemo(() => flows(), []);
  const loanChart = useMemo(() => loan(), []);
  const selectedRow = rows.find((row) => row.id === selected);

  return (
    <div className="min-h-dvh bg-content">
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-separator bg-window/95 px-4 py-3 backdrop-blur tablet:px-6">
        <Wordmark />
        <span className="text-body text-secondary">Catálogo de componentes</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <MenuButton
            label={`Aparência: ${THEME_LABELS[theme]}`}
            items={[
              {
                kind: "radio",
                id: "theme",
                label: "Aparência",
                value: theme,
                options: (Object.keys(THEME_LABELS) as (keyof typeof THEME_LABELS)[]).map((value) => ({
                  value,
                  label: THEME_LABELS[value],
                })),
                onChange: (value) => setTheme(value as keyof typeof THEME_LABELS),
              },
            ]}
          />
          <Link to="/" className="rounded-md px-2 py-1 text-body font-semibold text-accent hover:bg-hover">
            Voltar ao app
          </Link>
        </div>
      </header>
      <main className="mx-auto flex max-w-[1680px] flex-col gap-10 px-4 py-8 tablet:px-6 wide:px-8">
        <PageHeader
          title="Sistema visual"
          context="Tokens, componentes e estados, em claro e escuro"
          actions={
            <MenuButton
              label="Mais"
              items={[
                {
                  id: "export",
                  label: "Exportar valores…",
                  icon: <Download className="size-4" />,
                  onSelect: () => notify("Exportação de exemplo."),
                },
                {
                  id: "edit",
                  label: "Editar",
                  shortcut: "Enter",
                  icon: <Pencil className="size-4" />,
                  onSelect: () => notify("Editar."),
                },
                { kind: "separator", id: "s" },
                {
                  id: "delete",
                  label: "Excluir…",
                  danger: true,
                  icon: <Trash2 className="size-4" />,
                  onSelect: () => notify("Excluir."),
                },
              ]}
            />
          }
          primary={
            <Button
              variant="primary"
              icon={<Plus className="size-4" />}
              onClick={() => notify("Ação primária.", { tone: "positive" })}
            >
              Novo lançamento
            </Button>
          }
        >
          <MonthPicker value={month} onChange={setMonth} />
        </PageHeader>

        <Block
          id="tokens"
          title="Cores"
          description="Tokens semânticos; o tema segue o sistema ou a escolha do usuário."
        >
          <div className="grid grid-cols-2 gap-3 tablet:grid-cols-4 medium:grid-cols-6 wide:grid-cols-7">
            {SWATCHES.map(([name, variable]) => (
              <Swatch key={variable} name={name} variable={variable} />
            ))}
          </div>
        </Block>

        <Block id="tipografia" title="Tipografia e espaçamento">
          <Adaptive at={720} columns="1fr 1fr">
            <div className="flex flex-col gap-2">
              <span className="text-title font-semibold">Título da página · 22 px</span>
              <span className="text-headline font-semibold">Título de seção · 16 px</span>
              <span className="text-body">Corpo, navegação e tabelas · 14 px</span>
              <span className="text-body text-secondary">Texto secundário: contexto e rótulos</span>
              <span className="text-caption text-secondary">Legenda · 12 px</span>
              <span className="text-figure font-semibold">R$ 12.345,67</span>
            </div>
            <div className="flex flex-col gap-3">
              {[4, 8, 12, 16, 24, 32].map((size) => (
                <div key={size} className="flex items-center gap-3 text-caption text-secondary">
                  <span className="w-10 text-right">{size} px</span>
                  <span className="h-3 rounded-sm bg-accent-fill" style={{ width: size * 4 }} />
                </div>
              ))}
              <div className="mt-2 flex flex-wrap gap-3">
                {["shadow-sm", "shadow-md", "shadow-lg"].map((shadow) => (
                  <div
                    key={shadow}
                    className={`grid h-16 w-28 place-items-center rounded-lg bg-raised text-caption text-secondary ${shadow}`}
                  >
                    {shadow.replace("shadow-", "elevação ")}
                  </div>
                ))}
              </div>
            </div>
          </Adaptive>
        </Block>

        <Block
          id="botoes"
          title="Botões"
          description="Uma ação primária por tela; destrutivas em vermelho dessaturado; ícones sempre com nome."
        >
          <div className="flex flex-col gap-4">
            {(["primary", "secondary", "ghost", "danger"] as const).map((variant) => (
              <div key={variant} className="flex flex-wrap items-center gap-2">
                <Button variant={variant} size="sm">
                  Pequeno
                </Button>
                <Button variant={variant}>Padrão</Button>
                <Button variant={variant} size="lg">
                  Grande
                </Button>
                <Button variant={variant} icon={<Plus className="size-4" />}>
                  Com ícone
                </Button>
                <Button variant={variant} disabled>
                  Desabilitado
                </Button>
                <Button variant={variant} busy>
                  Salvando
                </Button>
                <IconButton
                  variant={variant === "primary" ? "primary" : variant}
                  label="Configurações"
                  icon={<Settings />}
                />
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Button tone="positive">Aprovar prontos</Button>
              <Button tone="warning" variant="ghost">
                Rever depois
              </Button>
              <Button tone="negative" variant="ghost">
                Recusar
              </Button>
            </div>
          </div>
        </Block>

        <Block id="estado" title="Estado, contagens e números">
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap gap-2">
              {SYNC_STATES.map((state) => (
                <StatusPill key={state} state={state} />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge label="3 itens pedem atenção">{3}</Badge>
              <Badge tone="accent" label="12 novos">
                {12}
              </Badge>
              <Badge tone="positive">Aprovado</Badge>
              <Badge tone="warning">Vence hoje</Badge>
              <Badge tone="negative">Atrasado</Badge>
              <Badge label="1200 itens">{1200}</Badge>
            </div>
            <div className="grid grid-cols-1 gap-6 tablet:grid-cols-3" key={tick}>
              <Figure
                label="Caixa"
                value={
                  <NumberTicker value="18432.17" format={(v) => formatDecimalBR(v, { places: 2, currency: true })} />
                }
              />
              <Figure
                label="Resultado do mês"
                tone="negative"
                value={
                  <NumberTicker value="-1250.40" format={(v) => formatDecimalBR(v, { places: 2, currency: true })} />
                }
                note="Despesas acima das receitas"
              />
              <Figure label="Patrimônio" value="—" note="Avaliação de 2 investimentos ausente" />
            </div>
            <div>
              <Button size="sm" onClick={() => setTick(tick + 1)}>
                Animar os números de novo
              </Button>
            </div>
            <div className="grid max-w-[480px] gap-3" aria-busy="true">
              <span className="sr-only">Carregando exemplo</span>
              <Skeleton className="h-6 w-40" />
              <Skeleton lines={3} />
            </div>
            <div className="max-w-[260px] rounded-md border border-separator p-2">
              <ElidedText className="text-body font-semibold">
                Projeto com um nome realmente comprido demais para caber aqui
              </ElidedText>
            </div>
          </div>
        </Block>

        <Block id="campos" title="Campos" description="Rótulo sempre visível; erro em texto, dentro do formulário.">
          <div className="grid grid-cols-1 gap-5 tablet:grid-cols-2 medium:grid-cols-3">
            <TextField label="Descrição" value={text} onChange={setText} hint="Como aparece no extrato." />
            <TextField label="Com erro" value="" onChange={() => undefined} error="Preencha a descrição." />
            <TextField label="Desabilitado" value="Somente leitura" onChange={() => undefined} disabled />
            <MoneyField label="Valor" value={money} onChange={setMoney} hint="Formato 1.234,56" />
            <MoneyField
              label="Valor inválido"
              value={badMoney}
              onChange={setBadMoney}
              error={badMoney ? "Valor inválido. Use o formato 1.234,56." : null}
            />
            <DateField label="Data" value={date} onChange={setDate} />
            <Combobox
              label="Banco"
              options={OPTIONS}
              value={bank}
              onChange={setBank}
              hint="Digite o código ou parte do nome."
            />
            <Select
              label="Tipo de conta"
              options={[
                { id: "corrente", label: "Conta corrente" },
                { id: "poupanca", label: "Poupança" },
                { id: "investimentos", label: "Investimentos", description: "Corretora ou banco" },
              ]}
              value={kind}
              onChange={setKind}
            />
            <div className="flex flex-col gap-3">
              <Checkbox
                label="Despesa dedutível"
                checked={checked}
                onCheckedChange={setChecked}
                description="Entra no relatório do imposto."
              />
              <Checkbox label="Parcialmente marcado" checked="indeterminate" onCheckedChange={() => undefined} />
              <Checkbox label="Desabilitado" checked={false} onCheckedChange={() => undefined} disabled />
            </div>
            <Switch
              label="IA local"
              description="Sugestões do Ollama deste computador."
              checked={toggle}
              onCheckedChange={setToggle}
            />
            <RadioGroup
              label="Regime"
              value={regime}
              onValueChange={setRegime}
              options={[
                { value: "competencia", label: "Competência", description: "Pelo mês a que a despesa se refere" },
                { value: "caixa", label: "Caixa", description: "Pelo dia em que o dinheiro saiu" },
              ]}
            />
          </div>
        </Block>

        <Block id="secoes" title="Seções, estado vazio e arranjo adaptável">
          <div className="flex flex-col gap-8">
            <Adaptive at={1000} columns="2fr 1fr">
              <Section
                title="Contas"
                description="Saldos no fim do mês."
                level={3}
                actions={
                  <Button size="sm" variant="ghost">
                    Ver no Livro
                  </Button>
                }
              >
                <p className="text-body text-secondary">
                  Lado a lado a partir de 1000 px do contêiner; empilhado abaixo disso.
                </p>
              </Section>
              <Collapsible title="Atenção" level={3} actions={<Badge label="2 avisos">{2}</Badge>}>
                <p className="text-body text-secondary">O título é o botão; as ações somem quando recolhida.</p>
              </Collapsible>
            </Adaptive>
            <div className="rounded-xl border border-dashed border-separator-strong">
              <EmptyState
                icon={<Inbox />}
                title="Nenhum documento importado"
                description="Arraste extratos e faturas para esta tela, ou escolha os arquivos. Nada sai deste navegador."
                actions={<Button variant="primary">Importar arquivos…</Button>}
                level={3}
              />
            </div>
          </div>
        </Block>

        <Block
          id="abas"
          title="Abas"
          description="Só para objetos diferentes; nunca para o gráfico e a tabela dos mesmos valores."
        >
          <Tabs
            label="Cadastros"
            value={tab}
            onValueChange={setTab}
            tabs={[
              { id: "contas", label: "Contas", content: <p className="text-body text-secondary">Contas do livro.</p> },
              {
                id: "cartoes",
                label: "Cartões",
                count: 2,
                content: <p className="text-body text-secondary">Cartões e titulares.</p>,
              },
              {
                id: "faturas",
                label: "Faturas",
                content: <p className="text-body text-secondary">Faturas por mês.</p>,
              },
              {
                id: "regras",
                label: "Regras",
                content: <p className="text-body text-secondary">Regras de categoria.</p>,
              },
            ]}
          />
        </Block>

        <Block
          id="graficos"
          title="Gráfico e tabela"
          description="Os mesmos valores, juntos e recolhíveis; um ponto escolhido aparece nos dois."
        >
          <div className="flex flex-col gap-10">
            <ChartPanel chart={flowChart} />
            <ChartPanel chart={loanChart} />
          </div>
        </Block>

        <Block
          id="tabela"
          title="Tabela de trabalho"
          description="2.000 linhas virtualizadas, cabeçalho fixo, ordenação, colunas por prioridade e seleção pelo id."
        >
          <div className="flex min-h-0 gap-0 overflow-hidden rounded-lg">
            <div className="min-w-0 flex-1">
              <DataTable
                label="Lançamentos de exemplo"
                rows={rows}
                columns={columns}
                getRowId={(row) => row.id}
                selectedId={selected}
                onSelect={(id) => {
                  setSelected(id);
                  setInspector(true);
                }}
                onActivate={(id) => notify(`Abrir ${id}.`)}
                height="420px"
              />
            </div>
            <Inspector open={inspector && Boolean(selectedRow)} onOpenChange={setInspector} title="Lançamento">
              {selectedRow ? (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-body">
                  <dt className="text-secondary">Descrição</dt>
                  <dd className="min-w-0 break-words">{selectedRow.description}</dd>
                  <dt className="text-secondary">Data</dt>
                  <dd>{selectedRow.date}</dd>
                  <dt className="text-secondary">Conta</dt>
                  <dd>{selectedRow.account}</dd>
                  <dt className="text-secondary">Valor</dt>
                  <dd>{formatDecimalBR(selectedRow.amount, { places: 2, currency: true })}</dd>
                </dl>
              ) : null}
            </Inspector>
          </div>
          <h3 className="mt-6 mb-2 text-body font-semibold">Como lista de cartões (abaixo de 640 px)</h3>
          <DataTable
            label="Lançamentos em cartões"
            rows={rows.slice(0, 40)}
            columns={columns}
            getRowId={(row) => row.id}
            selectedId={cardSelected}
            onSelect={setCardSelected}
            layout="cards"
            height="320px"
          />
        </Block>

        <Block id="sobreposicoes" title="Diálogos, decisões, avisos e paleta">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setDialog(true)}>Abrir diálogo</Button>
            <Button
              onClick={() =>
                void confirm({
                  title: "Excluir este lançamento?",
                  text: "Ele sai do Livro e a versão anterior fica no histórico.",
                  confirmLabel: "Excluir lançamento",
                  danger: true,
                }).then((yes) => notify(yes ? "Lançamento excluído." : "Nada foi excluído."))
              }
            >
              Confirmar exclusão
            </Button>
            <Button
              onClick={() =>
                void decide({
                  title: "Há alterações ainda não enviadas. Sair mesmo assim?",
                  text: "Elas ficam cifradas neste aparelho e sobem na próxima vez que o projeto abrir com conexão.",
                  choices: [{ id: "leave", label: "Sair e enviar depois", variant: "primary" }],
                }).then((choice) => notify(choice ? "Saiu." : "Ficou."))
              }
            >
              Decidir
            </Button>
            <Button onClick={() => setSheet(true)}>Abrir painel lateral</Button>
            <Button onClick={() => setPalette(true)}>Paleta de comandos</Button>
            <Button onClick={() => notify("Lançamento corrigido. A versão anterior ficou no histórico.")}>Aviso</Button>
            <Button onClick={() => notify("Importação aprovada.", { tone: "positive" })}>Aviso positivo</Button>
            <Button onClick={() => notify("Fatura vence amanhã.", { tone: "warning" })}>Aviso de alerta</Button>
            <Button
              onClick={() =>
                notify("Lançamento excluído.", {
                  tone: "negative",
                  action: { label: "Desfazer", run: () => notify("Desfeito.") },
                })
              }
            >
              Aviso com ação
            </Button>
          </div>
          <Dialog
            open={dialog}
            onOpenChange={setDialog}
            title="Nova conta"
            description="Contas do livro guardam saldos; a conta bancária fica em Contas bancárias."
            onSubmit={() => {
              setDialog(false);
              notify("Conta criada.", { tone: "positive" });
            }}
            footer={
              <>
                <Button onClick={() => setDialog(false)}>Cancelar</Button>
                <Button type="submit" variant="primary">
                  Criar conta
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-4">
              <TextField label="Nome" value={text} onChange={setText} autoFocus />
              <MoneyField label="Saldo inicial" value={money} onChange={setMoney} />
            </div>
          </Dialog>
          <Sheet open={sheet} onOpenChange={setSheet} title="Detalhes">
            <p className="px-4 text-body text-secondary">
              Painel deslizante: o inspetor em telas médias, a gaveta e o “Mais” do celular.
            </p>
          </Sheet>
          <CommandPalette
            open={palette}
            onOpenChange={setPalette}
            commands={PAGES.map((page) => ({
              id: page.id,
              label: page.title,
              group: "Ir para",
              icon: page.icon,
              shortcut: `g ${page.letter}`,
              run: () => notify(`Ir para ${page.title}.`),
            }))}
          />
        </Block>

        <Block id="navegacao" title="Navegação">
          <Adaptive at={1000} columns="1fr 1fr 2fr">
            <div className="h-[340px] overflow-hidden rounded-lg border border-separator">
              <Sidebar
                label="Barra lateral de exemplo"
                groups={NAV}
                footer={[{ id: "z", label: "Configurações", href: "#config", icon: <Settings /> }]}
                selectedId="c"
                onNavigate={(id) => notify(`Navegar: ${id}`)}
              />
            </div>
            <div className="h-[340px] w-16 overflow-hidden rounded-lg border border-separator">
              <Sidebar
                label="Barra lateral recolhida de exemplo"
                groups={NAV}
                footer={[{ id: "z", label: "Configurações", href: "#config", icon: <Settings /> }]}
                selectedId="a"
                onNavigate={(id) => notify(`Navegar: ${id}`)}
                collapsed
              />
            </div>
            <div className="flex flex-col justify-end overflow-hidden rounded-lg border border-separator">
              <BottomNav
                items={[
                  { id: "a", label: "Visão geral", href: "#visao", icon: <LayoutDashboard /> },
                  { id: "c", label: "Livro", href: "#livro", icon: <BookOpen /> },
                  { id: "d", label: "Importar", href: "#importar", icon: <FolderInput />, count: 2 },
                  { id: "f", label: "Contas", href: "#contas", icon: <Landmark /> },
                ]}
                selectedId="c"
                onNavigate={(id) => notify(`Navegar: ${id}`)}
                onMore={() => notify("Mais seções.")}
              />
            </div>
          </Adaptive>
        </Block>

        <Block id="bloqueio" title="Tela de bloqueio">
          <LockScreen
            embedded
            pendingChanges={2}
            onUnlock={async (password) => {
              if (password !== "senha-do-projeto") throw new Error("Senha do projeto incorreta.");
              notify("Desbloqueado.", { tone: "positive" });
            }}
            onSignOut={() => notify("Sair da conta.")}
          />
        </Block>
      </main>
    </div>
  );
}
