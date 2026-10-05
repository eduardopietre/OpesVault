/**
 * The lock screen (docs/18 §3.3): the key and the open data are gone from the tab; the project password
 * opens it again. Changes not yet sent stay encrypted on this device. The project name may stay hidden.
 */
import { motion } from "motion/react";
import { LockKeyhole } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { useMotionPreset } from "../motion.tsx";
import { Button } from "./Button.tsx";
import { TextField } from "./fields.tsx";

export interface LockScreenProps {
  /** Shown only when the user chose to; otherwise "Projeto bloqueado". */
  projectName?: string | null;
  /** Unlocks with the password; rejects with a user-facing message when it is wrong. */
  onUnlock: (password: string) => Promise<void>;
  onSignOut?: () => void;
  /** Alterações ainda não enviadas, kept encrypted on this device. */
  pendingChanges?: number;
  /** Inside another page (the catalog): a region instead of the page's main landmark. */
  embedded?: boolean;
}

export function LockScreen({
  projectName,
  onUnlock,
  onSignOut,
  pendingChanges = 0,
  embedded = false,
}: LockScreenProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preset = useMotionPreset();
  const titleId = useId();
  const Root = embedded ? "div" : "main";
  const Heading = embedded ? "h2" : "h1";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password) {
      setError("Digite a senha do projeto.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onUnlock(password);
      setPassword("");
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "Não foi possível desbloquear.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Root
      className={
        embedded
          ? "grid place-items-center rounded-xl bg-window px-4 py-10"
          : "grid min-h-dvh place-items-center bg-window px-4 py-10"
      }
    >
      <motion.form
        {...preset.enter}
        onSubmit={submit}
        noValidate
        aria-labelledby={titleId}
        className="w-full max-w-[400px] rounded-xl border border-separator bg-raised p-6 shadow-lg tablet:p-8"
      >
        <div
          aria-hidden="true"
          className="mx-auto mb-5 grid size-14 place-items-center rounded-full bg-accent-soft text-accent"
        >
          <LockKeyhole className="size-7" />
        </div>
        <Heading id={titleId} className="text-center text-title font-semibold">
          {projectName ? `${projectName} está bloqueado` : "Projeto bloqueado"}
        </Heading>
        <p className="mt-2 text-center text-body text-secondary">
          A chave e os dados abertos foram apagados desta aba. Digite a senha do projeto para continuar.
        </p>
        {pendingChanges > 0 ? (
          <p className="mt-3 rounded-md bg-warning-soft px-3 py-2 text-caption text-text">
            {pendingChanges === 1
              ? "1 alteração ainda não enviada está guardada cifrada neste aparelho."
              : `${pendingChanges} alterações ainda não enviadas estão guardadas cifradas neste aparelho.`}
          </p>
        ) : null}
        <div className="mt-6">
          <TextField
            label="Senha do projeto"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            error={error}
            autoFocus={!embedded}
          />
        </div>
        <Button type="submit" variant="primary" size="lg" className="mt-5 w-full" busy={busy}>
          Desbloquear
        </Button>
        {onSignOut ? (
          <Button variant="ghost" className="mt-2 w-full" onClick={onSignOut}>
            Sair da conta
          </Button>
        ) : null}
      </motion.form>
    </Root>
  );
}
