/**
 * The destinations, in the desktop's sidebar order (ui/main_window.py `build_pages`), with the same titles
 * and sections (docs/16 §1). Alt+1…9 go to the first nine; `g` + letter goes to any of them.
 */
import {
  ArrowLeftRight,
  BookOpen,
  Bot,
  CalendarDays,
  ChartColumn,
  FileText,
  FolderInput,
  Goal,
  LayoutDashboard,
  Landmark,
  PiggyBank,
  Receipt,
  Repeat,
  Settings,
  TrendingUp,
} from "lucide-react";
import type { ReactNode } from "react";

export type SectionName = "Dia a dia" | "Cadastros" | "Acompanhamento" | "Arquivo";

export interface PageDef {
  id: string;
  path: `/${string}`;
  title: string;
  /** Sidebar group; Configurações has none (pinned at the bottom). */
  section: SectionName | null;
  icon: ReactNode;
  /** Label in the phone's bottom bar, when shorter than the title. */
  short?: string;
  /** Letter of the `g` sequence. */
  letter: string;
  /** May show an attention count (desktop COUNTED). */
  counted?: boolean;
  /** What the screen is for (help and empty state). */
  about: string;
  /** Phase that brings the screen (docs/18 §7). */
  phase: string;
}

export const PAGES: readonly PageDef[] = [
  {
    id: "visao-geral",
    path: "/visao-geral",
    title: "Visão geral",
    section: "Dia a dia",
    icon: <LayoutDashboard />,
    letter: "v",
    counted: true,
    about:
      "O mês num relance: o que pede atenção, caixa, resultado por competência, patrimônio, indicadores e o mês a mês. Cada aviso leva ao ponto onde se resolve.",
    phase: "W8",
  },
  {
    id: "orcamento",
    path: "/orcamento",
    title: "Orçamento",
    section: "Dia a dia",
    icon: <PiggyBank />,
    letter: "o",
    about: "O plano de cada categoria no mês, o gasto até agora e a comparação com os meses anteriores.",
    phase: "W8",
  },
  {
    id: "calendario",
    path: "/calendario",
    title: "Calendário",
    section: "Dia a dia",
    icon: <CalendarDays />,
    letter: "c",
    about:
      "Faturas, contas recorrentes e parcelas do mês, dia a dia, com a situação de cada uma e o caminho para pagar ou vincular.",
    phase: "W8",
  },
  {
    id: "livro",
    path: "/livro",
    title: "Livro financeiro",
    short: "Livro",
    section: "Dia a dia",
    icon: <BookOpen />,
    letter: "l",
    about:
      "Todos os lançamentos, com filtros, o inspetor ao lado, correções que ficam no histórico, rateio, marcadores e exportação.",
    phase: "W8",
  },
  {
    id: "importar",
    path: "/importar",
    title: "Importar e revisar",
    short: "Importar",
    section: "Dia a dia",
    icon: <FolderInput />,
    letter: "i",
    counted: true,
    about:
      "Extratos e faturas em PDF, CSV ou OFX: a leitura acontece neste aparelho, você confere cada item ao lado do original e aprova.",
    phase: "W11",
  },
  {
    id: "contas",
    path: "/contas",
    title: "Contas e cartões",
    short: "Contas",
    section: "Cadastros",
    icon: <Landmark />,
    letter: "a",
    about: "Contas do livro, contas bancárias, cartões e faturas, financiamentos e regras de categoria.",
    phase: "W9",
  },
  {
    id: "recorrencias",
    path: "/recorrencias",
    title: "Recorrências",
    section: "Cadastros",
    icon: <Repeat />,
    letter: "r",
    about: "Contas fixas e assinaturas, as previsões de cada mês e o vínculo com o que foi realizado.",
    phase: "W9",
  },
  {
    id: "investimentos",
    path: "/investimentos",
    title: "Investimentos",
    section: "Acompanhamento",
    icon: <TrendingUp />,
    letter: "n",
    about:
      "Posições, avaliações, aportes e resgates, rentabilidade pelo método que os dados permitem e o simulador de resgate.",
    phase: "W10",
  },
  {
    id: "relatorios",
    path: "/relatorios",
    title: "Relatórios",
    section: "Acompanhamento",
    icon: <ChartColumn />,
    letter: "e",
    about:
      "Cada gráfico com a tabela dos mesmos valores, filtros por conta, integrante e categoria, e os relatórios em PDF.",
    phase: "W10",
  },
  {
    id: "assistente",
    path: "/assistente",
    title: "Assistente",
    section: "Acompanhamento",
    icon: <Bot />,
    letter: "s",
    about:
      "A IA local responde perguntas sobre o projeto com as ferramentas do aplicativo. Toda alteração que ela propõe espera a sua aprovação.",
    phase: "W11",
  },
  {
    id: "metas",
    path: "/metas",
    title: "Metas",
    section: "Acompanhamento",
    icon: <Goal />,
    letter: "m",
    about: "Metas de patrimônio ou de saldo, o progresso, quanto falta por mês e o ritmo recente.",
    phase: "W9",
  },
  {
    id: "reembolsos",
    path: "/reembolsos",
    title: "Reembolsos e acertos",
    section: "Acompanhamento",
    icon: <ArrowLeftRight />,
    letter: "b",
    about: "Reembolsos a receber e quem deve a quem entre os integrantes, com os acertos registrados.",
    phase: "W9",
  },
  {
    id: "imposto",
    path: "/imposto-de-renda",
    title: "Imposto de renda",
    section: "Acompanhamento",
    icon: <Receipt />,
    letter: "p",
    about:
      "O ano organizado como as fichas da declaração, como material de apoio: alíquotas, tabelas e classificações são informadas por você.",
    phase: "W10",
  },
  {
    id: "documentos",
    path: "/documentos",
    title: "Documentos",
    section: "Arquivo",
    icon: <FileText />,
    letter: "d",
    about: "Os PDFs e comprovantes guardados cifrados no projeto, abertos só quando você pede.",
    phase: "W9",
  },
  {
    id: "configuracoes",
    path: "/configuracoes",
    title: "Configurações",
    section: null,
    icon: <Settings />,
    letter: "f",
    about:
      "O projeto (vale na hora para todos), a IA local, a segurança (senha, bloqueio, chave de recuperação), o backup e a privacidade deste aparelho.",
    phase: "W11",
  },
];

export const SECTIONS: readonly SectionName[] = ["Dia a dia", "Cadastros", "Acompanhamento", "Arquivo"];

/** The four destinations of the phone's bottom bar; everything else is under "Mais". */
export const BOTTOM_NAV: readonly string[] = ["visao-geral", "livro", "importar", "contas"];

export function pageById(id: string): PageDef | undefined {
  return PAGES.find((page) => page.id === id);
}

export function pageByPath(path: string): PageDef | undefined {
  return PAGES.find((page) => page.path === path);
}

/** "Alt+1" for the first nine destinations. */
export function shortcutOf(page: PageDef): string | undefined {
  const index = PAGES.indexOf(page);
  return index >= 0 && index < 9 ? `Alt+${index + 1}` : undefined;
}
