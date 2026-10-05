/** Entry point: security policy, services, session and the router. */
import "@opesvault/ui/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { devicePreferences } from "./preferences.ts";
import { UpdatePrompt } from "./pwa/UpdatePrompt.tsx";
import { createAppRouter } from "./router.tsx";
import { installTrustedTypes } from "./security.ts";
import { DEMO, createFakeServices } from "./services/fake.ts";
import { SessionStore, sessionActions } from "./session.tsx";

installTrustedTypes(`${import.meta.env.BASE_URL}sw.js`);

async function start() {
  const services = createFakeServices({ seed: true, latency: import.meta.env.DEV ? 250 : 120 });
  const session = new SessionStore();
  const online = () => session.update({ online: navigator.onLine });
  window.addEventListener("online", online);
  window.addEventListener("offline", online);
  online();

  // "?demo" opens the demonstration project at once (fake services only): screenshots and e2e tests.
  const url = new URL(location.href);
  if (url.searchParams.has("demo") && services.demoProjectId) {
    const actions = sessionActions(services, session);
    await actions.signIn(DEMO.email, DEMO.password);
    await actions.openProject(services.demoProjectId, DEMO.projectPassword);
    url.searchParams.delete("demo");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  const router = createAppRouter({ session, extras: <UpdatePrompt /> });
  const root = document.getElementById("root");
  if (!root) return;
  createRoot(root).render(
    <StrictMode>
      <App router={router} services={services} session={session} preferences={devicePreferences()} />
    </StrictMode>,
  );
}

void start();
