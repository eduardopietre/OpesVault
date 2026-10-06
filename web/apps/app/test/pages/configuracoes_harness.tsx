/** Mounting Configurações on the demonstration project (fake services with light key derivation) for its tests. */
import { memoryPreferences, type PreferenceStore } from "@opesvault/ui";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, vi } from "vitest";
import { App } from "../../src/App.tsx";
import { Workspace } from "../../src/data/workspace.ts";
import { createAppRouter } from "../../src/router.tsx";
import { DEMO, createFakeServices } from "../../src/services/fake.ts";
import { SessionStore } from "../../src/session.tsx";
import { setViewport } from "./livro_harness.tsx";

export type User = ReturnType<typeof userEvent.setup>;

/** Argon2id light enough for tests (production asks for 64 MiB). */
export const LIGHT_KDF = { algorithm: "argon2id", memoryKiB: 8192, iterations: 1, parallelism: 1 } as const;

export interface OpenOptions {
  /** The level-1 heading to wait for (the page opened); Configurações by default. */
  heading?: string;
  width?: number;
  readOnly?: boolean;
  empty?: boolean;
  preferences?: PreferenceStore;
}

export async function openSettings(path = "/configuracoes", options: OpenOptions = {}) {
  setViewport(options.width ?? 1600);
  const services = createFakeServices({ seed: true, kdf: LIGHT_KDF });
  const session = new SessionStore();
  const account = await services.signIn(DEMO.email, DEMO.password);
  const opened = await services.openProject(services.demoProjectId!, DEMO.projectPassword);
  const open =
    options.readOnly || options.empty
      ? {
          ...opened,
          readOnly: options.readOnly ?? false,
          workspace: Workspace.fromRecords([], "Vazio", { readOnly: options.readOnly ?? false }),
        }
      : opened;
  session.update({ account, open, operatorId: open.members[0]?.id ?? null });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ session, history });
  const preferences = options.preferences ?? memoryPreferences();
  render(<App router={router} services={services} session={session} preferences={preferences} />);
  await screen.findByRole("heading", { level: 1, name: options.heading ?? "Configurações" });
  return {
    services,
    session,
    router,
    preferences,
    workspace: open.workspace,
    ledger: open.workspace.ledger,
    user: userEvent.setup(),
  };
}

export async function goTab(user: User, name: string) {
  await user.click(screen.getByRole("tab", { name }));
  await waitFor(() => expect(screen.getByRole("tab", { name }).getAttribute("aria-selected")).toBe("true"));
  return screen.getByRole("tabpanel");
}

export const dialog = (name: string | RegExp) => screen.findByRole("dialog", { name });
export const closed = (name: string | RegExp) =>
  waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());

/** Types into a field by its label. */
export async function type(user: User, scope: HTMLElement, label: string | RegExp, text: string) {
  const field = within(scope).getByLabelText(label) as HTMLInputElement;
  await user.clear(field);
  if (text) await user.type(field, text);
}

/** Lets the page download files without a browser: remembers what was offered. */
export function captureDownloads(): { files: { name: string; blob: Blob }[]; restore: () => void } {
  const files: { name: string; blob: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  let counter = 0;
  const create = vi.spyOn(URL, "createObjectURL").mockImplementation((object) => {
    const url = `blob:test/${++counter}`;
    blobs.set(url, object as Blob);
    return url;
  });
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href);
    if (blob && this.download) files.push({ name: this.download, blob });
  });
  return {
    files,
    restore: () => {
      create.mockRestore();
      revoke.mockRestore();
      click.mockRestore();
    },
  };
}

/** A File the person would pick, from a downloaded Blob. */
export async function fileOf(download: { name: string; blob: Blob }): Promise<File> {
  return new File([await download.blob.arrayBuffer()], download.name, { type: "application/octet-stream" });
}

/** The projects screen of a signed-in account with no project open. */
export async function openProjects(options: { width?: number } = {}) {
  setViewport(options.width ?? 1600);
  const services = createFakeServices({ seed: true, kdf: LIGHT_KDF });
  const session = new SessionStore();
  const account = await services.signIn(DEMO.email, DEMO.password);
  session.update({ account });
  const history = createMemoryHistory({ initialEntries: ["/projetos"] });
  const router = createAppRouter({ session, history });
  const preferences = memoryPreferences();
  render(<App router={router} services={services} session={session} preferences={preferences} />);
  await screen.findByRole("heading", { level: 1, name: "Projetos" });
  return { services, session, router, preferences, user: userEvent.setup() };
}
