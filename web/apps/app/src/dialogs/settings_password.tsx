/**
 * Trocar a senha do projeto (desktop `ChangePasswordDialog`, `main_window` "Trocar senha…"): needs the current
 * password, sets the new one for every member (the password is shared) and refolds only the key's wrapping, so
 * nothing is re-encrypted. Backups made before keep the old password (docs/19 §10, §13).
 */
import { TextField, notify } from "@opesvault/ui";
import { useState } from "react";
import { MIN_PASSWORD } from "../screens/auth.tsx";
import { useServices } from "../session.tsx";
import { SettingsDialog } from "./settings_form.tsx";

export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const services = useServices();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const close = () => {
    setCurrent("");
    setNext("");
    setAgain("");
    onClose();
  };
  const tooShort = next.length > 0 && next.length < MIN_PASSWORD;
  const mismatch = again.length > 0 && again !== next;
  const same = next.length > 0 && next === current;
  const ready = current !== "" && next.length >= MIN_PASSWORD && again === next && !same;
  return (
    <SettingsDialog
      open={open}
      onClose={close}
      title="Trocar a senha do projeto"
      description="Todos os integrantes passam a usar a nova senha. Backups feitos antes continuam com a senha antiga."
      confirmLabel="Trocar senha"
      size="sm"
      confirmDisabled={!ready}
      busyText="Trocando a senha…"
      onConfirm={async () => {
        await services.changePassword(current, next);
        notify("Senha do projeto trocada. Os outros integrantes usam a nova a partir de agora.", {
          tone: "positive",
        });
        close();
      }}
    >
      <TextField
        label="Senha atual"
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={setCurrent}
        data-autofocus=""
      />
      <TextField
        label="Nova senha"
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={setNext}
        hint={`Pelo menos ${MIN_PASSWORD} caracteres. Diferente da senha da conta.`}
        error={
          tooShort
            ? `Use pelo menos ${MIN_PASSWORD} caracteres.`
            : same
              ? "A nova senha precisa ser diferente da atual."
              : null
        }
      />
      <TextField
        label="Confirme a nova senha"
        type="password"
        autoComplete="new-password"
        value={again}
        onChange={setAgain}
        error={mismatch ? "As senhas não coincidem." : null}
      />
    </SettingsDialog>
  );
}
