/**
 * Form fields. A label is always visible, the hint and the error sit under the field, and the error is
 * text (never only a red border). Values are the text the user typed: pages convert it (money to the
 * domain's Dec, dates to IsoDate) with the helpers in format.ts and show errors here.
 */
import { Checkbox as RadixCheckbox, RadioGroup as RadixRadio, Switch as RadixSwitch } from "radix-ui";
import { Check, Minus } from "lucide-react";
import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { formatBrDate, normalizeMoneyInput, parseBrDate } from "../format.ts";

export const inputClass =
  "h-9 w-full min-w-0 rounded-md border border-separator-strong bg-raised px-3 text-body text-text shadow-sm " +
  "placeholder:text-tertiary transition-[border-color,box-shadow] duration-[var(--ov-duration-fast)] " +
  "hover:border-secondary focus-visible:border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 " +
  "disabled:bg-window disabled:text-tertiary aria-[invalid=true]:border-negative aria-[invalid=true]:ring-negative/20";

export interface FieldProps {
  label: string;
  /** Help under the field. */
  hint?: ReactNode;
  /** The error message, shown under the field and announced. */
  error?: string | null | undefined;
  required?: boolean;
  className?: string | undefined;
  /** Hides the label visually (still read by screen readers) when the context names the field. */
  hideLabel?: boolean;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** Label, control, hint and error with the ids wired for assistive technology. */
export function Field({ label, hint, error, required, className, hideLabel, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className={cn("text-body font-medium text-text", hideLabel && "sr-only")}>
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-0.5 text-secondary">
            *
          </span>
        ) : null}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && !error ? (
        <p id={hintId} className="text-caption text-secondary">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-caption font-medium text-negative">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  error?: string | null | undefined;
  hideLabel?: boolean;
  /** Text or an icon inside the field, before the value ("R$"). */
  adornment?: ReactNode;
  fieldClassName?: string | undefined;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, value, onChange, hint, error, hideLabel, adornment, fieldClassName, className, required, ...rest },
  ref,
) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required ?? false}
      hideLabel={hideLabel ?? false}
      className={fieldClassName}
    >
      {({ id, describedBy, invalid }) => (
        <div className="relative">
          {adornment ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-secondary [&_svg]:size-4"
            >
              {adornment}
            </span>
          ) : null}
          <input
            ref={ref}
            id={id}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            required={required}
            className={cn(inputClass, adornment ? "pl-9" : undefined, className)}
            {...rest}
          />
        </div>
      )}
    </Field>
  );
});

export interface MoneyFieldProps extends Omit<TextFieldProps, "inputMode" | "adornment" | "error"> {
  /** An error from the page (out of range, required); the format error is the field's own. */
  error?: string | null | undefined;
  /** Places allowed after the comma (2 for BRL). */
  maxDecimals?: number;
  /** Called with the canonical decimal ("1234.56") or null when the text is not an amount. */
  onValueChange?: (canonical: string | null) => void;
}

/**
 * An amount typed the Brazilian way ("1.234,56"). The text is kept exactly as typed; `onValueChange`
 * gives the canonical decimal string for the page to parse with Dec. A format error shows after leaving
 * the field.
 */
export const MoneyField = forwardRef<HTMLInputElement, MoneyFieldProps>(function MoneyField(
  { value, onChange, onValueChange, error, maxDecimals = 2, onBlur, placeholder, ...rest },
  ref,
) {
  const [touched, setTouched] = useState(false);
  const canonical = normalizeMoneyInput(value, maxDecimals);
  const formatError =
    touched && value.trim() !== "" && canonical === null ? "Valor inválido. Use o formato 1.234,56." : null;
  return (
    <TextField
      ref={ref}
      value={value}
      onChange={(text) => {
        onChange(text);
        onValueChange?.(normalizeMoneyInput(text, maxDecimals));
      }}
      onBlur={(event) => {
        setTouched(true);
        onBlur?.(event);
      }}
      inputMode="decimal"
      autoComplete="off"
      placeholder={placeholder ?? "0,00"}
      adornment={<span className="text-body">R$</span>}
      error={formatError ?? error}
      className="text-right tabular-nums"
      {...rest}
    />
  );
});

export interface DateFieldProps extends Omit<TextFieldProps, "inputMode" | "error"> {
  error?: string | null | undefined;
  /** Called with the ISO date ("2026-10-05") or null. */
  onDateChange?: (iso: string | null) => void;
}

/** A date typed as dd/mm/aaaa; "05102026" becomes "05/10/2026" when leaving the field. */
export const DateField = forwardRef<HTMLInputElement, DateFieldProps>(function DateField(
  { value, onChange, onDateChange, error, onBlur, ...rest },
  ref,
) {
  const [touched, setTouched] = useState(false);
  const iso = parseBrDate(value);
  const formatError = touched && value.trim() !== "" && iso === null ? "Data inválida. Use dd/mm/aaaa." : null;
  return (
    <TextField
      ref={ref}
      value={value}
      onChange={(text) => {
        onChange(text);
        onDateChange?.(parseBrDate(text));
      }}
      onBlur={(event) => {
        setTouched(true);
        const parsed = parseBrDate(value);
        if (parsed && formatBrDate(parsed) !== value) onChange(formatBrDate(parsed));
        onBlur?.(event);
      }}
      inputMode="numeric"
      autoComplete="off"
      placeholder="dd/mm/aaaa"
      maxLength={10}
      error={formatError ?? error}
      className="tabular-nums"
      {...rest}
    />
  );
});

export interface CheckboxProps {
  label: ReactNode;
  checked: boolean | "indeterminate";
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  description?: ReactNode;
  className?: string;
}

export function Checkbox({ label, checked, onCheckedChange, disabled, description, className }: CheckboxProps) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <RadixCheckbox.Root
        id={id}
        checked={checked}
        disabled={disabled ?? false}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        aria-describedby={description ? `${id}-d` : undefined}
        className="mt-0.5 grid size-4.5 shrink-0 place-items-center rounded-sm border border-separator-strong bg-raised text-accent-text shadow-sm transition-colors data-[state=checked]:border-accent-fill data-[state=checked]:bg-accent-fill data-[state=indeterminate]:border-accent-fill data-[state=indeterminate]:bg-accent-fill disabled:opacity-50"
      >
        <RadixCheckbox.Indicator>
          {checked === "indeterminate" ? (
            <Minus aria-hidden="true" className="size-3.5" />
          ) : (
            <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
          )}
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      <div className="min-w-0">
        <label htmlFor={id} className="text-body text-text">
          {label}
        </label>
        {description ? (
          <p id={`${id}-d`} className="text-caption text-secondary">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export interface SwitchProps {
  label: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  description?: ReactNode;
  className?: string;
}

/** A setting that applies at once (docs/16 §5: no Apply button). The state is also written ("Ligada"). */
export function Switch({ label, checked, onCheckedChange, disabled, description, className }: SwitchProps) {
  const id = useId();
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <label htmlFor={id} className="text-body text-text">
          {label}
        </label>
        {description ? (
          <p id={`${id}-d`} className="text-caption text-secondary">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span aria-hidden="true" className="text-caption text-secondary">
          {checked ? "Ligado" : "Desligado"}
        </span>
        <RadixSwitch.Root
          id={id}
          checked={checked}
          disabled={disabled ?? false}
          onCheckedChange={onCheckedChange}
          aria-describedby={description ? `${id}-d` : undefined}
          className="relative h-5.5 w-9.5 shrink-0 rounded-full bg-separator-strong transition-colors duration-[var(--ov-duration-base)] data-[state=checked]:bg-accent-fill disabled:opacity-50"
        >
          <RadixSwitch.Thumb className="block size-4.5 translate-x-0.5 rounded-full bg-accent-text shadow-sm transition-transform duration-[var(--ov-duration-base)] ease-standard data-[state=checked]:translate-x-[18px]" />
        </RadixSwitch.Root>
      </div>
    </div>
  );
}

export interface RadioOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly RadioOption[];
  orientation?: "vertical" | "horizontal";
  className?: string;
}

export function RadioGroup({
  label,
  value,
  onValueChange,
  options,
  orientation = "vertical",
  className,
}: RadioGroupProps) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={`${id}-l`} className={cn("flex flex-col gap-2", className)}>
      <span id={`${id}-l`} className="text-body font-medium text-text">
        {label}
      </span>
      <RadixRadio.Root
        value={value}
        onValueChange={onValueChange}
        orientation={orientation}
        aria-labelledby={`${id}-l`}
        className={cn("flex gap-2", orientation === "vertical" ? "flex-col" : "flex-row flex-wrap gap-x-5")}
      >
        {options.map((option) => (
          <div key={option.value} className="flex items-start gap-2.5">
            <RadixRadio.Item
              id={`${id}-${option.value}`}
              value={option.value}
              disabled={option.disabled ?? false}
              className="mt-0.5 grid size-4.5 shrink-0 place-items-center rounded-full border border-separator-strong bg-raised shadow-sm data-[state=checked]:border-accent-fill disabled:opacity-50"
            >
              <RadixRadio.Indicator className="block size-2.5 rounded-full bg-accent-fill" />
            </RadixRadio.Item>
            <div className="min-w-0">
              <label htmlFor={`${id}-${option.value}`} className="text-body text-text">
                {option.label}
              </label>
              {option.description ? <p className="text-caption text-secondary">{option.description}</p> : null}
            </div>
          </div>
        ))}
      </RadixRadio.Root>
    </div>
  );
}
