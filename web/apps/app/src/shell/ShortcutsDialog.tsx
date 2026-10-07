/** "Atalhos de teclado" (`?`): every shortcut, from the same list the handlers and the tooltips use. */
import { Button, Dialog } from "@opesvault/ui";
import { Fragment } from "react";
import { PAGES, shortcutOf } from "../pages.tsx";
import { SHORTCUTS, type Shortcut } from "./shortcuts.ts";

function Keys({ item }: { item: Shortcut }) {
  return (
    <>
      {item.keys.map((keys, index) => (
        <Fragment key={keys}>
          {index ? <span className="px-1 font-normal text-secondary">ou</span> : null}
          <kbd className="rounded border border-separator bg-raised px-1.5 font-sans text-caption font-semibold">
            {keys}
          </kbd>
        </Fragment>
      ))}
    </>
  );
}

/** A table of shortcuts (also used by the help, F1). */
export function ShortcutTable({ items, caption }: { items: readonly Shortcut[]; caption: string }) {
  return (
    <table className="mb-5 w-full text-body">
      <caption className="mb-2 text-left text-body font-semibold">{caption}</caption>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} className="border-b border-separator/70">
            <th scope="row" className="w-56 py-1.5 pr-4 text-left align-top font-semibold whitespace-nowrap">
              <Keys item={item} />
            </th>
            <td className="py-1.5 text-secondary">{item.what}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The `g` letter and Alt+N of every destination. */
export function SectionKeys() {
  return (
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
  );
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const general = SHORTCUTS.filter((item) => item.where === "geral");
  const screens = [...new Set(SHORTCUTS.filter((item) => item.where !== "geral").map((item) => item.where))];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Atalhos de teclado"
      description="As teclas de uma letra não valem enquanto você digita num campo nem com uma janela aberta."
      size="lg"
      footer={
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          Fechar
        </Button>
      }
    >
      <ShortcutTable items={general} caption="Em todas as telas" />
      {screens.map((where) => (
        <ShortcutTable
          key={where}
          items={SHORTCUTS.filter((item) => item.where === where)}
          caption={`Em ${where}`}
        />
      ))}
      <h3 className="mb-2 text-body font-semibold">Seções</h3>
      <SectionKeys />
    </Dialog>
  );
}
