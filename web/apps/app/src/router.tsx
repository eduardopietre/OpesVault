/**
 * Routes (code-based TanStack Router). Before a project is open: welcome, sign in, sign up, projects,
 * new project and the first-run assistant. With a project: the shell and one route per destination
 * (docs/18 §6). The guards read the same session store as the screens.
 */
import { DecisionHost, Toaster, loadECharts } from "@opesvault/ui";
import {
  Navigate,
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  type AnyRoute,
  type RouterHistory,
} from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import { revealSearch } from "./data/navigation.ts";
import { SHOW_CATALOG } from "./flags.ts";
import { PAGES } from "./pages.tsx";
import { annualSearch } from "./pages/relatorios/annual_search.ts";
import { taxReportSearch } from "./pages/imposto/report_search.ts";
import { reportSearch } from "./pages/visao-geral/report_search.ts";
import { SignInScreen, SignUpScreen, WelcomeScreen } from "./screens/auth.tsx";
import { PlaceholderPage } from "./screens/PlaceholderPage.tsx";
import { PrintGate } from "./shell/PrintGate.tsx";
import type { SessionStore } from "./session.tsx";

// The shell and the screens after sign-in carry the domain and the vault's dialogs: they load when first needed.
const AppShell = lazyRouteComponent(() => import("./shell/AppShell.tsx"), "AppShell");
const ProjectsScreen = lazyRouteComponent(() => import("./screens/projects.tsx"), "ProjectsScreen");
const CreateProjectScreen = lazyRouteComponent(() => import("./screens/projects.tsx"), "CreateProjectScreen");
const SetupScreen = lazyRouteComponent(() => import("./screens/projects.tsx"), "SetupScreen");

const SCREENS = import.meta.glob<{ Page: ComponentType }>("./pages/*/index.tsx");

/**
 * Starts loading the code a project needs (the shell, the projects screen, the overview and its charts, with
 * the domain and the vault they share) once someone has signed in: it arrives while the project is chosen and
 * unlocked, instead of after it.
 */
export function preloadProjectScreens(): Promise<unknown> {
  return Promise.all([
    import("./shell/AppShell.tsx"),
    import("./screens/projects.tsx"),
    SCREENS["./pages/visao-geral/index.tsx"]?.(),
    loadECharts(),
  ]);
}

/** A print view behind the lock screen (it lives outside the shell). */
function gated(View: ComponentType): () => ReactNode {
  return function Gated() {
    return (
      <PrintGate>
        <View />
      </PrintGate>
    );
  };
}

export interface RouterContext {
  session: SessionStore;
}

export function createAppRouter({
  session,
  history,
  extras,
}: {
  session: SessionStore;
  history?: RouterHistory;
  /** Rendered once next to the routes (the PWA update prompt). */
  extras?: ReactNode;
}) {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: () => (
      <>
        <Outlet />
        <Toaster />
        <DecisionHost />
        {extras}
      </>
    ),
  });

  const home = (context: RouterContext) => {
    const state = context.session.get();
    if (!state.account) return "/boas-vindas";
    if (state.open || state.locked) return "/visao-geral";
    return "/projetos";
  };

  const signedOut = ({ context }: { context: RouterContext }) => {
    if (context.session.get().account) throw redirect({ to: home(context) });
  };
  const signedIn = ({ context }: { context: RouterContext }) => {
    if (!context.session.get().account) throw redirect({ to: "/entrar" });
  };
  const projectOpen = ({ context }: { context: RouterContext }) => {
    const state = context.session.get();
    if (!state.account) throw redirect({ to: "/entrar" });
    if (!state.open && !state.locked) throw redirect({ to: "/projetos" });
  };

  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    beforeLoad: ({ context }) => {
      throw redirect({ to: home(context) });
    },
  });
  const welcome = createRoute({
    getParentRoute: () => rootRoute,
    path: "/boas-vindas",
    beforeLoad: signedOut,
    component: WelcomeScreen,
  });
  const signIn = createRoute({
    getParentRoute: () => rootRoute,
    path: "/entrar",
    beforeLoad: signedOut,
    component: SignInScreen,
  });
  const signUp = createRoute({
    getParentRoute: () => rootRoute,
    path: "/criar-conta",
    beforeLoad: signedOut,
    component: SignUpScreen,
  });
  const projects = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projetos",
    beforeLoad: signedIn,
    component: ProjectsScreen,
  });
  const newProject = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projetos/novo",
    beforeLoad: signedIn,
    component: CreateProjectScreen,
  });
  const setup = createRoute({
    getParentRoute: () => rootRoute,
    path: "/comecar",
    beforeLoad: projectOpen,
    component: gated(() => <SetupScreen />),
  });

  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: "shell",
    beforeLoad: projectOpen,
    component: AppShell,
  });
  // Each screen lives in pages/<page id>/index.tsx and exports `Page`; it is loaded when first visited.
  // A destination without its folder yet shows the placeholder.
  const pages: AnyRoute[] = PAGES.map((page) => {
    const load = SCREENS[`./pages/${page.id}/index.tsx`];
    return createRoute({
      getParentRoute: () => shell,
      path: page.path,
      validateSearch: revealSearch,
      component: load ? lazyRouteComponent(load, "Page") : () => <PlaceholderPage page={page} />,
    });
  });

  // The month's report as a print view, outside the shell (Visão geral › Mais › Relatório do mês em PDF).
  const monthlyReport = createRoute({
    getParentRoute: () => rootRoute,
    path: "/imprimir/relatorio-mensal",
    beforeLoad: projectOpen,
    validateSearch: reportSearch,
    component: gated(lazyRouteComponent(() => import("./pages/visao-geral/report_page.tsx"), "MonthlyReportPage")),
  });

  // The year-end closing as a print view (Relatórios › Fechamento do ano › Relatório anual (PDF)…).
  const annualReport = createRoute({
    getParentRoute: () => rootRoute,
    path: "/imprimir/relatorio-anual",
    beforeLoad: projectOpen,
    validateSearch: annualSearch,
    component: gated(lazyRouteComponent(() => import("./pages/relatorios/annual_page.tsx"), "AnnualReportPage")),
  });

  // The report for the income tax return, the same way (Imposto de renda › Mais › Relatório para a declaração).
  const taxReport = createRoute({
    getParentRoute: () => rootRoute,
    path: "/imprimir/imposto",
    beforeLoad: projectOpen,
    validateSearch: taxReportSearch,
    component: gated(lazyRouteComponent(() => import("./pages/imposto/report_page.tsx"), "TaxReportPage")),
  });

  const children: AnyRoute[] = [
    index,
    welcome,
    signIn,
    signUp,
    projects,
    newProject,
    setup,
    monthlyReport,
    annualReport,
    taxReport,
    shell.addChildren(pages),
  ];
  if (SHOW_CATALOG) {
    children.push(
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/catalogo",
        component: lazyRouteComponent(() => import("./catalog/Catalog.tsx"), "Catalog"),
      }),
    );
  }

  const routeTree = rootRoute.addChildren(children);
  return createRouter({
    routeTree,
    context: { session },
    ...(history ? { history } : {}),
    defaultNotFoundComponent: () => <Navigate to="/" replace />,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
