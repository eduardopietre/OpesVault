/** The app's providers around the router: motion policy, device preferences, theme, session and undo. */
import { MotionProvider, PreferencesProvider, type PreferenceStore } from "@opesvault/ui";
import { RouterProvider } from "@tanstack/react-router";
import type { AppRouter } from "./router.tsx";
import type { AppServices } from "./services/types.ts";
import { SessionProvider, type SessionStore } from "./session.tsx";
import { WorkspaceBridge } from "./data/bridge.tsx";
import { ThemeProvider } from "./theme.tsx";

export function App({
  router,
  services,
  session,
  preferences,
}: {
  router: AppRouter;
  services: AppServices;
  session: SessionStore;
  preferences: PreferenceStore;
}) {
  return (
    <MotionProvider>
      <PreferencesProvider store={preferences}>
        <ThemeProvider>
          <SessionProvider store={session} services={services}>
            <WorkspaceBridge>
              <RouterProvider router={router} />
            </WorkspaceBridge>
          </SessionProvider>
        </ThemeProvider>
      </PreferencesProvider>
    </MotionProvider>
  );
}
