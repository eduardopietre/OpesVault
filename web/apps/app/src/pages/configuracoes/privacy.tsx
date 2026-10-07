/**
 * Privacidade deste aparelho (desktop "Privacidade deste computador", docs/19 §8): what this browser keeps,
 * whether the browser may erase it, and "Esquecer este aparelho", which erases the local copy and the device
 * preferences and ends the session. The password and the keys are never among the things kept.
 */
import { Badge, Button, notify, usePreferences, formatBytes } from "@opesvault/ui";
import { useNavigate } from "@tanstack/react-router";
import { ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { askForgetDevice } from "../../dialogs/settings_forget.ts";
import { useServices, useSessionActions } from "../../session.tsx";
import { useTheme } from "../../theme.tsx";
import { readStorage, requestPersist, type StorageInfo } from "./device.ts";
import { Block, Note, TabColumn } from "./parts.tsx";
import { persistWords } from "./rows.ts";

const KEPT: readonly { title: string; text: string }[] = [
  {
    title: "Cópia cifrada do projeto (IndexedDB)",
    text: "Cada registro e a lista de alterações ainda não enviadas, só em texto cifrado. Sem a senha do projeto isso não abre; é o que deixa o projeto abrir sem conexão.",
  },
  {
    title: "Preferências deste aparelho",
    text: "Aparência, barra lateral, seções recolhidas, porta do Ollama, tempo do bloqueio e o dia do último backup. Nada do conteúdo do projeto.",
  },
  {
    title: "Rótulo desta aba",
    text: "Um texto aleatório (sessionStorage) que faz uma aba recarregada recuperar a própria vez de editar. Some quando a aba fecha.",
  },
  {
    title: "Sessão da conta",
    text: "Um cookie que o navegador guarda e o aplicativo não consegue ler. Termina ao sair da conta.",
  },
];

export function PrivacyTab() {
  const services = useServices();
  const actions = useSessionActions();
  const preferences = usePreferences();
  const navigate = useNavigate();
  const { setTheme } = useTheme();
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const count = preferences.keys?.().length ?? 0;

  useEffect(() => {
    let alive = true;
    void readStorage().then((info) => alive && setStorage(info));
    return () => {
      alive = false;
    };
  }, []);

  const protect = async () => {
    setAsking(true);
    const persist = await requestPersist();
    setStorage(await readStorage());
    setAsking(false);
    notify(
      persist === "yes" ? "O navegador vai manter a cópia deste aparelho." : "O navegador não concedeu a proteção.",
      {
        tone: persist === "yes" ? "positive" : "warning",
      },
    );
  };

  const forget = async () => {
    setBusy(true);
    try {
      // Sends what is waiting first, so the question says what would really be lost.
      const pending = await services.pendingChanges();
      if (!(await askForgetDevice(pending))) return;
      await actions.forgetDevice();
      preferences.clear?.();
      setTheme("system");
      await navigate({ to: "/boas-vindas" });
      notify("Este aparelho foi esquecido.");
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : "Não foi possível esquecer este aparelho.", {
        tone: "negative",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <TabColumn>
      <Block
        title="O que este navegador guarda"
        scope="device"
        description="Nada em texto claro: a senha, as chaves, os lançamentos e os documentos nunca vão para o disco sem cifra."
      >
        <dl className="flex flex-col gap-3">
          {KEPT.map((item) => (
            <div key={item.title} className="min-w-0">
              <dt className="text-body font-medium">{item.title}</dt>
              <dd className="max-w-[68ch] text-body text-secondary">{item.text}</dd>
            </div>
          ))}
        </dl>
        <Note>
          {count === 0
            ? "Nenhuma preferência guardada neste aparelho agora."
            : `${count} ${count === 1 ? "preferência guardada" : "preferências guardadas"} neste aparelho agora.`}
        </Note>
      </Block>

      <Block
        title="Armazenamento protegido"
        scope="device"
        description="Por padrão o navegador pode apagar os dados de um site quando falta espaço. Pedir a proteção faz ele manter a cópia deste aparelho."
        actions={
          storage?.persist === "no" ? (
            <Button icon={<ShieldCheck className="size-4" />} busy={asking} onClick={() => void protect()}>
              Pedir proteção
            </Button>
          ) : null
        }
      >
        <div role="status" className="flex flex-wrap items-start gap-3 rounded-md bg-window px-3 py-2.5 text-body">
          {storage === null ? (
            <span className="text-secondary">Verificando o armazenamento…</span>
          ) : (
            <>
              <Badge tone={storage.persist === "yes" ? "positive" : "warning"}>
                {storage.persist === "yes"
                  ? "Protegido"
                  : storage.persist === "no"
                    ? "Não protegido"
                    : "Sem informação"}
              </Badge>
              <div className="min-w-0 flex-1">
                <p>{persistWords(storage.persist)}</p>
                {storage.usage !== null && storage.quota !== null ? (
                  <p className="text-caption text-secondary">
                    Este site usa {formatBytes(storage.usage)} de {formatBytes(storage.quota)} disponíveis.
                  </p>
                ) : null}
              </div>
            </>
          )}
        </div>
      </Block>

      <Block
        title="Esquecer este aparelho"
        scope="device"
        description="Bloqueia o projeto, apaga a cópia cifrada e as preferências deste navegador e encerra a sessão da conta aqui. O projeto continua no servidor e abre de novo com a senha. Use em um aparelho emprestado ou antes de vendê-lo."
        actions={
          <Button variant="danger" icon={<Trash2 className="size-4" />} busy={busy} onClick={() => void forget()}>
            Esquecer este aparelho…
          </Button>
        }
      >
        <Note>
          Se houver alterações ainda não enviadas, o aplicativo tenta enviá-las antes e avisa quantas ainda se
          perderiam.
        </Note>
      </Block>
    </TabColumn>
  );
}
