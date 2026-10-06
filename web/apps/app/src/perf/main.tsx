/**
 * Measurement entry (perf.html, docs/18 W12). The same App, router and pages as the product, with a big
 * generated project behind it:
 *   ?mode=fake   the project is already in memory (UI timings, no cryptography)
 *   ?mode=real   the project is sealed with the project key, pushed to an in-process server and opened
 *                through the real vault path (Argon2id, IndexedDB cache, decrypting every record)
 *   &ops=N       number of operations (50 000 by default)
 * `window.__perf` is what e2e/perf.spec.ts drives; every phase is also a `performance.measure`.
 */
import "@opesvault/ui/styles.css";
import { ProjectVault, MemoryServer, type RecordOpener, VaultCache, signUp as vaultSignUp } from "@opesvault/vault";
import { createRoot } from "react-dom/client";
import { App } from "../App.tsx";
import { devicePreferences } from "../preferences.ts";
import { createAppRouter, preloadProjectScreens } from "../router.tsx";
import { createWorkerOpener } from "../data/open_pool.ts";
import { Workspace } from "../data/workspace.ts";
import { createFakeServices } from "../services/fake.ts";
import { createRealServices } from "../services/real.ts";
import { SessionStore, sessionActions } from "../session.tsx";
import type { AppServices, OpenProject } from "../services/types.ts";
import { buildBigProject } from "./generate.ts";

const EMAIL = "perf@opesvault.app";
const PASSWORD = "senha-da-conta-de-medicao";
const PROJECT_PASSWORD = "senha-do-projeto-de-medicao";

interface Phases {
  [name: string]: number;
}

function measure(name: string, from: string, to: string): number {
  return performance.measure(name, from, to).duration;
}

/** Resolves when `test` finds an element (a mutation observer, no polling). */
function appears(test: () => boolean, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (test()) return resolve();
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error("timeout waiting for the page"));
    }, timeoutMs);
    const observer = new MutationObserver(() => {
      if (test()) {
        clearTimeout(timer);
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });

async function start() {
  const params = new URL(location.href).searchParams;
  const mode = params.get("mode") === "real" ? "real" : "fake";
  const operations = Number(params.get("ops") ?? 50_000);
  const phases: Phases = {};
  const record = (name: string, ms: number) => (phases[name] = Math.round(ms));

  performance.mark("gen:start");
  const big = await buildBigProject({ operations });
  performance.mark("gen:end");
  record("generate", measure("generate", "gen:start", "gen:end"));

  const cacheName = `perf-cache-${Date.now()}`;
  let services: AppServices;
  let seedCache: VaultCache | null = null;
  let projectId = "perf-project";
  // The workers can be switched off between two openings of the same project (a rejection makes the vault open
  // the records on its own thread), so both ways are measured under the same load.
  let workersOn = params.get("workers") !== "0";
  const workerOpener = createWorkerOpener();
  const switchable: RecordOpener | undefined = workerOpener && {
    open: (share, items) => (workersOn ? workerOpener.open(share, items) : Promise.reject(new Error("off"))),
    openCached: (share, name, id) =>
      workersOn ? workerOpener.openCached(share, name, id) : Promise.reject(new Error("off")),
  };
  let records: number;
  if (mode === "real") {
    const server = new MemoryServer();
    const backend = server.client();
    performance.mark("seed:start");
    await vaultSignUp(backend, EMAIL, PASSWORD);
    seedCache = await VaultCache.open({ name: cacheName });
    const { vault } = await ProjectVault.create({
      backend,
      cache: seedCache,
      name: "Projeto Grande",
      password: PROJECT_PASSWORD,
    });
    projectId = vault.projectId;
    const seedStart = performance.now();
    const rows = big.session.ledger.toRecords().map((r) => ({ kind: r.kind, id: r.id, payload: r.payload }));
    records = rows.length;
    for (let i = 0; i < rows.length; i += 2000) await vault.stage(rows.slice(i, i + 2000));
    record("seed: stage (seal+IndexedDB)", performance.now() - seedStart);
    const pushStart = performance.now();
    await vault.syncNow();
    record("seed: push to the server", performance.now() - pushStart);
    await vault.lock();
    performance.mark("seed:end");
    record("seed", measure("seed", "seed:start", "seed:end"));
    services = createRealServices({
      backend,
      openCache: () => Promise.resolve(seedCache!),
      holder: "perf-tab",
      recordOpener: switchable,
      idleLockMs: null,
    });
  } else {
    const fake = createFakeServices({ seed: false });
    records = big.session.ledger.toRecords().length;
    const project = { id: projectId, name: "Projeto Grande", updatedAt: new Date().toISOString(), members: 2 };
    services = {
      ...fake,
      signIn: () => Promise.resolve({ id: "a", name: "Perf", email: EMAIL }),
      listProjects: () => Promise.resolve([project]),
      openProject: (): Promise<OpenProject> => {
        const workspace = new Workspace(big.session);
        const members = [...workspace.ledger.members.values()].map((m) => ({ id: m.id, name: m.name }));
        return Promise.resolve({ project, workspace, members, attention: {}, readOnly: false });
      },
    };
  }

  const preferences = devicePreferences();
  const session = new SessionStore();
  const actions = sessionActions(services, session);
  const router = createAppRouter({ session });
  const root = document.getElementById("root");
  if (!root) return;
  createRoot(root).render(<App router={router} services={services} session={session} preferences={preferences} />);

  const api = {
    mode,
    operations: big.operations,
    records,
    phases,
    /** Signs in and opens the project like the user does; resolves with the phase times in ms. */
    async open(): Promise<Phases> {
      const out: Phases = {};
      performance.mark("signin:start");
      await actions.signIn(EMAIL, PASSWORD);
      // As in the app: the project's code starts loading once someone is signed in.
      void preloadProjectScreens();
      performance.mark("signin:end");
      out["signIn"] = Math.round(measure("signIn", "signin:start", "signin:end"));
      performance.mark("open:start");
      await actions.openProject(projectId, PROJECT_PASSWORD);
      performance.mark("open:resolved");
      out["unlock"] = Math.round(measure("unlock", "open:start", "open:resolved"));
      await router.navigate({ to: "/visao-geral" });
      await appears(() => document.querySelector("h1")?.textContent?.includes("Visão geral") === true);
      await frames(2);
      performance.mark("open:painted");
      out["firstPaint"] = Math.round(measure("firstPaint", "open:resolved", "open:painted"));
      out["total"] = Math.round(measure("total", "open:start", "open:painted"));
      return out;
    },
    /** The phases the vault and the workspace marked while opening (ms). */
    marks(): Phases {
      const out: Phases = {};
      for (const m of performance.getEntriesByType("measure"))
        if (m.name.startsWith("opv:")) out[m.name] = Math.round(m.duration);
      return out;
    },
    /** Closes the project (the next `open` reads the IndexedDB copy again). */
    async close(): Promise<void> {
      await actions.closeProject();
      await router.navigate({ to: "/projetos" }).catch(() => undefined);
    },
    /** A cold start: forgets this device's copy of the project, so the next open pulls every record from the server. */
    async useColdCache(): Promise<void> {
      await seedCache?.forgetProject(projectId);
    },
    /** Opens the records with the workers (the default) or on the main thread. */
    setWorkers(on: boolean): void {
      workersOn = on;
    },
    go: (to: string) => router.navigate({ to }),
    appears: (selector: string) => appears(() => document.querySelector(selector) !== null),
  };
  (window as unknown as { __perf: typeof api }).__perf = api;
  document.documentElement.dataset["perfReady"] = "1";
}

void start();
