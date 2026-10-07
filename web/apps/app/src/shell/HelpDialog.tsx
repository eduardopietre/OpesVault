/** Contextual help (F1): what this screen is for and the shortcuts. Local text only. */
import { Button, Dialog } from "@opesvault/ui";
import type { PageDef } from "../pages.tsx";
import { SHORTCUTS } from "./shortcuts.ts";
import { SectionKeys, ShortcutTable } from "./ShortcutsDialog.tsx";

export function HelpDialog({
  open,
  onOpenChange,
  page,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  page: PageDef | undefined;
}) {
  const here = page ? SHORTCUTS.filter((item) => item.where === page.title) : [];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={page ? `Ajuda: ${page.title}` : "Ajuda"}
      size="lg"
      footer={
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          Fechar
        </Button>
      }
    >
      {page ? <p className="mb-5 text-body text-text">{page.about}</p> : null}
      {here.length ? <ShortcutTable items={here} caption="Atalhos desta tela" /> : null}
      <ShortcutTable items={SHORTCUTS.filter((item) => item.where === "geral")} caption="Atalhos gerais" />
      <h3 className="mb-2 text-body font-semibold">Seções</h3>
      <SectionKeys />
      <p className="mt-5 text-caption text-secondary">
        Arraste arquivos (PDF, CSV, OFX) para qualquer tela para importá-los. Senha e chave nunca saem deste navegador:
        sem a senha e sem a chave de recuperação, não há como abrir o projeto.
      </p>
    </Dialog>
  );
}
