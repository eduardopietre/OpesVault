/**
 * IA local (desktop "IA local" tab): the Ollama on this computer, optional and only suggesting. It splits as the
 * desktop does (docs/16 §4 rule 8): turning it on and the model are PROJECT settings (`dom.settings`, applied
 * at once, one undo step each, synced); the port is a DEVICE preference (written at once, outside the project).
 * "Verificar Ollama" lists the installed models, says whether the chosen one is there and whether it fits in
 * the GPU. A browser can only reach Ollama if it accepts this page's origin, so the exact `OLLAMA_ORIGINS`
 * line for this app is shown, with the commands for each system.
 */
import { ai, dom } from "@opesvault/domain";
import { Button, Collapsible, Select, Switch, TextField, notify, usePreferences } from "@opesvault/ui";
import { Copy, Stethoscope } from "lucide-react";
import { useState, type FormEvent } from "react";
import { AI_PORT_KEY, aiTransport, portFrom, rememberModel } from "../../data/ai.ts";
import { useAct, useLedger, useWorkspace } from "../../data/react.tsx";
import { Block, Note, TabColumn } from "./parts.tsx";
import { checkedText, originGuide, parsePort } from "./rows.ts";

const READ_ONLY_HINT = "Outra aba ou aparelho está editando este projeto; aqui só leitura.";

function copy(text: string, done: string) {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => notify(done))
    .catch(() => notify("Não foi possível copiar. Selecione o texto e copie.", { tone: "warning" }));
}

function Command({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="text-body font-medium">{label}</h4>
        <Button
          size="sm"
          icon={<Copy className="size-3.5" />}
          aria-label={`Copiar o comando para ${label}`}
          onClick={() => copy(text, "Comando copiado.")}
        >
          Copiar
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md bg-window px-3 py-2 font-mono text-caption whitespace-pre-wrap break-all text-text">
        {text}
      </pre>
    </div>
  );
}

export function AiTab() {
  const act = useAct();
  const readOnly = useWorkspace().readOnly;
  const preferences = usePreferences();
  const settings = useLedger((ledger) => dom.settings.getSettings(ledger), "settings");
  const [model, setModel] = useState(settings.ai_model ?? "");
  const [portText, setPortText] = useState(String(portFrom(preferences.get(AI_PORT_KEY))));
  const [portError, setPortError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<{ text: string; failed: boolean } | null>(null);
  const [installed, setInstalled] = useState<readonly string[]>([]);
  const [guideOpen, setGuideOpen] = useState(false);
  const origin = typeof location === "undefined" ? "" : location.origin;
  const guide = originGuide(origin);
  // An undo or a change from another tab brings the project's model back into the field.
  const [seenModel, setSeenModel] = useState(settings.ai_model);
  if (seenModel !== settings.ai_model) {
    setSeenModel(settings.ai_model);
    setModel(settings.ai_model ?? "");
  }

  const toggle = (enabled: boolean) =>
    act(
      (ledger) => dom.settings.updateSettings(ledger, { ai_enabled: enabled }),
      enabled ? "IA local ligada para o projeto." : "IA local desligada para o projeto.",
    );

  const commitModel = (value: string) => {
    const wanted = value.trim() || null;
    if (wanted === settings.ai_model) return;
    act((ledger) => dom.settings.updateSettings(ledger, { ai_model: wanted }), "Modelo da IA alterado.");
  };

  const commitPort = (): number | null => {
    const port = parsePort(portText);
    if (port === null) {
      setPortError("Use uma porta entre 1024 e 65535.");
      return null;
    }
    setPortError(null);
    if (port !== portFrom(preferences.get(AI_PORT_KEY))) {
      preferences.set(AI_PORT_KEY, port === ai.ollama.DEFAULT_PORT ? null : String(port));
      notify("Porta gravada neste aparelho.");
    }
    return port;
  };

  const check = async () => {
    const port = commitPort();
    if (port === null) return;
    const chosen = model.trim();
    setChecking(true);
    setStatus({ text: "Verificando o Ollama local…", failed: false });
    try {
      const client = new ai.ollama.OllamaClient(
        chosen || ai.ollama.RECOMMENDED_MODELS[0],
        aiTransport(),
        ai.ollama.localUrl(port),
      );
      const info = await client.serverInfo();
      let placed: ai.ollama.Placement | null = null;
      if (chosen && info.installed(chosen) !== null) {
        setStatus({ text: `Carregando ${chosen} para ver se cabe na GPU…`, failed: false });
        await client.warmUp();
        placed = await client.placement();
        rememberModel(client);
      }
      setInstalled(info.models);
      setStatus({ text: checkedText(chosen, info, placed), failed: false });
    } catch (failure) {
      if (failure instanceof ai.ollama.AiUnavailable) {
        setStatus({
          text: `${failure.message} Abra o Ollama e confira se ele aceita este endereço (OLLAMA_ORIGINS, abaixo).`,
          failed: true,
        });
        setGuideOpen(true);
      } else {
        setStatus({ text: "A verificação falhou. Tente de novo.", failed: true });
      }
    } finally {
      setChecking(false);
    }
  };

  const submitPort = (event: FormEvent) => {
    event.preventDefault();
    commitPort();
  };

  return (
    <TabColumn>
      <Block
        title="Sugestões com o Ollama local"
        scope="project"
        description={
          <>
            Sem IA, o aplicativo já sugere categorias pelas suas regras e pelo histórico. A IA local é opcional e só
            sugere: na importação, as categorias que faltarem; no Livro, outra categoria ou nomes legíveis de
            estabelecimentos para os lançamentos escolhidos, sempre conferidos numa lista antes de mudar algo; e, num
            lançamento novo, a categoria pela descrição.
          </>
        }
      >
        <Switch
          label="Usar o Ollama local para sugestões"
          description="Vale para todo o projeto e sincroniza. Desligada por padrão."
          checked={settings.ai_enabled}
          onCheckedChange={toggle}
          disabled={readOnly}
        />
        <Note>
          Só o Ollama em 127.0.0.1 é usado. Vão apenas descrições (e, como exemplo, algumas que você já classificou) e
          nomes de categorias, nunca valores, contas ou pessoas. O aplicativo não baixa modelo nenhum sozinho.
        </Note>
        {settings.ai_enabled ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              commitModel(model);
            }}
            className="flex flex-col gap-3 tablet:flex-row tablet:items-end"
          >
            <TextField
              label="Modelo"
              value={model}
              onChange={setModel}
              onBlur={() => commitModel(model)}
              placeholder={`ex.: ${ai.ollama.RECOMMENDED_MODELS[0]}`}
              spellCheck={false}
              autoComplete="off"
              disabled={readOnly}
              title={readOnly ? READ_ONLY_HINT : undefined}
              hint={`Indicado: ${ai.ollama.RECOMMENDED_MODELS.join(", ")}. Instale com “ollama pull <modelo>”.`}
              fieldClassName="tablet:max-w-[420px] tablet:flex-1"
            />
            {installed.length > 0 ? (
              <Select
                label="Modelo instalado"
                options={installed.map((name) => ({ id: name, label: name }))}
                value={installed.includes(model.trim()) ? model.trim() : null}
                onChange={(name) => {
                  setModel(name);
                  commitModel(name);
                }}
                placeholder="Escolha um instalado…"
                disabled={readOnly}
                className="tablet:w-[240px]"
              />
            ) : null}
          </form>
        ) : null}
      </Block>

      <Block
        title="Ollama neste aparelho"
        scope="device"
        description="Onde o Ollama escuta neste computador e se ele responde. O endereço é sempre 127.0.0.1; só a porta muda."
      >
        <form onSubmit={submitPort} className="flex flex-col gap-3 tablet:flex-row tablet:items-end">
          <TextField
            label="Porta do Ollama"
            value={portText}
            onChange={(value) => {
              setPortText(value);
              setPortError(null);
            }}
            onBlur={commitPort}
            inputMode="numeric"
            error={portError}
            hint="Mude só se o Ollama foi configurado em outra porta (OLLAMA_HOST=127.0.0.1:<porta>). Gravada na hora, neste aparelho."
            fieldClassName="tablet:w-[240px]"
          />
          <Button
            icon={<Stethoscope className="size-4" />}
            busy={checking}
            onClick={() => void check()}
            title="Lista os modelos instalados e vê se o escolhido cabe na GPU"
          >
            Verificar Ollama
          </Button>
        </form>
        {status ? (
          <p
            role="status"
            className={
              status.failed
                ? "rounded-md bg-warning-soft px-3 py-2 text-body text-warning"
                : "rounded-md bg-window px-3 py-2 text-body"
            }
          >
            {status.text}
          </p>
        ) : null}
        <Collapsible
          title="Como liberar este endereço no Ollama (OLLAMA_ORIGINS)"
          level={3}
          open={guideOpen}
          onOpenChange={setGuideOpen}
          description="O navegador só deixa esta página falar com o Ollama se ele aceitar o endereço da página."
        >
          <div className="flex flex-col gap-4">
            <div>
              <p className="text-body">
                O endereço deste aplicativo é{" "}
                <code className="rounded bg-window px-1.5 py-0.5 font-mono">{origin}</code>. Ele é o valor de{" "}
                <code className="font-mono">OLLAMA_ORIGINS</code>, exatamente assim, sem barra no fim.
              </p>
              <div className="mt-2">
                <Button
                  size="sm"
                  icon={<Copy className="size-3.5" />}
                  onClick={() => copy(guide.origin, "Endereço copiado.")}
                >
                  Copiar o endereço
                </Button>
              </div>
            </div>
            <Command label="Windows (PowerShell)" text={guide.windows} />
            <Command label="macOS (Terminal)" text={guide.mac} />
            <Command label="Linux (systemd)" text={guide.linux} />
            <Note>
              Depois de definir a variável, feche e abra o Ollama de novo e use “Verificar Ollama”. Se o navegador pedir
              permissão para acessar serviços neste computador, permita: é o Ollama em 127.0.0.1. Nada disso sai do seu
              aparelho.
            </Note>
          </div>
        </Collapsible>
      </Block>
    </TabColumn>
  );
}
