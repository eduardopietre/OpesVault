/**
 * The app session: who is signed in, which project is open, whether it is locked and the sync state.
 * An external store, so the router guards and React read the same value (useSyncExternalStore). It never
 * holds a password or a key; the services do the cryptography (W1) and report only the outcome.
 */
import { cancelAllDecisions, clearToasts, type SyncState } from "@opesvault/ui";
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Account, AppServices, OpenProject } from "./services/types.ts";

export interface SessionState {
  account: Account | null;
  open: OpenProject | null;
  locked: boolean;
  /** Name kept while locked only to say which project to unlock (it is not project data). */
  lockedName: string | null;
  sync: SyncState;
  operatorId: string | null;
  online: boolean;
}

const EMPTY: SessionState = {
  account: null,
  open: null,
  locked: false,
  lockedName: null,
  sync: "synced",
  operatorId: null,
  online: true,
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
  openProject(id: string, password: string): Promise<void>;
  closeProject(): Promise<void>;
  lock(): Promise<void>;
  unlock(password: string): Promise<void>;
  setOperator(id: string): void;
}

export function sessionActions(services: AppServices, store: SessionStore): SessionActions {
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
      await services.signOut();
      forget();
      store.update({ ...EMPTY, online: store.get().online });
    },
    async openProject(id, password) {
      const open = await services.openProject(id, password);
      store.update({ open, locked: false, lockedName: null, sync: "synced", operatorId: open.members[0]?.id ?? null });
    },
    async closeProject() {
      await services.closeProject();
      forget();
      store.update({ open: null, locked: false, lockedName: null, operatorId: null });
    },
    async lock() {
      const name = store.get().open?.project.name ?? null;
      await services.lock();
      forget();
      store.update({ open: null, locked: true, lockedName: name });
    },
    async unlock(password) {
      const open = await services.unlock(password);
      store.update({
        open,
        locked: false,
        lockedName: null,
        operatorId: store.get().operatorId ?? open.members[0]?.id ?? null,
      });
    },
    setOperator(id) {
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
