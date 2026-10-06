/**
 * Welcome, sign in and sign up (docs/18 §6, "Início, login e criação"). The forms validate as the user
 * types and call the session actions; the password is checked against its confirmation before the button
 * enables (docs/16 §3). Errors from the services appear inside the form.
 */
import { Button, TextField } from "@opesvault/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { USE_FAKE_SERVICES } from "../flags.ts";
import { DEMO_ACCOUNT as DEMO } from "../services/demo_account.ts";
import { useSessionActions } from "../session.tsx";
import { AuthLayout } from "./AuthLayout.tsx";

export const MIN_PASSWORD = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function messageOf(failure: unknown): string {
  return failure instanceof Error && failure.message ? failure.message : "Algo deu errado. Tente de novo.";
}

export function WelcomeScreen() {
  const navigate = useNavigate();
  return (
    <AuthLayout>
      <h1 className="text-title font-semibold">Boas-vindas ao OpesVault</h1>
      <p className="mt-2 text-body text-secondary">
        Cada projeto guarda lançamentos, contas, investimentos e documentos cifrados com a senha do projeto. O servidor
        nunca vê os dados.
      </p>
      <div className="mt-8 flex flex-col gap-2">
        <Button variant="primary" size="lg" onClick={() => void navigate({ to: "/entrar" })}>
          Entrar
        </Button>
        <Button size="lg" onClick={() => void navigate({ to: "/criar-conta" })}>
          Criar conta
        </Button>
      </div>
    </AuthLayout>
  );
}

export function SignInScreen() {
  const actions = useSessionActions();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailError = tried && !EMAIL.test(email.trim()) ? "Digite um e-mail válido." : null;
  const passwordError = tried && !password ? "Digite a senha da conta." : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!EMAIL.test(email.trim()) || !password) return;
    setBusy(true);
    setError(null);
    try {
      await actions.signIn(email, password);
      await navigate({ to: "/projetos" });
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <form onSubmit={submit} noValidate aria-labelledby="entrar-titulo">
        <h1 id="entrar-titulo" className="text-title font-semibold">
          Entrar
        </h1>
        <p className="mt-1 text-body text-secondary">Com a sua conta, você vê os projetos de que participa.</p>
        <div className="mt-6 flex flex-col gap-4">
          <TextField
            label="E-mail"
            type="email"
            autoComplete="username"
            value={email}
            onChange={setEmail}
            error={emailError}
            autoFocus
          />
          <TextField
            label="Senha da conta"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            error={passwordError}
          />
        </div>
        {error ? (
          <p role="alert" className="mt-4 rounded-md bg-negative-soft px-3 py-2 text-body text-negative">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" size="lg" className="mt-6 w-full" busy={busy}>
          Entrar
        </Button>
        <p className="mt-4 text-center text-body text-secondary">
          Ainda não tem conta?{" "}
          <Link to="/criar-conta" className="font-semibold text-accent hover:underline">
            Criar conta
          </Link>
        </p>
        {USE_FAKE_SERVICES ? (
          <p className="mt-6 rounded-md border border-dashed border-separator-strong px-3 py-2 text-caption text-secondary">
            Versão de demonstração, sem servidor: entre com <strong className="text-text">{DEMO.email}</strong> e a
            senha <strong className="text-text">{DEMO.password}</strong>. A senha do projeto Casa é{" "}
            <strong className="text-text">{DEMO.projectPassword}</strong>.
          </p>
        ) : null}
      </form>
    </AuthLayout>
  );
}

export function SignUpScreen() {
  const actions = useSessionActions();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameError = tried && !name.trim() ? "Digite o seu nome." : null;
  const emailError = tried && !EMAIL.test(email.trim()) ? "Digite um e-mail válido." : null;
  const short = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = name.trim() && EMAIL.test(email.trim()) && password.length >= MIN_PASSWORD && confirm === password;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await actions.signUp({ name, email, password });
      await navigate({ to: "/projetos/novo" });
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <form onSubmit={submit} noValidate aria-labelledby="conta-titulo">
        <h1 id="conta-titulo" className="text-title font-semibold">
          Criar conta
        </h1>
        <p className="mt-1 text-body text-secondary">
          A conta serve para entrar e sincronizar. Os dados de cada projeto são abertos pela senha do projeto.
        </p>
        <div className="mt-6 flex flex-col gap-4">
          <TextField label="Seu nome" autoComplete="name" value={name} onChange={setName} error={nameError} autoFocus />
          <TextField
            label="E-mail"
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
            error={emailError}
          />
          <TextField
            label="Senha da conta"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            hint={`Pelo menos ${MIN_PASSWORD} caracteres. Uma frase longa é mais fácil de lembrar.`}
            error={short ? `Use pelo menos ${MIN_PASSWORD} caracteres.` : null}
          />
          <TextField
            label="Confirme a senha"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
            error={mismatch ? "As senhas não coincidem." : null}
          />
        </div>
        {error ? (
          <p role="alert" className="mt-4 rounded-md bg-negative-soft px-3 py-2 text-body text-negative">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" size="lg" className="mt-6 w-full" busy={busy} disabled={!ready}>
          Criar conta
        </Button>
        <p className="mt-4 text-center text-body text-secondary">
          Já tem conta?{" "}
          <Link to="/entrar" className="font-semibold text-accent hover:underline">
            Entrar
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
