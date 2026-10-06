/**
 * Assistente (desktop `ui/pages/assistant_page.py`, docs/05 §5): questions about the project answered by the
 * local model with the app's own tools. Reads run at once; every change the model proposes opens "Aprovar
 * alteração" and only runs when the person approves it, as one undo step. A wrong answer goes back to the
 * model as an error, three in a row stop the question. The conversation lives only in memory (`chat.ts`).
 */
import { assistant } from "@opesvault/domain";
import { Button, EmptyState, PageHeader, TextField, notify, usePreferences, useMotionPreset } from "@opesvault/ui";
import { Bot, Plus, SendHorizontal, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AI_OFF, AI_PORT_KEY, aiClientFor, aiTransport, portFrom, useAiClient } from "../../data/ai.ts";
import { useGoTo } from "../../data/navigation.ts";
import { useAct, useWorkspace } from "../../data/react.tsx";
import { AssistantApproval } from "../../dialogs/assistant_approval.tsx";
import { chatFor, stoppable, type Deps } from "./chat.ts";
import { hasTaxId, sanitize } from "./labels.ts";
import { Thinking, Transcript } from "./transcript.tsx";

type Pending = assistant.conversation.Pending;

export const EXAMPLES = [
  "Quanto gastei no último mês, por categoria?",
  "Quais foram as maiores despesas deste ano?",
  "Há lançamentos de Uber fora de Transporte?",
] as const;

interface Approval {
  pending: Pending;
  model: string;
  resolve: (approved: boolean) => void;
}

export function Page() {
  const workspace = useWorkspace();
  const goTo = useGoTo();
  const act = useAct();
  const preset = useMotionPreset();
  const preferences = usePreferences();
  const client = useAiClient();
  const chat = useMemo(() => chatFor(workspace, () => workspace.today()), [workspace]);
  useSyncExternalStore(chat.subscribe, chat.getVersion, chat.getVersion);

  const [question, setQuestion] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const empty = workspace.ledger.operations.size === 0;
  const on = client !== null;

  // Leaving the page stops the question: nothing keeps asking the model, or waiting for an approval, unseen.
  useEffect(() => () => chat.cancel(), [chat]);

  // The newest message stays in view.
  const count = chat.items.length;
  useEffect(() => {
    if (count === 0) return;
    end.current?.scrollIntoView?.({ block: "end", behavior: preset.reduce ? "auto" : "smooth" });
  }, [count, chat.stage, preset.reduce]);

  const deps = useCallback(
    (): Deps => ({
      ledger: () => workspace.ledger,
      client: (signal) =>
        aiClientFor(workspace.ledger, portFrom(preferences.get(AI_PORT_KEY)), stoppable(aiTransport(), signal)),
      approve: (pending, model) => new Promise<boolean>((resolve) => setApproval({ pending, model, resolve })),
      act: (action) => act(() => action()),
    }),
    [workspace, preferences, act],
  );

  const settle = (approved: boolean) => {
    const current = approval;
    if (current === null) return;
    setApproval(null);
    current.resolve(approved);
  };

  const send = (text: string) => {
    const asked = text.split(/\s+/).filter(Boolean).join(" ");
    if (chat.busy) {
      notify("O assistente ainda está respondendo.");
      return;
    }
    if (!asked) {
      notify("Escreva uma pergunta.");
      return;
    }
    if (hasTaxId(asked)) {
      notify("Tire o CPF ou CNPJ da pergunta: o assistente não os recebe.", { tone: "negative" });
      return;
    }
    if (!on) {
      notify(AI_OFF);
      return;
    }
    setQuestion("");
    void chat.ask(asked, deps());
  };

  const newConversation = () => {
    if (chat.busy) {
      notify("Aguarde a resposta ou cancele antes de começar outra conversa.");
      return;
    }
    chat.reset();
    setQuestion("");
    input.current?.focus();
  };

  const header = (
    <PageHeader
      title="Assistente"
      context="IA local com ferramentas: consulta o projeto e propõe mudanças que você aprova"
      actions={
        on ? (
          <Button icon={<Plus />} onClick={newConversation} title="Esquece a conversa atual">
            Nova conversa
          </Button>
        ) : undefined
      }
    />
  );

  if (!on) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div className="rounded-xl border border-dashed border-separator-strong bg-window/40">
          <EmptyState
            icon={<Bot />}
            title="Assistente desligado"
            description="Ligue a IA local e escolha um modelo que aceite ferramentas em Configurações › IA local. O aplicativo funciona inteiro sem ela."
            actions={<Button onClick={() => goTo("configuracoes")}>Abrir Configurações</Button>}
          />
        </div>
      </div>
    );
  }

  const running = chat.busy;
  return (
    <div className="flex min-h-[calc(100dvh-7.5rem)] flex-col gap-4 max-tablet:min-h-[calc(100dvh-11.5rem)]">
      {header}
      <p className="max-w-3xl text-caption text-secondary">
        Só o Ollama deste computador participa. O assistente lê o que está no projeto aberto (sem CPF e CNPJ) e cada
        alteração que ele propõe passa pela sua aprovação.
      </p>

      <section aria-label="Conversa com o assistente" role="log" aria-live="polite" className="min-w-0 flex-1">
        {chat.items.length ? (
          <Transcript
            items={chat.items}
            onLink={(ref) => goTo("livro", { ref })}
            onSettings={() => goTo("configuracoes")}
            onRetry={chat.canResume ? () => void chat.resume(deps()) : undefined}
          />
        ) : (
          <motion.div
            {...preset.enter}
            className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-separator-strong bg-window/40 px-4 py-8 text-center"
          >
            <span
              aria-hidden="true"
              className="grid size-10 place-items-center rounded-full bg-accent-soft text-accent"
            >
              <Sparkles className="size-5" />
            </span>
            <h2 className="text-headline font-semibold">Pergunte sobre o projeto</h2>
            <p className="max-w-xl text-body text-secondary">
              {empty
                ? "O projeto ainda não tem lançamentos: o assistente só poderá falar de contas, categorias e integrantes. "
                : ""}
              Ele consulta o que está no projeto, mostra o que usou e, se você pedir uma mudança, propõe e espera a sua
              aprovação.
            </p>
            <div role="group" aria-label="Perguntas de exemplo" className="flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((example) => (
                <Button
                  key={example}
                  size="sm"
                  onClick={() => send(example)}
                  className="max-w-full h-auto! py-1.5 text-left whitespace-normal!"
                >
                  {example}
                </Button>
              ))}
            </div>
          </motion.div>
        )}
        <div ref={end} className="scroll-mb-40 h-px" />
      </section>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-2 bg-content/95 px-4 pt-2 pb-3 backdrop-blur tablet:-mx-6 tablet:px-6 wide:-mx-8 wide:px-8">
        {running ? (
          <Thinking
            label={
              chat.stage === "approving"
                ? "Aguardando a sua decisão sobre a alteração…"
                : `O assistente está pensando… (${client.model})`
            }
            onCancel={() => chat.cancel()}
            cancelling={chat.cancelling}
          />
        ) : null}
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            send(question);
          }}
        >
          <TextField
            ref={input}
            label="Pergunta ao assistente"
            hideLabel
            value={question}
            onChange={setQuestion}
            placeholder="Pergunte ou peça uma mudança"
            autoComplete="off"
            enterKeyHint="send"
            onKeyDown={(event) => {
              // A disabled "Enviar" would swallow Enter: ask here, so Enter while the model works still answers.
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              send(question);
            }}
            fieldClassName="flex-1"
          />
          <Button
            type="submit"
            variant="primary"
            icon={<SendHorizontal />}
            disabled={running}
            title={running ? "Aguarde a resposta ou cancele" : undefined}
          >
            Enviar
          </Button>
        </form>
        <p className="text-caption text-secondary">IA local · {client.model}</p>
      </div>

      {approval ? (
        <AssistantApproval
          open
          summary={sanitize(approval.pending.edit.summary)}
          details={approval.pending.edit.details.map(sanitize)}
          model={approval.model}
          onApprove={() => settle(true)}
          onRefuse={() => settle(false)}
        />
      ) : null}
    </div>
  );
}
