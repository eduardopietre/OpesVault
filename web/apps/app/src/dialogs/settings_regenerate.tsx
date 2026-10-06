/**
 * Gerar nova chave de recuperação (docs/19 §10): needs the project password; the previous key stops working at
 * once, so the new one is shown ONCE and the dialog cannot be left before "Já guardei" is confirmed. The key
 * lives only in this dialog's state until it closes.
 */
import { Checkbox, TextField } from "@opesvault/ui";
import { useState } from "react";
import { useServices } from "../session.tsx";
import { RecoveryKeyBox, SettingsDialog } from "./settings_form.tsx";

export function RegenerateRecoveryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const services = useServices();
  const [password, setPassword] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const close = () => {
    setPassword("");
    setKey(null);
    setSaved(false);
    onClose();
  };
  if (key !== null) {
    return (
      <SettingsDialog
        open={open}
        onClose={close}
        title="Guarde a nova chave de recuperação"
        description="Ela aparece agora e não será mostrada de novo. A chave anterior não abre mais o projeto."
        confirmLabel="Concluir"
        required
        confirmDisabled={!saved}
        onConfirm={close}
      >
        <RecoveryKeyBox label="Nova chave de recuperação" value={key} />
        <Checkbox
          label="Já guardei a nova chave de recuperação num lugar seguro"
          description="Sem a senha e sem esta chave, ninguém consegue abrir o projeto, nem o servidor."
          checked={saved}
          onCheckedChange={setSaved}
        />
      </SettingsDialog>
    );
  }
  return (
    <SettingsDialog
      open={open}
      onClose={close}
      title="Gerar nova chave de recuperação"
      description="A chave de recuperação abre o projeto se a senha for esquecida. Gerar outra invalida a atual."
      confirmLabel="Gerar nova chave"
      size="sm"
      confirmDisabled={password === ""}
      busyText="Gerando a chave…"
      onConfirm={async () => {
        const generated = await services.regenerateRecoveryKey(password);
        setPassword("");
        setKey(generated);
      }}
    >
      <TextField
        label="Senha do projeto"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        hint="A senha confirma que é você. Ela não é guardada."
        data-autofocus=""
      />
    </SettingsDialog>
  );
}
