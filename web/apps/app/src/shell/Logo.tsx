/** The OpesVault mark: a rounded vault door with a keyhole, drawn in the accent color. */
import { cn } from "@opesvault/ui";

export function LogoMark({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-7 shrink-0", className)}>
      <rect x="1" y="1" width="30" height="30" rx="8" className="fill-accent-fill" />
      <circle cx="16" cy="16" r="9" fill="none" strokeWidth="2.25" className="stroke-accent-text" opacity="0.95" />
      <circle cx="16" cy="14.2" r="2.6" className="fill-accent-text" />
      <path d="M14.6 15.6h2.8l0.9 5.4h-4.6z" className="fill-accent-text" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string | undefined }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark />
      <span className="text-headline font-semibold tracking-[-0.01em] text-text">OpesVault</span>
    </span>
  );
}
