/**
 * Esqueci a senha (docs/19 §10): the recovery key opens the project and the person sets a new password. Needs the
 * server, because the new envelope is stored there. The key keeps working until it is regenerated. Used from the
 * projects screen, where no project is open yet.
 */
import { TextField } from "@opesvault/ui";
import { useState } from "react";
import { MIN_PASSWORD } from "../screens/auth.tsx";
import { useSessionActions } from "../session.tsx";
import { SettingsDialog } from "./settings_form.tsx";

export interface RecoverProjectDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** Said in the title so it is clear which project is being opened. */
  projectName: string;
  onOpened: () => void;
}

export function RecoverProjectDialog({ open, onClose, projectId, projectName, onOpened }: RecoverProjectDialogProps) {
  const actions = useSessionActions();
  const [key, setKey] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const close = () => {
    setKey("");
    setNext("");
    setAgain("");
    onClose();
  };
  const tooShort = next.length > 0 && next.length < MIN_PASSWORD;
  const mismatch = again.length > 0 && again !== next;
  const ready = key.trim() !== "" && next.length >= MIN_PASSWORD && again === next;
  return (
    <SettingsDialog
      open={open}
      onClose={close}
      title={`Recuperar ${projectName}`}
      description="Digite a chave de recuperação do projeto e escolha uma senha nova. Os outros integrantes passam a usar a nova senha."
      confirmLabel="Recuperar e abrir"
      size="sm"
      confirmDisabled={!ready}
      busyText="Abrindo o projeto com a chave…"
      onConfirm={async () => {
        await actions.recoverProject(projectId, key, next);
        close();
        onOpened();
      }}
    >
      <TextField
        label="Chave de recuperação"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        value={key}
        onChange={setKey}
        hint="Nove grupos de quatro caracteres, com ou sem hífens. Letras minúsculas servem."
        className="font-mono"
        data-autofocus=""
      />
      <TextField
        label="Nova senha do projeto"
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={setNext}
        hint={`Pelo menos ${MIN_PASSWORD} caracteres.`}
        error={tooShort ? `Use pelo menos ${MIN_PASSWORD} caracteres.` : null}
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
