/**
 * Routes (code-based TanStack Router). Before a project is open: welcome, sign in, sign up, projects,
 * new project and the first-run assistant. With a project: the shell and one route per destination
 * (docs/18 §6). The guards read the same session store as the screens.
 */
import { DecisionHost, Toaster } from "@opesvault/ui";
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
import { SignInScreen, SignUpScreen, WelcomeScreen } from "./screens/auth.tsx";
import { PlaceholderPage } from "./screens/PlaceholderPage.tsx";
import { CreateProjectScreen, ProjectsScreen, SetupScreen } from "./screens/projects.tsx";
import type { SessionStore } from "./session.tsx";
import { AppShell } from "./shell/AppShell.tsx";

const SCREENS = import.meta.glob<{ Page: ComponentType }>("./pages/*/index.tsx");

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
    component: () => <SetupScreen />,
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

  const children: AnyRoute[] = [index, welcome, signIn, signUp, projects, newProject, setup, shell.addChildren(pages)];
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
