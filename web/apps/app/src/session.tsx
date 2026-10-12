/**
 * The app session: who is signed in, which project is open, whether it is locked and the sync state.
 * An external store, so the router guards and React read the same value (useSyncExternalStore). It never
 * holds a password or a key; the services do the cryptography (W1) and report only the outcome.
 */
import { cancelAllDecisions, clearToasts, type SyncState } from "@opesvault/ui";
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { activeMembers, defaultOperator, sameMembers } from "./data/operator.ts";
import { chooseMonth, monthOfDate } from "./data/shared_month.ts";
import type { Account, AppServices, OpenOptions, OpenProject } from "./services/types.ts";

export interface SessionState {
  account: Account | null;
  open: OpenProject | null;
  locked: boolean;
  /** Name kept while locked only to say which project to unlock (it is not project data). */
  lockedName: string | null;
  sync: SyncState;
  operatorId: string | null;
  online: boolean;
  /** Changes made here and not yet sent to the server. */
  pending: number;
  /** The browser may erase this device's data (persistent storage denied). */
  storageAtRisk: boolean;
  /** Changes only in this tab's memory: they could not be stored in the browser yet (`saveError` says why). */
  unsaved: number;
  saveError: string | null;
}

const EMPTY: SessionState = {
  account: null,
  open: null,
  locked: false,
  lockedName: null,
  sync: "synced",
  operatorId: null,
  online: true,
  pending: 0,
  storageAtRisk: false,
  unsaved: 0,
  saveError: null,
};

export class SessionStore {
  private state: SessionState = EMPTY;
  private readonly listeners = new Set<() => void>();

  get = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(changes: Partial<SessionState>): void {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) listener();
  }

  reset(): void {
    this.update(EMPTY);
  }
}

/** The sync state shown in the top bar, from the session (offline and read-only win). */
export function syncStateOf(state: SessionState): SyncState {
  if (state.locked) return "locked";
  if (!state.online) return "offline";
  if (state.open?.readOnly) return "readonly";
  return state.sync;
}

export interface SessionActions {
  signIn(email: string, password: string): Promise<void>;
  signUp(input: { name: string; email: string; password: string }): Promise<void>;
  signOut(): Promise<void>;
  openProject(id: string, password: string, options?: OpenOptions): Promise<void>;
  closeProject(): Promise<void>;
  /** Opens a project with its recovery key, setting a new password. */
  recoverProject(id: string, recoveryKey: string, newPassword: string): Promise<void>;
  /** Renames the open project; the top bar follows. */
  renameProject(name: string): Promise<void>;
  /** Forgets this device's local copy and ends the session (the page clears the preferences). */
  forgetDevice(): Promise<void>;
  lock(): Promise<void>;
  unlock(password: string): Promise<void>;
  setOperator(id: string): void;
}

export function sessionActions(services: AppServices, store: SessionStore): SessionActions {
  let unwatch: (() => void) | null = null;
  /** The operator picked in the top bar, per project, for the life of this tab (memory only, docs/19 §8). */
  const chosenOperator = new Map<string, string>();
  const operatorOnOpen = (open: OpenProject) =>
    defaultOperator(open.members, store.get().account?.name, chosenOperator.get(open.project.id));
  /**
   * Follows the open project's members (added in the assistant, in Configurações or on another device), so the
   * top bar offers them at once; an operator who is no longer active gives way to the default.
   */
  const followMembers = (workspace: OpenProject["workspace"]) =>
    workspace.subscribe(() => {
      const state = store.get();
      if (state.open?.workspace !== workspace) return;
      const members = activeMembers(workspace.ledger);
      if (sameMembers(members, state.open.members)) return;
      const open = { ...state.open, members };
      const operatorId = defaultOperator(members, state.account?.name, state.operatorId);
      workspace.setOperator(operatorName(open, operatorId));
      store.update({ open, operatorId });
    });
  /** Follows the vault: sync state in the top bar, and an idle lock decided by the vault itself. */
  const watch = () => {
    unwatch?.();
    const workspace = store.get().open?.workspace;
    const unfollow = workspace ? followMembers(workspace) : () => {};
    const unsync = services.watchSync((status, detail) => {
      const state = store.get();
      const pending = detail?.pending ?? 0;
      const storageAtRisk = detail?.storageAtRisk ?? false;
      const unsaved = detail?.unsaved ?? 0;
      const saveError = detail?.saveError ?? null;
      if (
        pending !== state.pending ||
        storageAtRisk !== state.storageAtRisk ||
        unsaved !== state.unsaved ||
        saveError !== state.saveError
      ) {
        store.update({ pending, storageAtRisk, unsaved, saveError });
      }
      if (status === "locked") {
        if (state.open) {
          cancelAllDecisions();
          clearToasts();
          store.update({ open: null, locked: true, lockedName: state.open.project.name });
        }
        return;
      }
      if (status === "readOnly") return; // shown from open.readOnly / the workspace
      store.update({ sync: status });
    });
    unwatch = () => {
      unfollow();
      unsync();
    };
  };
  const operatorName = (open: OpenProject, id: string | null) => open.members.find((m) => m.id === id)?.name ?? null;
  const forget = () => {
    // Nothing waits on a question about data that is no longer open.
    cancelAllDecisions();
    clearToasts();
  };
  return {
    async signIn(email, password) {
      const account = await services.signIn(email, password);
      store.update({ account });
    },
    async signUp(input) {
      const account = await services.signUp(input);
      store.update({ account });
    },
    async signOut() {
      unwatch?.();
      unwatch = null;
      await services.signOut();
      chosenOperator.clear();
      forget();
      store.update({ ...EMPTY, online: store.get().online });
    },
    async openProject(id, password, options) {
      const open = await services.openProject(id, password, options);
      const operatorId = operatorOnOpen(open);
      open.workspace.setOperator(operatorName(open, operatorId));
      chooseMonth(open.startMonth ?? monthOfDate(open.workspace.today()));
      store.update({ open, locked: false, lockedName: null, sync: "synced", operatorId });
      watch();
    },
    async recoverProject(id, recoveryKey, newPassword) {
      const open = await services.recoverProject(id, recoveryKey, newPassword);
      const operatorId = operatorOnOpen(open);
      open.workspace.setOperator(operatorName(open, operatorId));
      chooseMonth(open.startMonth ?? monthOfDate(open.workspace.today()));
      store.update({ open, locked: false, lockedName: null, sync: "synced", operatorId });
      watch();
    },
    async renameProject(name) {
      const project = await services.renameProject(name);
      const open = store.get().open;
      if (open) store.update({ open: { ...open, project } });
    },
    async forgetDevice() {
      unwatch?.();
      unwatch = null;
      await services.forgetDevice();
      chosenOperator.clear();
      forget();
      store.update({ ...EMPTY, online: store.get().online });
    },
    async closeProject() {
      unwatch?.();
      unwatch = null;
      await services.closeProject();
      forget();
      store.update({ open: null, locked: false, lockedName: null, operatorId: null, pending: 0 });
    },
    async lock() {
      const name = store.get().open?.project.name ?? null;
      await services.lock();
      forget();
      store.update({ open: null, locked: true, lockedName: name });
    },
    async unlock(password) {
      const open = await services.unlock(password);
      const operatorId = defaultOperator(open.members, store.get().account?.name, store.get().operatorId);
      open.workspace.setOperator(operatorName(open, operatorId));
      store.update({ open, locked: false, lockedName: null, operatorId });
      watch();
    },
    setOperator(id) {
      const open = store.get().open;
      if (open) {
        open.workspace.setOperator(operatorName(open, id));
        chosenOperator.set(open.project.id, id);
      }
      store.update({ operatorId: id });
    },
  };
}

interface SessionContextValue {
  store: SessionStore;
  actions: SessionActions;
  services: AppServices;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  store,
  services,
  children,
}: {
  store: SessionStore;
  services: AppServices;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ store, services, actions: sessionActions(services, store) }), [store, services]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

function useSessionContext(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider missing");
  return value;
}

export function useSession(): SessionState {
  const { store } = useSessionContext();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function useSessionActions(): SessionActions {
  return useSessionContext().actions;
}

export function useServices(): AppServices {
  return useSessionContext().services;
}
