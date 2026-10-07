/**
 * Mounting the whole app (router, session, fake services) on one path, for the component tests. Every page's
 * harness is a thin wrapper of `mountApp`: the project to open, the viewport, the heading to wait for.
 */
import { memoryPreferences, type PreferenceStore } from "@opesvault/ui";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.tsx";
import { Workspace } from "../src/data/workspace.ts";
import { createAppRouter } from "../src/router.tsx";
import { DEMO, createFakeServices, type FakeOptions } from "../src/services/fake.ts";
import { SessionStore, sessionActions, type SessionState } from "../src/session.tsx";
import { setViewport } from "./dom.ts";

/**
 * The project the app opens on:
 * - `"demo"`: the demonstration project (Ana's "Casa");
 * - `"blank"`: the demonstration's session with an empty workspace in place of its records
 *   (`Workspace.fromRecords([])`, named "Vazio");
 * - `"new"`: a project of its own, just created by another account (Carla), with no operations at all;
 * - `"none"`: signed in, no project open (the projects screen);
 * - `"signed-out"`: nobody signed in.
 */
export type MountProject = "demo" | "blank" | "new" | "none" | "signed-out";

export interface MountOptions {
  /** `"demo"` by default. */
  project?: MountProject;
  /**
   * The workspace is read-only (another tab or device is editing it). A `"blank"` workspace is created read-only;
   * an opened one is switched with `setReadOnly(true)`.
   */
  readOnly?: boolean;
  /** Also mark the open project itself read-only (`open.readOnly`, what the sync status reads). */
  openReadOnly?: boolean;
  /** happy-dom evaluates media queries against this width (900 px tall); left as it was when absent. */
  width?: number;
  /** The level-1 heading to wait for once rendered (the page opened). */
  heading?: string;
  /** How long to wait for that heading (the default of `findBy…` otherwise). */
  headingTimeout?: number;
  preferences?: PreferenceStore;
  /** Options of `createFakeServices` besides the seed (light key derivation, the demonstration's extras). */
  services?: Omit<FakeOptions, "seed">;
  /** Runs on the project before the app shows it. */
  prepare?: (workspace: Workspace) => void;
  /** More of the session's state (sync details, pending changes) set together with the open project. */
  session?: Partial<SessionState>;
  /** Signs in and opens the project through `sessionActions`, as the screens do, instead of the services directly. */
  viaActions?: boolean;
}

const NEW_PROJECT = { name: "Vazio", password: "senha do projeto" } as const;

async function openSession(services: ReturnType<typeof createFakeServices>, options: MountOptions) {
  const session = new SessionStore();
  const project = options.project ?? "demo";
  if (project === "signed-out") return session;
  if (options.viaActions) {
    const actions = sessionActions(services, session);
    await actions.signIn(DEMO.email, DEMO.password);
    if (project !== "none") await actions.openProject(services.demoProjectId!, DEMO.projectPassword);
    return session;
  }
  let account = await services.signIn(DEMO.email, DEMO.password);
  if (project === "none") {
    session.update({ account, ...options.session });
    return session;
  }
  let projectId = services.demoProjectId!;
  let password: string = DEMO.projectPassword;
  if (project === "new") {
    account = await services.signUp({ name: "Carla", email: "carla@example.com", password: "uma frase longa" });
    projectId = (await services.createProject(NEW_PROJECT)).project.id;
    password = NEW_PROJECT.password;
  }
  const opened = await services.openProject(projectId, password);
  const readOnly = options.readOnly ?? false;
  let open = opened;
  if (project === "blank") {
    open = { ...opened, workspace: Workspace.fromRecords([], "Vazio", { readOnly }) };
  } else if (readOnly) {
    opened.workspace.setReadOnly(true);
  }
  if (options.openReadOnly !== undefined) open = { ...open, readOnly: options.openReadOnly };
  options.prepare?.(open.workspace);
  session.update({ account, open, operatorId: open.members[0]?.id ?? null, ...options.session });
  return session;
}

/** Renders the app on `path` with fake services; resolves once the heading (when asked for) is on screen. */
export async function mountApp(path: string, options: MountOptions = {}) {
  if (options.width !== undefined) setViewport(options.width);
  const services = createFakeServices({ seed: true, ...options.services });
  const session = await openSession(services, options);
  const router = createAppRouter({ session, history: createMemoryHistory({ initialEntries: [path] }) });
  const preferences = options.preferences ?? memoryPreferences();
  const view = render(<App router={router} services={services} session={session} preferences={preferences} />);
  if (options.heading !== undefined) {
    await screen.findByRole(
      "heading",
      { level: 1, name: options.heading },
      options.headingTimeout !== undefined ? { timeout: options.headingTimeout } : undefined,
    );
  }
  const workspace = session.get().open?.workspace as Workspace;
  return {
    router,
    session,
    services,
    preferences,
    view,
    /** The open project's workspace (undefined with no project open). */
    workspace,
    ledger: workspace?.ledger,
    user: userEvent.setup(),
  };
}

export type Mounted = Awaited<ReturnType<typeof mountApp>>;
