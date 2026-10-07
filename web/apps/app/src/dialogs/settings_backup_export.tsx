/**
 * Fazer backup agora (docs/19 §13.3, desktop "Fazer backup agora"): a file with the whole project, records and
 * documents, sealed in this browser with the project password (asked again, so a file is never protected by a
 * mistyped one). The result is offered as a download; nothing is uploaded.
 */
import { Button, TextField, saveFile } from "@opesvault/ui";
import { Download } from "lucide-react";
import { useState } from "react";
import type { BackupFile, BackupProgress } from "../services/types.ts";
import { useServices } from "../session.tsx";
import { Caption } from "./livro_form.tsx";
import { SettingsDialog } from "./settings_form.tsx";

export interface ExportBackupDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called once the file exists (the page records the day of the backup). */
  onDone: (file: BackupFile) => void;
}

export function progressText(progress: BackupProgress | null): string {
  if (!progress) return "Preparando o backup…";
  const of = progress.total > 0 ? ` de ${progress.total}` : "";
  switch (progress.phase) {
    case "records":
      return `Gravando registros: ${progress.done}${of}…`;
    case "documents":
      return `Gravando documentos: ${progress.done}${of}…`;
    case "checking":
      return `Conferindo registros: ${progress.done}…`;
    case "restoring":
      return `Restaurando registros: ${progress.done}${of}…`;
  }
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${units[unit]}`;
}

export function ExportBackupDialog({ open, onClose, onDone }: ExportBackupDialogProps) {
  const services = useServices();
  const [password, setPassword] = useState("");
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [file, setFile] = useState<BackupFile | null>(null);
  const close = () => {
    setPassword("");
    setProgress(null);
    setFile(null);
    onClose();
  };
  if (file) {
    return (
      <SettingsDialog
        open={open}
        onClose={close}
        title="Backup pronto"
        description="O arquivo foi oferecido para download. Guarde-o fora deste aparelho, num pendrive ou num disco seu."
        confirmLabel="Fechar"
        closeOnly
        onConfirm={close}
        extraActions={
          <Button icon={<Download className="size-4" />} onClick={() => saveFile(file.fileName, file.blob)}>
            Baixar de novo
          </Button>
        }
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
          <dt className="text-secondary">Arquivo</dt>
          <dd className="min-w-0 break-all font-medium">{file.fileName}</dd>
          <dt className="text-secondary">Tamanho</dt>
          <dd>{sizeText(file.blob.size)}</dd>
          <dt className="text-secondary">Registros</dt>
          <dd>{file.records}</dd>
          <dt className="text-secondary">Documentos</dt>
          <dd>{file.documents}</dd>
        </dl>
        {file.missing > 0 ? (
          <p role="note" className="rounded-md bg-warning-soft px-3 py-2 text-body text-warning">
            {file.missing === 1
              ? "1 documento citado pelos registros não estava no servidor e ficou de fora."
              : `${file.missing} documentos citados pelos registros não estavam no servidor e ficaram de fora.`}
          </p>
        ) : null}
        <Caption>
          O arquivo não mostra nada sem a senha, nem o nome do projeto. Confira-o de vez em quando com “Verificar
          arquivo…”.
        </Caption>
      </SettingsDialog>
    );
  }
  return (
    <SettingsDialog
      open={open}
      onClose={close}
      title="Fazer backup agora"
      description="Um arquivo cifrado com todo o projeto, lançamentos e documentos, protegido pela senha do projeto."
      confirmLabel="Gerar backup"
      size="sm"
      confirmDisabled={password === ""}
      busyText={progressText(progress)}
      onConfirm={async () => {
        const made = await services.exportBackup(password, setProgress);
        setPassword("");
        saveFile(made.fileName, made.blob);
        onDone(made);
        setFile(made);
      }}
    >
      <TextField
        label="Senha do projeto"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        hint="É a que protege o arquivo. Quem tiver o arquivo e a senha abre tudo, então guarde os dois em lugares diferentes."
        data-autofocus=""
      />
      <Caption>Tudo acontece neste navegador: a senha e o arquivo não passam pelo servidor.</Caption>
    </SettingsDialog>
  );
}
