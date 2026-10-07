/**
 * Projeto: the name (sealed in this browser, renamed through the vault) and who takes part. The members are
 * kept in Contas e cartões, so this tab only shows them and leads there.
 */
import { Button, ElidedText, TextField, notify } from "@opesvault/ui";
import { Users } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useGoTo } from "../../data/navigation.ts";
import { useLedger, useWorkspace } from "../../data/react.tsx";
import { messageOfFailure } from "../../dialogs/settings_form.tsx";
import { useSession, useSessionActions } from "../../session.tsx";
import { memberRows } from "../contas/rows.ts";
import { Block, Note, TabColumn } from "./parts.tsx";
import { READ_ONLY_TIP } from "../../data/read_only.ts";

export function ProjectTab() {
  const session = useSession();
  const actions = useSessionActions();
  const go = useGoTo();
  const readOnly = useWorkspace().readOnly;
  const members = useLedger(memberRows, "members");
  const current = session.open?.project.name ?? "";
  const accounts = session.open?.project.members ?? 0;
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The field follows the project's name when it changes from elsewhere (another device renamed it).
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    setSeen(current);
    setName(current);
  }

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    const typed = name.trim();
    if (!typed) {
      setError("Dê um nome ao projeto.");
      return;
    }
    if (typed === current) return;
    setBusy(true);
    setError(null);
    try {
      await actions.renameProject(typed);
      notify("Projeto renomeado.", { tone: "positive" });
    } catch (failure) {
      setError(messageOfFailure(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <TabColumn>
      <Block
        title="Nome do projeto"
        scope="project"
        description="O nome é cifrado neste navegador com a chave do projeto: o servidor nunca o lê. Todos os integrantes veem o novo nome."
      >
        <form onSubmit={(event) => void rename(event)} className="flex flex-col gap-3 tablet:flex-row tablet:items-end">
          <TextField
            label="Nome do projeto"
            value={name}
            onChange={(value) => {
              setName(value);
              setError(null);
            }}
            maxLength={80}
            error={error}
            disabled={readOnly}
            title={readOnly ? READ_ONLY_TIP : undefined}
            fieldClassName="tablet:max-w-[420px] tablet:flex-1"
          />
          <Button
            type="submit"
            busy={busy}
            disabled={readOnly || name.trim() === current}
            title={readOnly ? READ_ONLY_TIP : undefined}
          >
            Renomear
          </Button>
        </form>
        <Note>Renomear não entra no histórico de desfazer: é um nome do projeto, não um lançamento.</Note>
      </Block>

      <Block
        title="Integrantes"
        scope="project"
        description="Quem aparece nos rateios e no histórico. O papel identifica a pessoa, não dá acesso: o acesso é a senha do projeto."
        actions={
          <Button icon={<Users className="size-4" />} onClick={() => go("contas", { ref: "integrantes" })}>
            Gerir integrantes em Contas e cartões
          </Button>
        }
      >
        {members.length === 0 ? (
          <Note>Nenhum integrante cadastrado ainda.</Note>
        ) : (
          <ul aria-label="Integrantes do projeto" className="grid gap-2 tablet:grid-cols-2">
            {members.map((member) => (
              <li
                key={member.id}
                className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-window px-3 py-2 text-body"
              >
                <ElidedText className="font-medium">{member.name}</ElidedText>
                <span className="shrink-0 text-caption text-secondary">
                  {member.role} · {member.status}
                </span>
              </li>
            ))}
          </ul>
        )}
        {accounts > 0 ? (
          <Note>
            {accounts === 1 ? "1 conta tem" : `${accounts} contas têm`} acesso a este projeto no servidor. Quem entra
            com a senha do projeto lê e altera tudo.
          </Note>
        ) : null}
      </Block>
    </TabColumn>
  );
}
