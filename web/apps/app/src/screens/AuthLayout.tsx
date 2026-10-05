/**
 * The frame of the screens before a project is open: the brand and the promise at the side on wide screens,
 * the form in a card. On phones the form takes the screen.
 */
import { useMotionPreset } from "@opesvault/ui";
import { motion } from "motion/react";
import { KeyRound, ServerOff, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { Wordmark } from "../shell/Logo.tsx";

const PROMISES = [
  { icon: <KeyRound />, text: "Senha e chave nunca saem deste navegador." },
  { icon: <ServerOff />, text: "O servidor guarda só registros cifrados." },
  { icon: <WifiOff />, text: "Funciona sem conexão e sincroniza depois." },
];

export function AuthLayout({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const preset = useMotionPreset();
  return (
    <div className="grid min-h-dvh grid-cols-1 bg-window medium:grid-cols-[minmax(360px,5fr)_7fr]">
      <aside className="relative hidden overflow-hidden border-r border-separator bg-content medium:flex medium:flex-col medium:justify-between medium:p-10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-40 -left-40 size-[520px] rounded-full bg-accent-soft opacity-70 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -bottom-48 size-[420px] rounded-full bg-positive-soft opacity-60 blur-3xl"
        />
        <Wordmark className="relative" />
        <div className="relative max-w-[520px]">
          <p className="text-[clamp(28px,2.6vw,40px)] leading-tight font-semibold tracking-[-0.02em] text-balance text-text">
            As finanças do projeto, cifradas de ponta a ponta.
          </p>
          <ul className="mt-8 flex flex-col gap-4">
            {PROMISES.map((item) => (
              <li key={item.text} className="flex items-center gap-3 text-body text-secondary">
                <span
                  aria-hidden="true"
                  className="grid size-9 place-items-center rounded-lg bg-raised text-accent shadow-sm [&_svg]:size-4.5"
                >
                  {item.icon}
                </span>
                {item.text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-caption text-secondary">
          Contas, cartões, investimentos e imposto de renda num só lugar.
        </p>
      </aside>
      <main className="flex min-w-0 flex-col items-center justify-center px-4 py-10 tablet:px-8">
        <Wordmark className="mb-8 medium:hidden" />
        <motion.div
          {...preset.enter}
          className={`w-full ${wide ? "max-w-[640px]" : "max-w-[420px]"} rounded-xl border border-separator bg-raised p-6 shadow-md tablet:p-8`}
        >
          {children}
        </motion.div>
      </main>
    </div>
  );
}
