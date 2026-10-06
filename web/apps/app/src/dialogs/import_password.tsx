/**
 * PDF protegido na importação (desktop `QInputDialog` "Senha do PDF (não será guardada)"): the password opens the
 * file once, for the reading that asked for it. It lives in this field until it is handed over; it is not
 * stored, logged or sent anywhere, and the file is kept in the project exactly as it came. A wrong password is
 * refused inside the dialog, which stays open for another try.
 */
import { TextField } from "@opesvault/ui";
import { useState } from "react";
import { Caption, FormDialog } from "./livro_form.tsx";

export interface ImportPasswordDialogProps {
  open: boolean;
  /** The person gave up on this file. */
  onClose: () => void;
  name: string;
  /** The last password was wrong. */
  incorrect: boolean;
  confirmLabel?: string;
  /** Tries the password; throws a `DomainError` ("Senha incorreta…") to keep the dialog open. */
  onSubmit: (password: string) => Promise<void>;
}

export function ImportPasswordDialog({
  open,
  onClose,
  name,
  incorrect,
  confirmLabel = "Importar",
  onSubmit,
}: ImportPasswordDialogProps) {
  const [password, setPassword] = useState("");
  const close = () => {
    setPassword("");
    onClose();
  };
  return (
    <FormDialog
      open={open}
      onClose={close}
      title="PDF protegido"
      description={name}
      size="sm"
      confirmLabel={confirmLabel}
      confirmDisabled={password === ""}
      onConfirm={async () => {
        // Cleared whatever the outcome: a wrong password is typed again, a right one is no longer needed.
        const typed = password;
        setPassword("");
        await onSubmit(typed);
      }}
    >
      <p className="text-body">{incorrect ? "Senha do PDF incorreta." : "PDF protegido por senha."}</p>
      <TextField
        label="Senha do PDF"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="off"
        data-autofocus=""
      />
      <Caption>A senha é usada só para ler o arquivo agora e não é guardada.</Caption>
    </FormDialog>
  );
}
