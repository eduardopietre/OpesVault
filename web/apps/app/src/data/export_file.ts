/**
 * A file that leaves the project's protection (a CSV, a chart's image, a document's original): the person is
 * asked first, the file is offered to save, and the notice reminds them it is not encrypted (docs/19 §12).
 */
import { confirm, notify } from "@opesvault/ui";

/** The reminder after a file is saved outside the project. */
export const NOT_ENCRYPTED = "Guarde-o com cuidado: ele não é cifrado.";

export interface PlainExport {
  /** The question's title and text, and the label of the button that saves. */
  title: string;
  text: string;
  confirmLabel: string;
  /** Makes and offers the file; `false` when nothing was saved (it said why). */
  save: () => boolean | void;
  /** The notice once saved; by default the CSV's. */
  done?: string;
}

/** Asks, saves and tells; resolves to whether the file was offered. */
export async function exportUnencrypted({ title, text, confirmLabel, save, done }: PlainExport): Promise<boolean> {
  if (!(await confirm({ title, text, confirmLabel }))) return false;
  if (save() === false) return false;
  notify(done ?? `Arquivo CSV gerado. ${NOT_ENCRYPTED}`);
  return true;
}
