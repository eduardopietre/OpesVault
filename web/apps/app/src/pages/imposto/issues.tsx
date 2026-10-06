/**
 * Pendências (desktop `issue_table` with "Resolver…"): what the return still lacks, most urgent first, each
 * with the one action that resolves it. The state is written in words and shaped by a badge, never by color
 * alone; the button names the pending item it is for.
 */
import type { tax } from "@opesvault/domain";
import { Badge, Button, useElementWidth, useMotionPreset, type BadgeTone } from "@opesvault/ui";
import { AnimatePresence, motion } from "motion/react";
import { CircleCheck } from "lucide-react";
import { ISSUE_ACTIONS, SEVERITY_TONES, SEVERITY_WORDS } from "./rows.ts";

const TONES: Record<string, BadgeTone> = { negative: "negative", warning: "warning", neutral: "neutral" };

/** "R$ 1.371,50" never breaks between the symbol and the number. */
const together = (value: string) => value.replaceAll("R$ ", "R$ ");

export interface IssueListProps {
  issues: readonly tax.issues.Issue[];
  onResolve: (issue: tax.issues.Issue) => void;
}

export function IssueList({ issues, onResolve }: IssueListProps) {
  const preset = useMotionPreset();
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const compact = width > 0 && width < 520;
  if (issues.length === 0) {
    return (
      <p className="flex items-center gap-2 text-body text-secondary">
        <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-positive" />
        Nenhuma pendência para este ano.
      </p>
    );
  }
  return (
    <div ref={measure} className="min-w-0">
      <ul aria-label="Pendências da declaração" className="flex flex-col">
        <AnimatePresence initial={false}>
          {issues.map((issue, index) => {
            const label = ISSUE_ACTIONS[issue.action];
            const key = `${issue.severity}|${issue.title}|${issue.action}|${issue.detail}`;
            const action = label ? (
              <Button
                size="sm"
                aria-label={`${label} (${issue.title})`}
                onClick={() => onResolve(issue)}
                className={compact ? "mt-2" : "self-center"}
              >
                {label}
              </Button>
            ) : null;
            return (
              <motion.li
                key={key}
                layout="position"
                initial={preset.enter.initial}
                animate={preset.enter.animate}
                exit={preset.enter.exit}
                transition={{ ...preset.enter.transition, delay: preset.reduce ? 0 : Math.min(index, 6) * 0.03 }}
                className="border-t border-separator py-3 first:border-t-0 first:pt-0"
              >
                <div className={compact ? "flex flex-col items-start" : "flex items-start gap-3"}>
                  <Badge
                    tone={TONES[SEVERITY_TONES[issue.severity]] ?? "neutral"}
                    className="mt-0.5 w-20 shrink-0 px-2"
                  >
                    {SEVERITY_WORDS[issue.severity]}
                  </Badge>
                  <div className={compact ? "mt-1 min-w-0" : "min-w-0 flex-1"}>
                    <p className="text-body font-medium text-text [overflow-wrap:anywhere]">{together(issue.title)}</p>
                    {issue.detail ? (
                      <p className="mt-0.5 text-caption text-secondary [overflow-wrap:anywhere]">
                        {together(issue.detail)}
                      </p>
                    ) : null}
                    {compact ? action : null}
                  </div>
                  {compact ? null : action}
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </div>
  );
}
