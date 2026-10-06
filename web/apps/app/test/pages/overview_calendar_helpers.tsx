/** Mounting the app on a page of the demonstration project (or an empty one) for the component tests. */
import { memoryPreferences, type PreferenceStore } from "@opesvault/ui";
import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { App } from "../../src/App.tsx";
import { Workspace } from "../../src/data/workspace.ts";
import { createAppRouter } from "../../src/router.tsx";
import { DEMO, createFakeServices } from "../../src/services/fake.ts";
import { SessionStore } from "../../src/session.tsx";

export interface MountOptions {
  preferences?: PreferenceStore;
  /** Opens an empty project instead of the demonstration one. */
  empty?: boolean;
  /** An empty project that another tab or device is editing. */
  readOnly?: boolean;
}

export async function mountPage(path: string, options: MountOptions = {}) {
  const services = createFakeServices({ seed: true });
  const session = new SessionStore();
  const account = await services.signIn(DEMO.email, DEMO.password);
  const opened = await services.openProject(services.demoProjectId!, DEMO.projectPassword);
  const open =
    options.empty || options.readOnly
      ? { ...opened, workspace: Workspace.fromRecords([], "Vazio", { readOnly: options.readOnly ?? false }) }
      : opened;
  session.update({ account, open, operatorId: open.members[0]?.id ?? null });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ session, history });
  const preferences = options.preferences ?? memoryPreferences();
  const view = render(<App router={router} services={services} session={session} preferences={preferences} />);
  return { router, session, services, workspace: open.workspace, preferences, view };
}
