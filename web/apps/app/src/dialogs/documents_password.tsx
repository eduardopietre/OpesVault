/**
 * PDF protegido (desktop `QInputDialog` "Senha do PDF (não será guardada)"): the password opens the file once.
 * It lives in this field only until the file is opened; it is not stored, logged or sent anywhere. A wrong one
 * is refused inside the dialog, which stays open for another try.
 */
import { TextField } from "@opesvault/ui";
import { useState } from "react";
import { Caption, FormDialog } from "./livro_form.tsx";

export interface DocumentsPasswordDialogProps {
  open: boolean;
  onClose: () => void;
  /** The file's name, so it is clear which one is being opened. */
  name: string;
  /** Tries the password; throws a `DomainError` ("Senha incorreta…") to keep the dialog open. */
  onSubmit: (password: string) => Promise<void>;
}

export function DocumentsPasswordDialog({ open, onClose, name, onSubmit }: DocumentsPasswordDialogProps) {
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
      confirmLabel="Abrir"
      confirmDisabled={password === ""}
      onConfirm={async () => {
        // Cleared whatever the outcome: a wrong password is typed again, a right one is no longer needed.
        const typed = password;
        setPassword("");
        await onSubmit(typed);
      }}
    >
      <TextField
        label="Senha do PDF"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="off"
        data-autofocus=""
      />
      <Caption>A senha é usada só para abrir o arquivo agora e não é guardada.</Caption>
    </FormDialog>
  );
}
