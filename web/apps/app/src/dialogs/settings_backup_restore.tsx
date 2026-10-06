/**
 * Restaurar backup (desktop "Restaurar backup…", docs/03 §7 and docs/19 §13.3): the file is checked completely
 * first, then it becomes a NEW project (never over an existing one) with a new key and a new recovery key,
 * shown once. The new project takes the file's password; it can be changed in Configurações afterwards.
 */
import { Button, Checkbox, TextField } from "@opesvault/ui";
import { useState } from "react";
import type { BackupProgress, RestoredProject } from "../services/types.ts";
import { useServices } from "../session.tsx";
import { Caption } from "./livro_form.tsx";
import { progressText } from "./settings_backup_export.tsx";
import { BackupCheckSummary } from "./settings_backup_verify.tsx";
import { FilePicker } from "./settings_file.tsx";
import { RecoveryKeyBox, SettingsDialog } from "./settings_form.tsx";

export interface RestoreBackupDialogProps {
  open: boolean;
  onClose: () => void;
  /** Opens the restored project (the parent signs it in with the password the dialog hands over). */
  onOpenProject: (project: RestoredProject, password: string) => Promise<void>;
}

export function RestoreBackupDialog({ open, onClose, onOpenProject }: RestoreBackupDialogProps) {
  const services = useServices();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [restored, setRestored] = useState<RestoredProject | null>(null);
  const [saved, setSaved] = useState(false);
  const close = () => {
    setFile(null);
    setPassword("");
    setName("");
    setProgress(null);
    setRestored(null);
    setSaved(false);
    onClose();
  };
  if (restored) {
    return (
      <SettingsDialog
        open={open}
        onClose={close}
        title="Projeto restaurado"
        description={
          <>
            O backup virou o projeto novo <strong className="font-semibold">{restored.project.name}</strong>. O projeto
            que estava aberto não foi tocado.
          </>
        }
        confirmLabel="Abrir o projeto restaurado"
        required
        size="lg"
        confirmDisabled={!saved}
        extraActions={
          <Button disabled={!saved} onClick={close}>
            Ficar aqui
          </Button>
        }
        onConfirm={async () => {
          const password_ = password;
          await onOpenProject(restored, password_);
          close();
        }}
      >
        <BackupCheckSummary check={restored.check} />
        <div className="flex flex-col gap-2">
          <h3 className="text-body font-semibold">Chave de recuperação do projeto novo</h3>
          <Caption>
            O projeto restaurado tem uma chave própria. Ela aparece agora e não será mostrada de novo. A senha dele é a
            do arquivo; troque-a em Configurações, Segurança, se quiser.
          </Caption>
          <RecoveryKeyBox label="Chave de recuperação do projeto restaurado" value={restored.recoveryKey} />
        </div>
        <Checkbox
          label="Já guardei a chave de recuperação num lugar seguro"
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
      title="Restaurar backup"
      description="Cria um projeto novo a partir do arquivo. Nada é gravado em projeto existente."
      confirmLabel="Restaurar como projeto novo"
      size="sm"
      confirmDisabled={file === null || password === ""}
      busyText={progressText(progress)}
      onConfirm={async () => {
        if (!file) return;
        const result = await services.restoreBackup(file, password, name, setProgress);
        setRestored(result);
      }}
    >
      <FilePicker
        label="Arquivo de backup"
        file={file}
        onFile={setFile}
        empty="O arquivo é lido neste navegador e não é enviado."
      />
      <TextField
        label="Senha do arquivo"
        type="password"
        autoComplete="off"
        value={password}
        onChange={setPassword}
        hint="A senha que o projeto tinha quando o backup foi feito. O projeto restaurado usa a mesma."
      />
      <TextField
        label="Nome do projeto novo"
        value={name}
        onChange={setName}
        maxLength={80}
        hint="Em branco, usa o nome do arquivo seguido de “(restaurado)”."
      />
      <Caption>
        O arquivo é conferido inteiro antes de qualquer coisa ser criada: um arquivo ruim não cria nada.
      </Caption>
    </SettingsDialog>
  );
}
