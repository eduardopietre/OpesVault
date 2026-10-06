/**
 * "Atenção": what is due, late or waiting, each notice with the way to resolve it (desktop `AlertsPanel`).
 * Every notice is a link to the place and the action where it is solved; the severity is said in words.
 */
import { dom } from "@opesvault/domain";
import { Badge, Button, useElementWidth, useMotionPreset, type BadgeTone } from "@opesvault/ui";
import { AnimatePresence, motion } from "motion/react";
import { BellRing } from "lucide-react";
import { useState } from "react";
import { alertLink, type Link } from "../../data/links.ts";

/** Notices shown before "Mostrar todos". */
export const MAX_VISIBLE = 6;
/** On a narrow panel (a phone) the first screen shows fewer. */
export const MAX_VISIBLE_COMPACT = 3;
/** Panel width under which the action button sits below the text of the notice. */
const COMPACT_BELOW = 520;

const SEVERITY_WORDS: Readonly<Record<dom.alerts.Severity, string>> = {
  urgent: "Atrasado",
  soon: "Em breve",
  info: "Aguardando",
};
const SEVERITY_TONES: Readonly<Record<dom.alerts.Severity, BadgeTone>> = {
  urgent: "negative",
  soon: "warning",
  info: "neutral",
};

/** "R$ 1.371,50" never breaks between the symbol and the number. */
export function keepTogether(value: string): string {
  return value.replaceAll("R$ ", "R$ ");
}

export interface AlertsPanelProps {
  alerts: readonly dom.alerts.Alert[];
  /** Goes to the place where a notice is resolved. */
  onGo: (link: Link) => void;
  /** Hides the panel until the project is opened again. */
  onHide: () => void;
}

export function AlertsPanel({ alerts, onGo, onHide }: AlertsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [measure, width] = useElementWidth<HTMLElement>();
  const preset = useMotionPreset();
  const compact = width > 0 && width < COMPACT_BELOW;
  const limit = compact ? MAX_VISIBLE_COMPACT : MAX_VISIBLE;
  const shown = expanded ? alerts : alerts.slice(0, limit);
  const seen = new Map<string, number>();
  return (
    <section
      ref={measure}
      aria-label="Atenção"
      className="min-w-0 rounded-xl border border-separator bg-raised p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-2 text-headline font-semibold text-text">
          <BellRing aria-hidden="true" className="size-4 text-warning" />
          Atenção
          <Badge tone="neutral" label={`${alerts.length} ${alerts.length === 1 ? "aviso" : "avisos"}`}>
            {alerts.length}
          </Badge>
        </h2>
        <div className="-mr-2 flex items-center gap-1">
          {alerts.length > limit ? (
            <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
              {expanded ? "Mostrar menos" : `Mostrar todos (${alerts.length})`}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onHide} title="Volta na próxima abertura do projeto">
            Ocultar
          </Button>
        </div>
      </div>
      <ul className="mt-2 flex flex-col">
        <AnimatePresence initial={false}>
          {shown.map((alert, index) => {
            const link = alertLink(alert);
            const base = `${alert.severity}|${alert.title}|${alert.dueOn ?? ""}`;
            const repeat = seen.get(base) ?? 0;
            seen.set(base, repeat + 1);
            const key = `${base}|${repeat}`;
            const action = (
              <Button
                size="sm"
                variant="secondary"
                aria-label={`${link.label}: ${alert.title}`}
                onClick={() => onGo(link)}
                className={compact ? "mt-2" : "self-center"}
              >
                {link.label}
              </Button>
            );
            return (
              <motion.li
                key={key}
                layout="position"
                initial={preset.enter.initial}
                animate={preset.enter.animate}
                exit={preset.enter.exit}
                transition={{ ...preset.enter.transition, delay: preset.reduce ? 0 : Math.min(index, 6) * 0.03 }}
                className="border-t border-separator py-3 first:border-t-0"
              >
                <div className={compact ? "flex flex-col items-start" : "flex items-start gap-3"}>
                  <Badge tone={SEVERITY_TONES[alert.severity]} className="mt-0.5 w-24 shrink-0 px-2">
                    {SEVERITY_WORDS[alert.severity]}
                  </Badge>
                  <div className={compact ? "mt-1 min-w-0" : "min-w-0 flex-1"}>
                    <p className="text-body font-medium text-text [overflow-wrap:anywhere]">
                      {keepTogether(alert.title)}
                    </p>
                    <p className="mt-0.5 text-caption text-secondary [overflow-wrap:anywhere]">
                      {keepTogether(alert.detail)}
                    </p>
                    {compact ? action : null}
                  </div>
                  {compact ? null : action}
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </section>
  );
}
