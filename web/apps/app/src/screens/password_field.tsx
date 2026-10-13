/**
 * A password field with a button that shows or hides what was typed (sign in and sign up). The button keeps one
 * name and says its state with `aria-pressed`; the text never leaves the field (nothing is stored or logged).
 */
import { Field, IconButton, inputClass, cn } from "@opesvault/ui";
import { Eye, EyeOff } from "lucide-react";
import { useState, type InputHTMLAttributes } from "react";

export interface PasswordFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The name of the show/hide button ("Mostrar a senha"); it must not repeat the field's label. */
  revealLabel: string;
  hint?: string;
  error?: string | null;
}

export function PasswordField({ label, value, onChange, revealLabel, hint, error, ...rest }: PasswordFieldProps) {
  const [shown, setShown] = useState(false);
  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <div className="relative">
          <input
            id={id}
            type={shown ? "text" : "password"}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={cn(inputClass, "pr-10")}
            {...rest}
          />
          <IconButton
            label={revealLabel}
            title={shown ? "Ocultar o que foi digitado" : "Mostrar o que foi digitado"}
            icon={shown ? <EyeOff /> : <Eye />}
            size="sm"
            aria-pressed={shown}
            aria-controls={id}
            className="absolute top-1/2 right-1 -translate-y-1/2"
            onClick={() => setShown((now) => !now)}
          />
        </div>
      )}
    </Field>
  );
}
