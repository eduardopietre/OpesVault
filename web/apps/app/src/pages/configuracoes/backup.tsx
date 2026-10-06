/**
 * Backup e salvamento (desktop "Backup e salvamento", docs/03 §7, docs/19 §13): saving is automatic on the web
 * (every change is sealed and synced), so what is left here is the backup FILE: make one, check one, restore
 * one as a new project. The day of the last backup made on this device feeds the reminder in Visão geral.
 */
import { Badge, Button, usePreferences } from "@opesvault/ui";
import { Download, FileCheck2, History } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useWorkspace } from "../../data/react.tsx";
import { ExportBackupDialog } from "../../dialogs/settings_backup_export.tsx";
import { RestoreBackupDialog } from "../../dialogs/settings_backup_restore.tsx";
import { VerifyBackupDialog } from "../../dialogs/settings_backup_verify.tsx";
import { useSession, useSessionActions } from "../../session.tsx";
import { readLastBackup, writeLastBackup } from "./backup_state.ts";
import { Block, Note, TabColumn } from "./parts.tsx";
import { backupStatus } from "./rows.ts";

export function BackupTab() {
  const preferences = usePreferences();
  const workspace = useWorkspace();
  const projectId = useSession().open?.project.id ?? "";
  const actions = useSessionActions();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<"export" | "verify" | "restore" | null>(null);
  const [last, setLast] = useState(() => readLastBackup(preferences, projectId));
  const status = backupStatus(last, workspace.today());

  return (
    <TabColumn>
      <Block
        title="Backup do projeto"
        scope="device"
        description="Um arquivo único com todo o projeto, lançamentos e documentos, cifrado neste navegador com a senha do projeto. Ele abre offline, sem o servidor, e não mostra nada sem a senha, nem o nome do projeto."
        actions={
          <>
            <Button variant="primary" icon={<Download className="size-4" />} onClick={() => setDialog("export")}>
              Fazer backup agora…
            </Button>
            <Button icon={<FileCheck2 className="size-4" />} onClick={() => setDialog("verify")}>
              Verificar arquivo…
            </Button>
            <Button icon={<History className="size-4" />} onClick={() => setDialog("restore")}>
              Restaurar backup…
            </Button>
          </>
        }
      >
        <div
          role="status"
          className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-md bg-window px-3 py-2.5 text-body"
        >
          <Badge tone={status.tone}>{status.tone === "positive" ? "Em dia" : "Faça um backup"}</Badge>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{status.title}</p>
            <p className="text-caption text-secondary">{status.detail}</p>
          </div>
        </div>
        <Note>
          O aplicativo lembra na Visão geral quando o último backup feito neste aparelho passa de 30 dias. Essa
          lembrança é só deste aparelho: um backup feito em outro não protege esta cópia.
        </Note>
      </Block>

      <Block
        title="Como funciona"
        description="O salvamento é automático: cada alteração é cifrada e enviada ao servidor sozinha. O backup é a sua cópia fora do servidor."
      >
        <ul className="flex max-w-[68ch] list-disc flex-col gap-1.5 pl-5 text-body text-secondary">
          <li>
            <strong className="font-semibold text-text">Fazer backup:</strong> pede a senha do projeto de novo, gera o
            arquivo neste navegador e o oferece para baixar. O nome do arquivo não traz o nome do projeto. Precisa ler
            os documentos do servidor, então peça com conexão.
          </li>
          <li>
            <strong className="font-semibold text-text">Verificar arquivo:</strong> decifra o arquivo inteiro e confere
            se está íntegro e completo, sem restaurar nada.
          </li>
          <li>
            <strong className="font-semibold text-text">Restaurar:</strong> cria sempre um projeto novo, com chave de
            recuperação nova; nunca escreve sobre um projeto existente. O novo projeto usa a senha do arquivo.
          </li>
          <li>
            <strong className="font-semibold text-text">Senha:</strong> trocar a senha do projeto não altera backups
            antigos, que continuam com a senha antiga. Quem tem o arquivo pode tentar adivinhar a senha sem limite de
            tentativas; use uma senha longa e guarde o arquivo fora deste aparelho.
          </li>
        </ul>
      </Block>

      <ExportBackupDialog
        open={dialog === "export"}
        onClose={() => setDialog(null)}
        onDone={() => {
          // The day in the family's calendar (the same one the reminder counts in).
          const day = workspace.today();
          writeLastBackup(preferences, projectId, day);
          setLast(day);
        }}
      />
      <VerifyBackupDialog open={dialog === "verify"} onClose={() => setDialog(null)} />
      <RestoreBackupDialog
        open={dialog === "restore"}
        onClose={() => setDialog(null)}
        onOpenProject={async (restored, password) => {
          await actions.openProject(restored.project.id, password);
          await navigate({ to: "/visao-geral" });
        }}
      />
    </TabColumn>
  );
}
