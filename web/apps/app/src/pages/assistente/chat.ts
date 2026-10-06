/**
 * The conversation of the Assistente, step by step, outside React (desktop `assistant_page.py`).
 *
 * The page drives `assistant.conversation.Conversation` the way every AI task does (docs/05 §5): the model is
 * asked in the background and never touches the project; what it answered is read on the UI side, where reads
 * run at once and each proposed change waits for the person (`approve`) and, approved, is applied inside ONE
 * `act` (one undo step). A wrong answer goes back to the model as an error; three in a row stop the question.
 *
 * Nothing here is stored: a `Chat` lives in memory, keyed by the open project's workspace, so it survives
 * leaving the page for the Livro and coming back, and goes away with the project (closing or locking it).
 */
import { Dec, ai, assistant, type IsoDate, type Ledger } from "@opesvault/domain";
import { sanitize, toolLabel, callArguments, parseActivity, livroRef, type CallArgument } from "./labels.ts";
import { explain, type Problem } from "./reach.ts";

type Transport = ai.ollama.Transport;
type OllamaClient = ai.ollama.OllamaClient;
type Pending = assistant.conversation.Pending;
type ModelTurn = ai.ollama.ModelTurn;

/** A tool the model used: what it was, what it asked and, for a read, how many rows it found. */
export interface CallEntry {
  kind: "read" | "invalid";
  tool: string;
  label: string;
  args: CallArgument[];
  found: number | null;
}

export type Item =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "activity"; calls: CallEntry[] }
  | {
      id: number;
      kind: "change";
      /** waiting: the approval is open; applied; refused; failed: approved but the project refused it. */
      state: "waiting" | "applied" | "refused" | "failed";
      summary: string;
      details: readonly string[];
      /** The line the domain gives once it is resolved ("Aplicado: …", "Você recusou: …"). */
      line: string;
    }
  | { id: number; kind: "links"; links: { label: string; ref: string }[] }
  | { id: number; kind: "notice"; tone: "warning" | "negative" | "info"; text: string }
  | { id: number; kind: "problem"; problem: Problem };

/** An item before it gets its id (`Omit` over a union would lose the members). */
type Body<T = Item> = T extends { id: number } ? Omit<T, "id"> : never;

/** What the page lends for one question. */
export interface Deps {
  ledger: () => Ledger;
  /** The client of the open project, its requests tied to `signal`; null when the AI is off. */
  client: (signal: AbortSignal) => OllamaClient | null;
  /** Shows the approval of one change; true when the person approved. */
  approve: (pending: Pending, model: string) => Promise<boolean>;
  /** Runs an action as one user action (one undo step); undefined when the project refused to run it. */
  act: <T>(action: () => T) => T | undefined;
}

/** A transport whose requests stop at once when `signal` is aborted. */
export function stoppable(base: Transport, signal: AbortSignal): Transport {
  return (url, init) => {
    if (signal.aborted) return Promise.reject(new Error("aborted"));
    const own = new AbortController();
    const stop = () => own.abort();
    signal.addEventListener("abort", stop);
    init.signal.addEventListener("abort", stop);
    const aborted = new Promise<never>((_, reject) => {
      own.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    return Promise.race([base(url, { ...init, signal: own.signal }), aborted]).finally(() => {
      signal.removeEventListener("abort", stop);
    });
  };
}

/**
 * The model's message goes back to it in the next request as it came, but a number it wrote with decimals
 * (an amount as `87.4` instead of `"87.40"`) was read as an exact `Dec`, which JSON cannot carry: it is sent
 * back as the text it was. (The arguments the tools validate keep the exact `Dec`.)
 */
export function plainNumbers(value: unknown): unknown {
  if (value instanceof Dec) return value.toString();
  if (Array.isArray(value)) return value.map(plainNumbers);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plainNumbers(inner)]));
  }
  return value;
}

export const NO_TOOLS = (model: string) =>
  `O modelo ${model} não aceita ferramentas. Escolha outro em Configurações › IA local (por exemplo, um modelo qwen).`;

export class Chat {
  items: Item[] = [];
  /** Asking the model (or waiting for an approval). */
  busy = false;
  stage: "idle" | "thinking" | "approving" = "idle";
  cancelling = false;
  /** Bumps at every change, for `useSyncExternalStore`. */
  version = 0;
  conversation: assistant.conversation.Conversation;
  private nextId = 1;
  private controller: AbortController | null = null;
  private waiting: ((approved: boolean) => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private lastModel = "";

  constructor(today: () => IsoDate) {
    this.conversation = new assistant.conversation.Conversation(null, today);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** The model of the last question, for the approval's footer. */
  get model(): string {
    return this.lastModel;
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  private push(item: Body): Item {
    const full = { ...item, id: this.nextId++ } as Item;
    this.items = [...this.items, full];
    return full;
  }

  private replace(id: number, change: Partial<Item>): void {
    this.items = this.items.map((item) => (item.id === id ? ({ ...item, ...change } as Item) : item));
  }

  /** True when there is nothing yet: examples are offered. */
  get empty(): boolean {
    return this.conversation.messages.length === 0 && this.items.length === 0;
  }

  /** The question of a failed first step can be asked again without asking it twice. */
  get canResume(): boolean {
    const last = this.items.at(-1);
    return !this.busy && last?.kind === "problem";
  }

  reset(): void {
    this.cancel();
    this.conversation.reset();
    this.items = [];
    this.emit();
  }

  /** Stops the question at once: the request is dropped and any approval counts as refused. */
  cancel(): void {
    if (!this.busy) return;
    this.cancelling = true;
    this.controller?.abort();
    this.waiting?.(false);
    this.emit();
  }

  ask(text: string, deps: Deps): Promise<void> {
    this.conversation.ask(text);
    this.push({ kind: "user", text });
    this.emit();
    return this.run(deps, true);
  }

  /** Asks the model again after a failure (the question is already in the conversation). */
  resume(deps: Deps): Promise<void> {
    this.items = this.items.filter((item) => item.kind !== "problem");
    this.emit();
    return this.run(deps, true);
  }

  private async run(deps: Deps, first: boolean): Promise<void> {
    if (this.busy) return;
    const controller = new AbortController();
    this.controller = controller;
    this.busy = true;
    this.cancelling = false;
    this.stage = "thinking";
    this.emit();
    try {
      await this.loop(deps, controller, first);
    } finally {
      this.controller = null;
      this.waiting = null;
      this.busy = false;
      this.cancelling = false;
      this.stage = "idle";
      this.emit();
    }
  }

  private cancelled(): void {
    this.push({ kind: "notice", tone: "info", text: "Consulta cancelada." });
  }

  private async loop(deps: Deps, controller: AbortController, first: boolean): Promise<void> {
    const signal = controller.signal;
    const client = deps.client(signal);
    if (client === null) {
      this.push({
        kind: "notice",
        tone: "warning",
        text: "A IA local está desligada ou sem modelo escolhido (Configurações › IA local).",
      });
      return;
    }
    this.lastModel = client.model;
    let checking = first;
    for (;;) {
      const messages = this.conversation.request();
      const tools = this.conversation.tools();
      let turn: ModelTurn;
      try {
        if (checking) {
          await client.checkModel();
          if ((await client.supportsTools()) === false) {
            throw new ai.ollama.AiUnavailable(NO_TOOLS(client.model), { fatal: true });
          }
          checking = false;
        }
        turn = await client.chatTools(ai.prompts.ASSISTANT_SYSTEM, messages, tools);
      } catch (error) {
        if (signal.aborted) {
          this.cancelled();
          return;
        }
        if (!(error instanceof ai.ollama.AiUnavailable)) throw error;
        const problem = await explain(error, client.baseUrl);
        this.push({ kind: "problem", problem });
        return;
      }
      if (signal.aborted) {
        this.cancelled();
        return;
      }
      const step = this.conversation.receive(
        { ...turn, raw: plainNumbers(turn.raw) as ModelTurn["raw"] },
        deps.ledger(),
        client.sourceFor(ai.prompts.ASSISTANT_VERSION),
      );
      this.show(turn, step);
      for (const pending of step.pending) {
        await this.decide(pending, client.model, deps);
      }
      if (step.stop !== null) {
        this.push({ kind: "notice", tone: "negative", text: sanitize(step.stop) });
        return;
      }
      if (step.answer !== null) {
        this.push({ kind: "assistant", text: sanitize(step.answer) });
        return;
      }
      if (signal.aborted) {
        this.cancelled();
        return;
      }
      this.stage = "thinking";
      this.emit();
    }
  }

  /** The transcript of one answer: the tools used, the shortcuts offered, the wrong answers. */
  private show(turn: ModelTurn, step: assistant.conversation.Step): void {
    const calls: CallEntry[] = [];
    const unused = [...turn.tool_calls];
    for (const line of step.activity) {
      const used = parseActivity(line);
      if (used === null) {
        this.flush(calls);
        this.push({ kind: "notice", tone: "warning", text: sanitize(line) });
        continue;
      }
      const at = unused.findIndex((call) => call.name === used.tool);
      const call = at >= 0 ? unused.splice(at, 1)[0] : undefined;
      calls.push({
        kind: "read",
        tool: used.tool,
        label: toolLabel(used.tool),
        args: callArguments(call?.arguments),
        found: used.found,
      });
    }
    this.flush(calls);
    if (step.links.length) {
      this.push({
        kind: "links",
        links: step.links.map(([label, link]) => ({ label, ref: livroRef(link) })),
      });
    }
    this.emit();
  }

  private flush(calls: CallEntry[]): void {
    if (!calls.length) return;
    this.push({ kind: "activity", calls: calls.splice(0) });
  }

  /** One change waits for the person; approved, it runs now as one undo step. */
  private async decide(pending: Pending, model: string, deps: Deps): Promise<void> {
    const item = this.push({
      kind: "change",
      state: "waiting",
      summary: sanitize(pending.edit.summary),
      details: pending.edit.details.map(sanitize),
      line: "",
    });
    this.stage = "approving";
    this.emit();
    const approved = await new Promise<boolean>((resolve) => {
      this.waiting = resolve;
      void deps.approve(pending, model).then(resolve);
    });
    this.waiting = null;
    let line: string;
    if (!approved) {
      line = this.conversation.resolve(pending, false);
    } else {
      const done = deps.act(() => this.conversation.resolve(pending, true));
      if (done === undefined) {
        // The project refused to run it (read-only, another tab editing): the model is told it was not applied.
        this.conversation.resolve(pending, false);
        line = "Não foi possível aplicar: o projeto não aceitou a alteração agora.";
      } else line = done;
    }
    const state = !approved ? "refused" : line.startsWith("Aplicado") ? "applied" : "failed";
    this.replace(item.id, { state, line: sanitize(line) } as Partial<Item>);
    this.stage = "thinking";
    this.emit();
  }
}

const chats = new WeakMap<object, Chat>();

/** The conversation of this open project; the workspace is the key, so a closed or locked project leaves none behind. */
export function chatFor(owner: object, today: () => IsoDate): Chat {
  let chat = chats.get(owner);
  if (chat === undefined) {
    chat = new Chat(today);
    chats.set(owner, chat);
  }
  return chat;
}
