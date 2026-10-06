/**
 * The conversation on screen: one component per kind of item. Messages arrive with a short rise and fade (the
 * motion preset, only fades when the person asks for less motion); the tools the model used are listed in
 * plain language with what each asked; a proposed change shows what will change and how it ended.
 */
import { Badge, Button, Spinner, notify, useMotionPreset } from "@opesvault/ui";
import {
  ArrowUpRight,
  Bot,
  Check,
  CircleAlert,
  Copy,
  Info,
  Search,
  ShieldCheck,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import type { Item } from "./chat.ts";
import type { Problem } from "./reach.ts";

export interface TranscriptProps {
  items: readonly Item[];
  /** Opens the Livro with this `ref`. */
  onLink: (ref: string) => void;
  onSettings: () => void;
  /** Asks again after a failure; undefined when there is nothing to retry. */
  onRetry: (() => void) | undefined;
}

export function Transcript({ items, onLink, onSettings, onRetry }: TranscriptProps) {
  const preset = useMotionPreset();
  const lastProblem = items.findLast((item) => item.kind === "problem")?.id;
  return (
    <ol aria-label="Mensagens da conversa" className="flex flex-col gap-3">
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <motion.li key={item.id} {...preset.enter} className="min-w-0">
            {render(item, { onLink, onSettings, onRetry: item.id === lastProblem ? onRetry : undefined })}
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}

interface Actions {
  onLink: (ref: string) => void;
  onSettings: () => void;
  onRetry: (() => void) | undefined;
}

function render(item: Item, actions: Actions): ReactNode {
  switch (item.kind) {
    case "user":
      return <UserMessage text={item.text} />;
    case "assistant":
      return <AssistantMessage text={item.text} />;
    case "activity":
      return <Activity item={item} />;
    case "change":
      return <Change item={item} />;
    case "links":
      return <Links item={item} onLink={actions.onLink} />;
    case "notice":
      return <Notice tone={item.tone} text={item.text} />;
    case "problem":
      return <ProblemCard problem={item.problem} onSettings={actions.onSettings} onRetry={actions.onRetry} />;
  }
}

// ── messages ─────────────────────────────────────

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[min(44rem,90%)] rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-body break-words whitespace-pre-wrap text-text">
        <span className="sr-only">Você: </span>
        {text}
      </p>
    </div>
  );
}

function Avatar() {
  return (
    <span
      aria-hidden="true"
      className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent max-tablet:size-7"
    >
      <Bot className="size-4" />
    </span>
  );
}

function AssistantMessage({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3 max-tablet:gap-2">
      <Avatar />
      <p className="max-w-[min(46rem,100%)] min-w-0 rounded-2xl rounded-tl-md border border-separator bg-raised px-4 py-2.5 text-body break-words whitespace-pre-wrap text-text shadow-sm">
        <span className="sr-only">Assistente: </span>
        {text}
      </p>
    </div>
  );
}

// ── tools used ───────────────────────────────────

function Activity({ item }: { item: Extract<Item, { kind: "activity" }> }) {
  return (
    <ul aria-label="Ferramentas consultadas" className="flex flex-col gap-1.5 pl-11 max-tablet:pl-9">
      {item.calls.map((call, index) => (
        <li
          key={index}
          data-tool={call.tool}
          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption text-secondary"
        >
          <Search aria-hidden="true" className="size-3.5 shrink-0" />
          <span>
            Consultou <span className="font-medium text-text">{call.label}</span>
            {call.found !== null ? ` · ${call.found} encontrado(s)` : ""}
          </span>
          {call.args.length ? (
            <span className="flex min-w-0 flex-wrap gap-1">
              {call.args.map((arg) => (
                <span key={arg.label} className="max-w-full rounded-full bg-sunken px-2 py-0.5 break-words">
                  {arg.label}: <span className="text-text">{arg.value}</span>
                </span>
              ))}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ── a proposed change ────────────────────────────

const CHANGE = {
  waiting: { tone: "warning", label: "Aguardando a sua aprovação", border: "border-warning/50" },
  applied: { tone: "positive", label: "Aplicada", border: "border-positive/40" },
  refused: { tone: "neutral", label: "Recusada", border: "border-separator" },
  failed: { tone: "negative", label: "Não aplicada", border: "border-negative/40" },
} as const;

function Change({ item }: { item: Extract<Item, { kind: "change" }> }) {
  const state = CHANGE[item.state];
  const Icon =
    item.state === "applied" ? Check : item.state === "refused" ? Undo2 : item.state === "failed" ? X : ShieldCheck;
  return (
    <div className="pl-11 max-tablet:pl-9">
      <section
        aria-label={`Alteração proposta: ${item.summary}`}
        className={`rounded-xl border bg-raised px-4 py-3 shadow-sm ${state.border}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex min-w-0 items-start gap-2 text-body font-semibold break-words text-text">
            <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-secondary" />
            <span className="min-w-0">{item.summary}</span>
          </h3>
          <Badge tone={state.tone}>{state.label}</Badge>
        </div>
        {item.details.length ? (
          <ul className="mt-2 flex flex-col gap-1 pl-6 text-body break-words text-secondary">
            {item.details.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : null}
        {item.line ? (
          <p className="mt-2 pl-6 text-caption break-words text-secondary">
            {item.line}
            {item.state === "applied" ? `${item.line.endsWith(".") ? "" : "."} Ctrl+Z desfaz.` : ""}
          </p>
        ) : null}
      </section>
    </div>
  );
}

// ── shortcuts, notices and problems ──────────────

function Links({ item, onLink }: { item: Extract<Item, { kind: "links" }>; onLink: (ref: string) => void }) {
  return (
    <div
      role="group"
      aria-label="Atalhos sugeridos pelo assistente"
      className="flex flex-wrap gap-2 pl-11 max-tablet:pl-9"
    >
      {item.links.map((link) => (
        <Button
          key={link.ref}
          size="sm"
          icon={<ArrowUpRight />}
          onClick={() => onLink(link.ref)}
          className="max-w-full"
        >
          <span className="truncate">Ver no Livro: {link.label}</span>
        </Button>
      ))}
    </div>
  );
}

const NOTICE = {
  warning: { icon: TriangleAlert, box: "bg-warning-soft text-text", mark: "text-warning" },
  negative: { icon: CircleAlert, box: "bg-negative-soft text-text", mark: "text-negative" },
  info: { icon: Info, box: "bg-sunken text-secondary", mark: "text-secondary" },
} as const;

function Notice({ tone, text }: { tone: keyof typeof NOTICE; text: string }) {
  const { icon: Icon, box, mark } = NOTICE[tone];
  return (
    <div className="pl-11 max-tablet:pl-9">
      <p role="status" className={`flex items-start gap-2 rounded-lg px-3 py-2 text-body break-words ${box}`}>
        <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${mark}`} />
        <span className="min-w-0">{text}</span>
      </p>
    </div>
  );
}

function body(problem: Problem): string {
  switch (problem.kind) {
    case "unreachable":
      return `O Ollama não respondeu em ${problem.url}. Abra o Ollama neste computador e confira se a porta em Configurações › IA local é a mesma em que ele roda.`;
    case "origin":
      return `O Ollama está rodando em ${problem.url}, mas só aceita pedidos de origens liberadas e este aplicativo ainda não está na lista. Acrescente a origem abaixo à variável de ambiente OLLAMA_ORIGINS e reinicie o Ollama.`;
    default:
      return problem.detail;
  }
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify("Origem copiada.");
  } catch {
    notify("Não foi possível copiar; selecione o texto e copie.", { tone: "negative" });
  }
}

function ProblemCard({
  problem,
  onSettings,
  onRetry,
}: {
  problem: Problem;
  onSettings: () => void;
  onRetry: (() => void) | undefined;
}) {
  const settings = problem.kind !== "origin";
  return (
    <div className="pl-11 max-tablet:pl-9">
      <section
        role="alert"
        aria-label={problem.title}
        data-problem={problem.kind}
        className="flex flex-col gap-3 rounded-xl border border-warning/50 bg-warning-soft px-4 py-3"
      >
        <h3 className="flex items-start gap-2 text-body font-semibold text-text">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          <span className="min-w-0">{problem.title}</span>
        </h3>
        <p className="text-body break-words text-text">{body(problem)}</p>
        {problem.kind === "origin" && problem.origin ? (
          <div className="flex flex-col gap-2">
            <pre className="overflow-x-auto rounded-lg bg-sunken px-3 py-2 text-caption text-text">
              <code>{`OLLAMA_ORIGINS=${problem.origin}`}</code>
            </pre>
            <p className="text-caption text-secondary">
              No Windows, em um terminal:{" "}
              <code className="break-all text-text">{`setx OLLAMA_ORIGINS "${problem.origin}"`}</code>, e depois feche e
              abra o Ollama de novo.
            </p>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {problem.kind === "origin" && problem.origin ? (
            <Button size="sm" icon={<Copy />} onClick={() => void copy(problem.origin as string)}>
              Copiar origem
            </Button>
          ) : null}
          {settings ? (
            <Button size="sm" onClick={onSettings}>
              Abrir Configurações
            </Button>
          ) : null}
          {onRetry ? (
            <Button size="sm" variant="primary" onClick={onRetry}>
              Tentar de novo
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

// ── waiting ──────────────────────────────────────

export function Thinking({
  label,
  onCancel,
  cancelling,
}: {
  label: string;
  onCancel: () => void;
  cancelling: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-separator bg-raised px-3 py-2 shadow-sm"
    >
      <span aria-hidden="true" className="flex items-center gap-1">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse"
            style={{ animationDelay: `${dot * 180}ms` }}
          />
        ))}
      </span>
      <span className="min-w-0 flex-1 text-caption text-secondary">{cancelling ? "Cancelando…" : label}</span>
      <Button
        size="sm"
        variant="ghost"
        onClick={onCancel}
        disabled={cancelling}
        icon={cancelling ? <Spinner /> : undefined}
      >
        Cancelar
      </Button>
    </div>
  );
}
