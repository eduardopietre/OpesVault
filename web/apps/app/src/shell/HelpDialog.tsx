/** Contextual help (F1): what this screen is for and the shortcuts. Local text only. */
import { Button, Dialog } from "@opesvault/ui";
import { PAGES, shortcutOf, type PageDef } from "../pages.tsx";

const GENERAL: readonly [string, string][] = [
  ["Ctrl+K ou ⌘K", "Paleta de comandos: todas as seções e comandos"],
  ["Alt+1 … Alt+9", "Ir para a seção correspondente"],
  ["g e uma letra", "Ir para qualquer seção (veja abaixo)"],
  ["Ctrl+Z / Ctrl+Shift+Z", "Desfazer / refazer a última ação"],
  ["Ctrl+Shift+B", "Mostrar ou recolher a barra lateral"],
  ["Ctrl+Shift+L", "Bloquear o projeto agora"],
  ["Alt+← / Alt+→", "Mês anterior / próximo, no seletor de mês"],
  ["F1", "Esta ajuda"],
];

export function HelpDialog({
  open,
  onOpenChange,
  page,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  page: PageDef | undefined;
}) {
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
      <h3 className="mb-2 text-body font-semibold">Atalhos gerais</h3>
      <table className="mb-5 w-full text-body">
        <tbody>
          {GENERAL.map(([keys, what]) => (
            <tr key={keys} className="border-b border-separator/70">
              <th scope="row" className="w-48 py-1.5 pr-4 text-left align-top font-semibold whitespace-nowrap">
                {keys}
              </th>
              <td className="py-1.5 text-secondary">{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="mb-2 text-body font-semibold">Seções</h3>
      <ul className="grid grid-cols-1 gap-x-6 gap-y-1 text-body tablet:grid-cols-2">
        {PAGES.map((item) => (
          <li key={item.id} className="flex items-baseline justify-between gap-3">
            <span className="truncate">{item.title}</span>
            <span className="shrink-0 text-caption text-secondary">
              g {item.letter}
              {shortcutOf(item) ? ` · ${shortcutOf(item)}` : ""}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-5 text-caption text-secondary">
        Arraste arquivos (PDF, CSV, OFX) para qualquer tela para importá-los. Senha e chave nunca saem deste navegador:
        sem a senha e sem a chave de recuperação, não há como abrir o projeto.
      </p>
    </Dialog>
  );
}
