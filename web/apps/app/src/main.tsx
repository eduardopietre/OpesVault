/** Entry point: security policy, services, session and the router. */
import "@opesvault/ui/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { devicePreferences, readIdleLock, tabHolder } from "./preferences.ts";
import { UpdatePrompt } from "./pwa/UpdatePrompt.tsx";
import { createAppRouter, preloadProjectScreens } from "./router.tsx";
import { installTrustedTypes } from "./security.ts";
import { USE_FAKE_SERVICES } from "./flags.ts";
import { lazyServices } from "./services/lazy.ts";
import { SessionStore, sessionActions } from "./session.tsx";

installTrustedTypes(`${import.meta.env.BASE_URL}sw.js`);

async function start() {
  const preferences = devicePreferences();
  const idleMinutes = readIdleLock(preferences);
  // Which implementation is loaded when it is needed: the product's one arrives while the person signs in.
  const fakeModule = USE_FAKE_SERVICES ? await import("./services/fake.ts") : null;
  const fake = fakeModule
    ? fakeModule.createFakeServices({ seed: true, extras: true, latency: import.meta.env.DEV ? 250 : 120 })
    : null;
  fake?.setIdleLock(idleMinutes);
  const services =
    fake ??
    lazyServices(async () =>
      (await import("./services/real.ts")).createRealServices({
        holder: tabHolder(),
        idleLockMs: idleMinutes * 60_000,
        recordOpener: (await import("./data/open_pool.ts")).createWorkerOpener(),
      }),
    );
  const session = new SessionStore();
  const online = () => session.update({ online: navigator.onLine });
  window.addEventListener("online", online);
  window.addEventListener("offline", online);
  online();

  // The server session outlives the tab: a reload goes on from the project list, not from the sign-in form.
  const restored = await services.restoreAccount?.();
  if (restored) session.update({ account: restored });

  // "?demo" opens the demonstration project at once (fake services only): screenshots and e2e tests.
  const url = new URL(location.href);
  if (url.searchParams.has("demo") && fakeModule && fake?.demoProjectId) {
    const { DEMO } = fakeModule;
    const actions = sessionActions(services, session);
    await actions.signIn(DEMO.email, DEMO.password);
    await actions.openProject(fake.demoProjectId, DEMO.projectPassword);
    url.searchParams.delete("demo");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  // Signed in: the code of the project screens loads in the background (the services too, which the sign-in began).
  const stopPreloading = session.subscribe(() => {
    if (!session.get().account) return;
    stopPreloading();
    setTimeout(() => void preloadProjectScreens(), 0);
  });

  const router = createAppRouter({ session, extras: <UpdatePrompt /> });
  const root = document.getElementById("root");
  if (!root) return;
  createRoot(root).render(
    <StrictMode>
      <App router={router} services={services} session={session} preferences={preferences} />
    </StrictMode>,
  );
}

void start();
