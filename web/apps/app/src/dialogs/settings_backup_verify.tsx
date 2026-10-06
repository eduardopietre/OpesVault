/**
 * Verificar arquivo de backup (desktop "Verificar backup"): decrypts the whole file and checks it without
 * restoring anything: password, every block's integrity, the counts, the documents the records cite and their
 * hashes. The result says in words what the file holds and whether it can be trusted.
 */
import { TextField } from "@opesvault/ui";
import { useRef, useState } from "react";
import { formatDateTimeBr } from "../pages/configuracoes/rows.ts";
import type { BackupCheck, BackupProgress } from "../services/types.ts";
import { useServices } from "../session.tsx";
import { Caption } from "./livro_form.tsx";
import { progressText, sizeText } from "./settings_backup_export.tsx";
import { SettingsDialog } from "./settings_form.tsx";

/** The sentence that says whether a checked file is sound, and what is missing from it. */
export function verdict(check: BackupCheck): { ok: boolean; text: string }[] {
  const lines: { ok: boolean; text: string }[] = [
    { ok: true, text: "Todos os blocos foram decifrados e conferidos: o arquivo está íntegro e completo." },
  ];
  if (check.missing > 0) {
    lines.push({
      ok: false,
      text:
        check.missing === 1
          ? "1 documento não estava no servidor quando o backup foi feito e ficou de fora."
          : `${check.missing} documentos não estavam no servidor quando o backup foi feito e ficaram de fora.`,
    });
  }
  if (check.dangling > 0) {
    lines.push({
      ok: false,
      text:
        check.dangling === 1
          ? "1 registro cita um documento que não está no arquivo."
          : `${check.dangling} registros citam documentos que não estão no arquivo.`,
    });
  }
  if (check.hashMismatches > 0) {
    lines.push({
      ok: false,
      text:
        check.hashMismatches === 1
          ? "1 documento não confere com o registro dele (o conteúdo é diferente do original)."
          : `${check.hashMismatches} documentos não conferem com os registros deles.`,
    });
  }
  if (check.orphans > 0)
    lines.push({ ok: true, text: `${check.orphans} documento(s) no arquivo sem registro que os cite.` });
  return lines;
}

export function BackupCheckSummary({ check }: { check: BackupCheck }) {
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
        <dt className="text-secondary">Projeto</dt>
        <dd className="min-w-0 break-words font-medium">{check.projectName}</dd>
        <dt className="text-secondary">Feito em</dt>
        <dd>{formatDateTimeBr(check.createdAt)}</dd>
        <dt className="text-secondary">Registros</dt>
        <dd>{check.records}</dd>
        <dt className="text-secondary">Documentos</dt>
        <dd>
          {check.documents} ({sizeText(check.documentBytes)})
        </dd>
        <dt className="text-secondary">Arquivo</dt>
        <dd>
          {sizeText(check.fileBytes)}, formato {check.version}, Argon2id {Math.round(check.kdf.memoryKiB / 1024)} MiB ×{" "}
          {check.kdf.iterations}
        </dd>
      </dl>
      <ul className="flex flex-col gap-1.5 text-body" aria-label="Resultado da verificação">
        {verdict(check).map((line) => (
          <li key={line.text} className={line.ok ? "text-text" : "font-medium text-warning"}>
            <span className="font-semibold">{line.ok ? "Confere: " : "Atenção: "}</span>
            {line.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function VerifyBackupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const services = useServices();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [check, setCheck] = useState<BackupCheck | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const close = () => {
    setFile(null);
    setPassword("");
    setProgress(null);
    setCheck(null);
    onClose();
  };
  if (check) {
    return (
      <SettingsDialog
        open={open}
        onClose={close}
        title="Arquivo verificado"
        description="Nada foi restaurado nem alterado: o arquivo só foi lido e conferido."
        confirmLabel="Fechar"
        closeOnly
        onConfirm={close}
        extraActions={null}
      >
        <BackupCheckSummary check={check} />
      </SettingsDialog>
    );
  }
  return (
    <SettingsDialog
      open={open}
      onClose={close}
      title="Verificar arquivo de backup"
      description="Decifra o arquivo inteiro e confere se está íntegro, sem restaurar nada."
      confirmLabel="Verificar"
      size="sm"
      confirmDisabled={file === null || password === ""}
      busyText={progressText(progress)}
      onConfirm={async () => {
        if (!file) return;
        const result = await services.verifyBackup(file, password, setProgress);
        setPassword("");
        setCheck(result);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="backup-verify-file" className="text-body font-medium">
          Arquivo de backup
        </label>
        <input
          ref={picker}
          id="backup-verify-file"
          type="file"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className="block w-full min-w-0 rounded-md border border-separator-strong bg-raised p-1.5 text-body file:mr-3 file:rounded-sm file:border-0 file:bg-accent-soft file:px-3 file:py-1 file:text-body file:font-medium file:text-accent"
        />
        <p className="text-caption text-secondary">
          {file ? `${file.name} · ${sizeText(file.size)}` : "O arquivo é lido neste navegador e não é enviado."}
        </p>
      </div>
      <TextField
        label="Senha do arquivo"
        type="password"
        autoComplete="off"
        value={password}
        onChange={setPassword}
        hint="A senha que o projeto tinha quando o backup foi feito."
      />
      <Caption>Arquivos grandes levam um pouco: cada bloco é decifrado e conferido.</Caption>
    </SettingsDialog>
  );
}
