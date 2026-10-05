/**
 * The projects of the account (replaces the desktop's recents and Abrir/Restaurar), creating a project with
 * its shared password and the recovery key shown once (docs/18 §3.2), and the first-run assistant
 * (integrantes, contas, cartões, conclusão).
 */
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ElidedText,
  MoneyField,
  Select,
  Skeleton,
  TextField,
  notify,
  useMotionPreset,
} from "@opesvault/ui";
import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, Copy, FolderPlus, Plus, Trash2, Users } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { ProjectSummary } from "../services/types.ts";
import { useServices, useSession, useSessionActions } from "../session.tsx";
import { AuthLayout } from "./AuthLayout.tsx";
import { MIN_PASSWORD, messageOf } from "./auth.tsx";

function updated(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : `Atualizado em ${date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" })}`;
}

export function ProjectsScreen() {
  const services = useServices();
  const session = useSession();
  const actions = useSessionActions();
  const navigate = useNavigate();
  const preset = useMotionPreset();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [opening, setOpening] = useState<ProjectSummary | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    services
      .listProjects()
      .then((list) => alive && setProjects(list))
      .catch((failure: unknown) => alive && setLoadError(messageOf(failure)));
    return () => {
      alive = false;
    };
  }, [services]);

  const open = async (event: FormEvent) => {
    event.preventDefault();
    if (!opening) return;
    if (!password) {
      setError("Digite a senha do projeto.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await actions.openProject(opening.id, password);
      setOpening(null);
      await navigate({ to: "/visao-geral" });
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout wide>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-title font-semibold">Projetos</h1>
          <p className="mt-1 text-body text-secondary">
            {session.account ? `Conta de ${session.account.name}.` : ""} Escolha um projeto para abrir com a senha dele.
          </p>
        </div>
        <Button
          variant="primary"
          icon={<Plus className="size-4" />}
          onClick={() => void navigate({ to: "/projetos/novo" })}
        >
          Novo projeto
        </Button>
      </div>
      <div className="mt-6" aria-busy={projects === null && !loadError}>
        {loadError ? (
          <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-body text-negative">
            {loadError}
          </p>
        ) : projects === null ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 rounded-lg" />
            <Skeleton className="h-16 rounded-lg" />
          </div>
        ) : projects.length === 0 ? (
          <EmptyState
            icon={<FolderPlus />}
            title="Nenhum projeto ainda"
            description="Um projeto reúne as finanças de uma casa ou de um grupo: integrantes, contas, cartões e documentos, cifrados com uma senha compartilhada."
            className="py-6"
          />
        ) : (
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial>
              {projects.map((project, index) => (
                <motion.li
                  key={project.id}
                  initial={preset.enter.initial}
                  animate={preset.enter.animate}
                  transition={{ ...preset.enter.transition, delay: preset.reduce ? 0 : index * 0.04 }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpening(project);
                      setPassword("");
                      setError(null);
                    }}
                    className="group flex w-full items-center gap-3 rounded-lg border border-separator bg-raised px-4 py-3 text-left shadow-sm transition-[border-color,box-shadow] hover:border-separator-strong hover:shadow-md"
                  >
                    <span
                      aria-hidden="true"
                      className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-headline font-semibold text-accent"
                    >
                      {project.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <ElidedText className="text-body font-semibold">{project.name}</ElidedText>
                      <span className="flex items-center gap-1.5 text-caption text-secondary">
                        <Users aria-hidden="true" className="size-3.5" />
                        {project.members === 1 ? "1 integrante" : `${project.members} integrantes`} ·{" "}
                        {updated(project.updatedAt)}
                      </span>
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className="size-4 text-secondary transition-transform group-hover:translate-x-0.5"
                    />
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
      <div className="mt-6 flex justify-end border-t border-separator pt-4">
        <Button variant="ghost" onClick={() => void actions.signOut().then(() => navigate({ to: "/boas-vindas" }))}>
          Sair da conta
        </Button>
      </div>
      <Dialog
        open={opening !== null}
        onOpenChange={(value) => !value && setOpening(null)}
        title={opening ? `Abrir ${opening.name}` : "Abrir projeto"}
        description="A senha do projeto abre a chave neste navegador. Ela não é enviada ao servidor."
        size="sm"
        onSubmit={open}
        footer={
          <>
            <Button onClick={() => setOpening(null)}>Cancelar</Button>
            <Button type="submit" variant="primary" busy={busy}>
              Abrir projeto
            </Button>
          </>
        }
      >
        <TextField
          label="Senha do projeto"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          error={error}
          autoFocus
        />
      </Dialog>
    </AuthLayout>
  );
}

export function CreateProjectScreen() {
  const services = useServices();
  const actions = useSessionActions();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; key: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const ready = name.trim() !== "" && password.length >= MIN_PASSWORD && confirm === password;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const result = await services.createProject({ name, password });
      setCreated({ id: result.project.id, key: result.recoveryKey });
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const proceed = async () => {
    if (!created) return;
    setBusy(true);
    try {
      await actions.openProject(created.id, password);
      setPassword("");
      setConfirm("");
      await navigate({ to: "/comecar" });
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <AuthLayout wide>
        <h1 className="text-title font-semibold">Guarde a chave de recuperação</h1>
        <p className="mt-2 text-body text-secondary">
          Se a senha do projeto for esquecida, só esta chave abre o projeto. Ela aparece agora e não será mostrada de
          novo. Anote em papel ou guarde num gerenciador de senhas.
        </p>
        <output
          aria-label="Chave de recuperação"
          className="mt-5 grid grid-cols-2 gap-2 rounded-lg border border-separator bg-window p-4 font-mono text-headline tracking-wider tablet:grid-cols-4"
        >
          {created.key.split("-").map((group, index) => (
            <span key={index} className="text-center">
              {group}
            </span>
          ))}
        </output>
        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            icon={<Copy className="size-3.5" />}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(created.key)
                .then(() => notify("Chave copiada. Cole num lugar seguro e limpe a área de transferência."))
                .catch(() => notify("Não foi possível copiar. Anote a chave.", { tone: "warning" }));
            }}
          >
            Copiar chave
          </Button>
        </div>
        <Checkbox
          className="mt-5"
          label="Guardei a chave de recuperação num lugar seguro"
          description="Sem a senha e sem esta chave, ninguém consegue abrir o projeto, nem o servidor."
          checked={saved}
          onCheckedChange={setSaved}
        />
        {error ? (
          <p role="alert" className="mt-4 rounded-md bg-negative-soft px-3 py-2 text-body text-negative">
            {error}
          </p>
        ) : null}
        <Button
          variant="primary"
          size="lg"
          className="mt-6 w-full"
          disabled={!saved}
          busy={busy}
          onClick={() => void proceed()}
        >
          Continuar
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout wide>
      <form onSubmit={submit} noValidate aria-labelledby="novo-titulo">
        <h1 id="novo-titulo" className="text-title font-semibold">
          Novo projeto
        </h1>
        <p className="mt-1 text-body text-secondary">
          A senha do projeto é a mesma para todos os integrantes e cifra tudo neste navegador antes de sincronizar.
        </p>
        <div className="mt-6 flex flex-col gap-4">
          <TextField
            label="Nome do projeto"
            value={name}
            onChange={setName}
            maxLength={80}
            placeholder="Casa, Família Souza…"
            error={tried && !name.trim() ? "Dê um nome ao projeto." : null}
            autoFocus
          />
          <TextField
            label="Senha do projeto"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            hint={`Pelo menos ${MIN_PASSWORD} caracteres. Diferente da senha da conta.`}
            error={
              password.length > 0 && password.length < MIN_PASSWORD
                ? `Use pelo menos ${MIN_PASSWORD} caracteres.`
                : null
            }
          />
          <TextField
            label="Confirme a senha do projeto"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
            error={confirm.length > 0 && confirm !== password ? "As senhas não coincidem." : null}
          />
        </div>
        {error ? (
          <p role="alert" className="mt-4 rounded-md bg-negative-soft px-3 py-2 text-body text-negative">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex flex-col-reverse gap-2 tablet:flex-row tablet:justify-end">
          <Button onClick={() => void navigate({ to: "/projetos" })}>Cancelar</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!ready}>
            Criar projeto
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

// ── first-run assistant ─────────────────────────────────────────────────────

interface SetupAccount {
  name: string;
  kind: string;
  balance: string;
}

interface SetupCard {
  name: string;
  closing: string;
  due: string;
}

export interface SetupData {
  members: string[];
  accounts: SetupAccount[];
  cards: SetupCard[];
}

const STEPS = ["Integrantes", "Contas", "Cartões", "Conclusão"] as const;
const ACCOUNT_KINDS = [
  { id: "corrente", label: "Conta corrente" },
  { id: "poupanca", label: "Poupança" },
  { id: "investimentos", label: "Conta de investimentos" },
  { id: "carteira", label: "Dinheiro em espécie" },
];
const DAYS = Array.from({ length: 31 }, (_, i) => ({ id: String(i + 1), label: `Dia ${i + 1}` }));

/** Fills the new project's first records. The data goes to the domain in W4; now it is only collected. */
export function SetupScreen({ onFinish }: { onFinish?: (data: SetupData) => void }) {
  const session = useSession();
  const navigate = useNavigate();
  const preset = useMotionPreset();
  const [step, setStep] = useState(0);
  const [members, setMembers] = useState<string[]>(() => session.open?.members.map((member) => member.name) ?? []);
  const [member, setMember] = useState("");
  const [accounts, setAccounts] = useState<SetupAccount[]>([]);
  const [account, setAccount] = useState<SetupAccount>({ name: "", kind: "corrente", balance: "" });
  const [cards, setCards] = useState<SetupCard[]>([]);
  const [card, setCard] = useState<SetupCard>({ name: "", closing: "1", due: "10" });

  // A filled-in form counts even without "Adicionar" (docs/16 §5, Assistente).
  const allAccounts = account.name.trim() ? [...accounts, account] : accounts;
  const allCards = card.name.trim() ? [...cards, card] : cards;
  const allMembers = member.trim() ? [...members, member.trim()] : members;

  const finish = () => {
    onFinish?.({ members: allMembers, accounts: allAccounts, cards: allCards });
    notify("Projeto pronto. Bom começo!", { tone: "positive" });
    void navigate({ to: "/visao-geral" });
  };

  const list = (items: string[], remove: (index: number) => void, what: string) =>
    items.length ? (
      <ul className="mb-4 flex flex-col gap-1.5">
        {items.map((item, index) => (
          <li
            key={`${item}-${index}`}
            className="flex items-center justify-between gap-2 rounded-md bg-window px-3 py-1.5 text-body"
          >
            <ElidedText>{item}</ElidedText>
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 className="size-3.5" />}
              onClick={() => remove(index)}
              aria-label={`Remover ${what} ${item}`}
            >
              Remover
            </Button>
          </li>
        ))}
      </ul>
    ) : null;

  return (
    <AuthLayout wide>
      <h1 className="text-title font-semibold">Primeiros passos</h1>
      <ol className="mt-4 flex gap-1.5" aria-label="Etapas">
        {STEPS.map((label, index) => (
          <li
            key={label}
            className="flex min-w-0 flex-1 flex-col gap-1.5"
            aria-current={index === step ? "step" : undefined}
          >
            <span
              className={`h-1 rounded-full ${index <= step ? "bg-accent-fill" : "bg-separator"}`}
              aria-hidden="true"
            />
            <span className={`truncate text-caption ${index === step ? "font-semibold text-text" : "text-secondary"}`}>
              {index + 1}. {label}
            </span>
          </li>
        ))}
      </ol>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={step} {...preset.enter} className="mt-6 min-h-[220px]">
          {step === 0 ? (
            <section aria-labelledby="passo-integrantes">
              <h2 id="passo-integrantes" className="text-headline font-semibold">
                Quem participa do projeto?
              </h2>
              <p className="mt-1 mb-4 text-body text-secondary">
                Integrantes aparecem nos rateios e no histórico. O papel identifica, não dá acesso.
              </p>
              {list(members, (index) => setMembers(members.filter((_, i) => i !== index)), "integrante")}
              <div className="flex items-end gap-2">
                <TextField label="Nome do integrante" value={member} onChange={setMember} fieldClassName="flex-1" />
                <Button
                  disabled={!member.trim()}
                  onClick={() => {
                    setMembers([...members, member.trim()]);
                    setMember("");
                  }}
                >
                  Adicionar
                </Button>
              </div>
            </section>
          ) : step === 1 ? (
            <section aria-labelledby="passo-contas">
              <h2 id="passo-contas" className="text-headline font-semibold">
                Contas
              </h2>
              <p className="mt-1 mb-4 text-body text-secondary">Uma por vez. O saldo de hoje é o ponto de partida.</p>
              {list(
                accounts.map((a) => a.name),
                (index) => setAccounts(accounts.filter((_, i) => i !== index)),
                "conta",
              )}
              <div className="grid grid-cols-1 gap-3 tablet:grid-cols-2">
                <TextField
                  label="Nome da conta"
                  value={account.name}
                  onChange={(value) => setAccount({ ...account, name: value })}
                  placeholder="Banco, corrente"
                />
                <Select
                  label="Tipo"
                  options={ACCOUNT_KINDS}
                  value={account.kind}
                  onChange={(kind) => setAccount({ ...account, kind })}
                />
                <MoneyField
                  label="Saldo hoje"
                  value={account.balance}
                  onChange={(balance) => setAccount({ ...account, balance })}
                />
              </div>
              <Button
                className="mt-3"
                icon={<Plus className="size-4" />}
                disabled={!account.name.trim()}
                onClick={() => {
                  setAccounts([...accounts, account]);
                  setAccount({ name: "", kind: "corrente", balance: "" });
                }}
              >
                Adicionar conta
              </Button>
            </section>
          ) : step === 2 ? (
            <section aria-labelledby="passo-cartoes">
              <h2 id="passo-cartoes" className="text-headline font-semibold">
                Cartões de crédito
              </h2>
              <p className="mt-1 mb-4 text-body text-secondary">
                Fechamento e vencimento definem a fatura de cada compra.
              </p>
              {list(
                cards.map((c) => c.name),
                (index) => setCards(cards.filter((_, i) => i !== index)),
                "cartão",
              )}
              <div className="grid grid-cols-1 gap-3 tablet:grid-cols-3">
                <TextField
                  label="Nome do cartão"
                  value={card.name}
                  onChange={(value) => setCard({ ...card, name: value })}
                />
                <Select
                  label="Fechamento"
                  options={DAYS}
                  value={card.closing}
                  onChange={(closing) => setCard({ ...card, closing })}
                />
                <Select
                  label="Vencimento"
                  options={DAYS}
                  value={card.due}
                  onChange={(due) => setCard({ ...card, due })}
                />
              </div>
              <Button
                className="mt-3"
                icon={<Plus className="size-4" />}
                disabled={!card.name.trim()}
                onClick={() => {
                  setCards([...cards, card]);
                  setCard({ name: "", closing: "1", due: "10" });
                }}
              >
                Adicionar cartão
              </Button>
            </section>
          ) : (
            <section aria-labelledby="passo-fim">
              <h2 id="passo-fim" className="text-headline font-semibold">
                Tudo pronto para começar
              </h2>
              <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
                {[
                  ["Integrantes", allMembers.length],
                  ["Contas", allAccounts.length],
                  ["Cartões", allCards.length],
                ].map(([label, count]) => (
                  <div key={label} className="rounded-lg bg-window px-3 py-4">
                    <dt className="text-caption text-secondary">{label}</dt>
                    <dd className="text-figure font-semibold">{count}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-4 text-body text-secondary">
                Dá para completar tudo depois em Contas e cartões. O próximo passo costuma ser importar um extrato.
              </p>
            </section>
          )}
        </motion.div>
      </AnimatePresence>
      <div className="mt-6 flex flex-col-reverse gap-2 border-t border-separator pt-4 tablet:flex-row tablet:justify-between">
        <Button variant="ghost" onClick={() => (step === 0 ? finish() : setStep(step - 1))}>
          {step === 0 ? "Pular o assistente" : "Voltar"}
        </Button>
        {step < STEPS.length - 1 ? (
          <Button variant="primary" onClick={() => setStep(step + 1)}>
            Próximo: {STEPS[step + 1]}
          </Button>
        ) : (
          <Button variant="primary" onClick={finish}>
            Abrir o projeto
          </Button>
        )}
      </div>
    </AuthLayout>
  );
}
