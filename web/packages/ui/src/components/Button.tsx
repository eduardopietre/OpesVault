/**
 * Buttons (docs/16 §3 `button(role=…)`): primary (at most one per screen), secondary (the default), ghost
 * (plain) and danger (destructive). A button says what it does; an icon button has a name for screen
 * readers and the same text as a tooltip.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn.ts";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";
/** Text tone for secondary and ghost buttons (an approved action, a warning); never the only signal. */
export type Tone = "positive" | "negative" | "warning";

export const toneText: Record<Tone, string> = {
  positive: "text-positive",
  negative: "text-negative",
  warning: "text-warning",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** An icon before the text (lucide-react element). */
  icon?: ReactNode;
  /** An icon after the text (a chevron on menu buttons). */
  trailing?: ReactNode;
  tone?: Tone;
  /** Shows a spinner and blocks clicks while work started by this button runs. */
  busy?: boolean;
}

const base =
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium " +
  "transition-[background-color,color,border-color,box-shadow,transform] duration-[var(--ov-duration-fast)] " +
  "ease-standard active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent-fill text-accent-text shadow-sm hover:bg-accent-fill-hover",
  secondary: "border border-separator-strong bg-raised text-text shadow-sm hover:bg-hover active:bg-pressed",
  ghost: "text-text hover:bg-hover active:bg-pressed",
  danger: "border border-separator-strong bg-raised text-negative shadow-sm hover:bg-negative-soft",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-caption",
  md: "h-8 px-3 text-body",
  lg: "h-10 px-4 text-body",
};

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none",
        className,
      )}
    />
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    tone,
    icon,
    trailing,
    busy = false,
    className,
    children,
    disabled,
    type,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(base, variants[variant], sizes[size], tone && variant !== "primary" && toneText[tone], className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-variant={variant}
      {...rest}
    >
      {busy ? <Spinner /> : icon}
      {children}
      {trailing}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** The accessible name, also shown as the tooltip. */
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Extra text for the tooltip only, such as a shortcut ("Ctrl+K"). */
  shortcut?: string;
  tone?: Tone;
}

const iconSizes: Record<ButtonSize, string> = { sm: "size-7", md: "size-8", lg: "size-10" };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = "ghost", size = "md", shortcut, tone, className, type, title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={title ?? (shortcut ? `${label} (${shortcut})` : label)}
      className={cn(
        base,
        variants[variant],
        iconSizes[size],
        "px-0 [&_svg]:size-4",
        tone && variant !== "primary" && toneText[tone],
        className,
      )}
      data-variant={variant}
      {...rest}
    >
      {icon}
    </button>
  );
});
