/**
 * Segurança: the project password, the recovery key, the idle lock and locking now (desktop "Trocar senha…" and
 * "Ocultar o conteúdo após", docs/19 §9 and §10). The password and the key are the project's (every member);
 * the idle lock is this device's, written at once, and on the web it erases the key from the tab (it does not
 * only hide the window).
 */
import { Button, Select, notify, usePreferences } from "@opesvault/ui";
import { KeyRound, Lock, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ChangePasswordDialog } from "../../dialogs/settings_password.tsx";
import { RegenerateRecoveryDialog } from "../../dialogs/settings_regenerate.tsx";
import { IDLE_LOCK_CHOICES, IDLE_LOCK_KEY, readIdleLock } from "../../preferences.ts";
import { useServices, useSessionActions } from "../../session.tsx";
import { Block, Note, TabColumn } from "./parts.tsx";
import { IDLE_WORDS } from "./rows.ts";

export function SecurityTab() {
  const services = useServices();
  const actions = useSessionActions();
  const preferences = usePreferences();
  const [dialog, setDialog] = useState<"password" | "key" | null>(null);
  const [idle, setIdle] = useState(() => readIdleLock(preferences));

  const chooseIdle = (id: string) => {
    const minutes = Number(id);
    setIdle(minutes);
    preferences.set(IDLE_LOCK_KEY, String(minutes));
    services.setIdleLock(minutes);
    notify(`O projeto bloqueia após ${IDLE_WORDS[minutes] ?? `${minutes} minutos`} sem uso neste aparelho.`);
  };

  return (
    <TabColumn>
      <Block
        title="Senha do projeto"
        scope="project"
        description="A senha é a mesma para todos os integrantes e cifra tudo neste navegador antes de sincronizar. Ao trocá-la, todos passam a usar a nova. Backups feitos antes continuam com a senha antiga."
        actions={
          <Button icon={<KeyRound className="size-4" />} onClick={() => setDialog("password")}>
            Trocar senha…
          </Button>
        }
      >
        <Note>
          Trocar a senha não expulsa quem já a conhecia: quem guardou uma cópia antiga e sabe a senha antiga ainda
          alcança aquela cópia. Se a senha vazou, troque-a e considere criar um projeto novo.
        </Note>
      </Block>

      <Block
        title="Chave de recuperação"
        scope="project"
        description="Se a senha for esquecida, só a chave de recuperação abre o projeto. Ela foi mostrada uma vez, quando o projeto foi criado, e não fica guardada em lugar nenhum. Gerar uma nova invalida a anterior."
        actions={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => setDialog("key")}>
            Gerar nova chave…
          </Button>
        }
      />

      <Block
        title="Bloqueio por inatividade"
        scope="device"
        description="Depois desse tempo sem usar o teclado, o mouse ou a tela, o projeto é bloqueado: a chave sai da memória da aba e a senha é pedida de novo. O que ainda não foi enviado continua guardado cifrado."
        actions={
          <Button icon={<Lock className="size-4" />} onClick={() => void actions.lock()}>
            Bloquear agora
          </Button>
        }
      >
        <Select
          label="Bloquear após"
          options={IDLE_LOCK_CHOICES.map((minutes) => ({
            id: String(minutes),
            label: IDLE_WORDS[minutes] ?? `${minutes} minutos`,
          }))}
          value={String(idle)}
          onChange={chooseIdle}
          className="tablet:w-[240px]"
          hint="Gravado na hora, só neste aparelho. Não há opção de desligar: a chave fica na aba enquanto o projeto está aberto."
        />
      </Block>

      <ChangePasswordDialog open={dialog === "password"} onClose={() => setDialog(null)} />
      <RegenerateRecoveryDialog open={dialog === "key"} onClose={() => setDialog(null)} />
    </TabColumn>
  );
}
