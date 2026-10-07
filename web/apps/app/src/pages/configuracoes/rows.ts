/**
 * Configurações, the parts that need no React (desktop `ui/pages/settings_page.py`): the sections and where a
 * link points, the words for where the model runs (`placement_text`), the Ollama check, the `OLLAMA_ORIGINS`
 * guide with this app's exact origin, the backup status and the sizes and dates in Portuguese.
 */
import { ai, daysBetween, formatDateBr, type IsoDate } from "@opesvault/domain";

export const TAB_IDS = ["projeto", "ia", "seguranca", "backup", "privacidade"] as const;
export type TabId = (typeof TAB_IDS)[number];

export const TAB_LABELS: Readonly<Record<TabId, string>> = {
  projeto: "Projeto",
  ia: "IA local",
  seguranca: "Segurança",
  backup: "Backup e salvamento",
  privacidade: "Privacidade deste aparelho",
};

/** The `ref` of a link to Configurações: a section ("ia", "seguranca", "backup", "privacidade", "projeto"). */
export function parseTab(ref: string | undefined): TabId | null {
  return (TAB_IDS as readonly string[]).includes(ref ?? "") ? (ref as TabId) : null;
}

// ── local AI ─────────────────────────────────────

/** Where the loaded model runs, in words; nothing when Ollama did not say (desktop `placement_text`). */
export function placementText(placed: ai.ollama.Placement | null): string {
  if (placed === null) return "";
  const percent = placed.gpuPercent;
  if (percent >= 100) return " O modelo roda inteiro na GPU.";
  if (percent === 0) {
    return " O modelo roda só na CPU: cada consulta leva muitas vezes mais. Um modelo menor pode caber na GPU.";
  }
  return ` Só ${percent}% do modelo coube na GPU; o resto roda na CPU e deixa as consultas bem mais lentas. Um modelo menor pode caber inteiro.`;
}

/** What the check found out, as the sentence under "Verificar Ollama" (desktop `_ai_checked`). */
export function checkedText(chosen: string, info: ai.ollama.ServerInfo, placed: ai.ollama.Placement | null): string {
  const recommended = ai.ollama.RECOMMENDED_MODELS.filter((model) => info.installed(model) !== null);
  const first = ai.ollama.RECOMMENDED_MODELS[0];
  let state: string;
  if (info.models.length === 0) {
    state = `nenhum modelo instalado ainda. Instale o indicado com “ollama pull ${first}”.`;
  } else if (chosen && info.installed(chosen) === null) {
    state = `o modelo ${chosen} não está instalado. Instale com “ollama pull ${chosen}”.`;
  } else if (recommended.length === 0) {
    state = `${info.models.length} modelo(s) instalado(s); o indicado (${first}) não está entre eles.`;
  } else {
    state = `${info.models.length} modelo(s) instalado(s).`;
  }
  return `Ollama ${info.version} respondeu: ${state}${placementText(placed)}`;
}

/** The port as typed, or null when it is not a valid one (desktop range 1024–65535). */
export function parsePort(text: string): number | null {
  const typed = text.trim();
  if (!/^\d{1,5}$/.test(typed)) return null;
  const port = Number(typed);
  return port >= 1024 && port <= 65535 ? port : null;
}

export interface OriginGuide {
  /** What goes in OLLAMA_ORIGINS: this app's origin, exactly (scheme, host and port, no path). */
  origin: string;
  windows: string;
  mac: string;
  linux: string;
}

/** The commands that tell Ollama to accept this app (the browser asks it from this origin). */
export function originGuide(origin: string): OriginGuide {
  return {
    origin,
    windows: `setx OLLAMA_ORIGINS "${origin}"`,
    mac: `launchctl setenv OLLAMA_ORIGINS "${origin}"`,
    linux: `sudo systemctl edit ollama.service\n# no editor que abrir, acrescente:\n[Service]\nEnvironment="OLLAMA_ORIGINS=${origin}"`,
  };
}

// ── backup ───────────────────────────────────────

export interface BackupStatus {
  tone: "positive" | "warning" | "neutral";
  title: string;
  detail: string;
}

/** How the last backup made on this device stands (the reminder appears at `BACKUP_AGE_DAYS`). */
export function backupStatus(last: IsoDate | null, today: IsoDate): BackupStatus {
  if (last === null) {
    return {
      tone: "warning",
      title: "Nenhum backup feito neste aparelho",
      detail: "Faça um backup e guarde o arquivo fora deste aparelho.",
    };
  }
  const age = Math.max(0, daysBetween(today, last));
  const when = age === 0 ? "hoje" : age === 1 ? "ontem" : `há ${age} dias`;
  const old = age >= 30;
  return {
    tone: old ? "warning" : "positive",
    title: `Último backup feito neste aparelho: ${formatDateBr(last)} (${when})`,
    detail: old
      ? "Faz tempo. Faça um novo e confira-o com “Verificar arquivo…”."
      : "Confira o arquivo de vez em quando com “Verificar arquivo…”.",
  };
}

/** "06/10/2026 às 09:30" from an ISO instant, in the browser's time zone. */
export function formatDateTimeBr(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const day = date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const time = date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${day} às ${time}`;
}

// ── this device ──────────────────────────────────

export type PersistState = "yes" | "no" | "unavailable";

export function persistWords(state: PersistState): string {
  switch (state) {
    case "yes":
      return "Protegido: o navegador não apaga a cópia deste aparelho por falta de espaço.";
    case "no":
      return "Não protegido: com pouco espaço, o navegador pode apagar a cópia deste aparelho. O que já foi enviado continua no servidor; alterações ainda não enviadas se perderiam.";
    case "unavailable":
      return "Este navegador não informa nem permite essa proteção.";
  }
}

export const IDLE_WORDS: Readonly<Record<number, string>> = {
  1: "1 minuto",
  5: "5 minutos",
  15: "15 minutos",
  30: "30 minutos",
  60: "1 hora",
  120: "2 horas",
};
