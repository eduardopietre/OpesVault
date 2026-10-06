/**
 * The print views live outside the shell, so the lock screen must be shown by them too: a locked project has
 * no workspace, and a view that reads it would fail and leave a blank page with no way to unlock.
 */
import { LockScreen } from "@opesvault/ui";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useSession, useSessionActions } from "../session.tsx";

export function PrintGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const actions = useSessionActions();
  const navigate = useNavigate();
  if (!session.open) {
    if (!session.locked) return null;
    return (
      <LockScreen
        projectName={session.lockedName}
        onUnlock={(password) => actions.unlock(password)}
        onSignOut={() => void actions.signOut().then(() => navigate({ to: "/boas-vindas" }))}
      />
    );
  }
  return <>{children}</>;
}
