/** Mounts Reembolsos e acertos and Documentos with the demonstration project (or an empty one). */
import { AccountType, type IsoDate } from "@opesvault/domain";
import { memoryPreferences } from "@opesvault/ui";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/App.tsx";
import type { Workspace } from "../../src/data/workspace.ts";
import { createAppRouter } from "../../src/router.tsx";
import { DEMO, createFakeServices } from "../../src/services/fake.ts";
import { SessionStore } from "../../src/session.tsx";

export type User = ReturnType<typeof userEvent.setup>;

export interface OpenOptions {
  empty?: boolean;
  /** Runs on the project before the page is shown (the demonstration has no balance between members). */
  prepare?: (workspace: Workspace) => void;
}

export async function openAt(path: string, heading: string, options: OpenOptions = {}) {
  const services = createFakeServices({ seed: true });
  const session = new SessionStore();
  let account = await services.signIn(DEMO.email, DEMO.password);
  let projectId = services.demoProjectId!;
  let password: string = DEMO.projectPassword;
  if (options.empty) {
    account = await services.signUp({ name: "Carla", email: "carla@example.com", password: "uma frase longa" });
    const created = await services.createProject({ name: "Vazio", password: "senha do projeto" });
    projectId = created.project.id;
    password = "senha do projeto";
  }
  const open = await services.openProject(projectId, password);
  options.prepare?.(open.workspace);
  session.update({ account, open, operatorId: open.members[0]?.id ?? null });
  const router = createAppRouter({ session, history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} services={services} session={session} preferences={memoryPreferences()} />);
  await screen.findByRole("heading", { level: 1, name: heading });
  return { router, workspace: open.workspace, ledger: open.workspace.ledger, user: userEvent.setup() };
}

/** A line of a table or card list, with its spaces collapsed. */
export const flat = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/**
 * Two purchases on Ana's card made for Bruno: Bruno owes Ana 200,00. (In the demonstration the account that
 * paid the pediatrician is joint, so nothing is owed between members until something like this exists.)
 */
export function shareExpenses(workspace: Workspace): void {
  workspace.act((ledger) => {
    const bruno = [...ledger.members.values()].find((m) => m.name === "Bruno")!.id;
    const card = [...ledger.cards.values()][0]!.id;
    const category = ledger.categories(AccountType.EXPENSE).find((a) => a.name === "Lazer")!.id;
    ledger.recordCardPurchase(card, category, "120.00", "2026-03-08" as IsoDate, "Material escolar", null, {
      member_id: bruno,
    });
    ledger.recordCardPurchase(card, category, "80.00", "2026-03-09" as IsoDate, "Presente de aniversário", null, {
      member_id: bruno,
    });
  });
}
