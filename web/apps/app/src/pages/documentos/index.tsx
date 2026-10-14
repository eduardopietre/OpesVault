/**
 * Documentos (desktop `ui/pages/documents_page.py`): every file stored in the project, imports and receipts,
 * what uses each one and the original itself, drawn in the tab only when asked for (docs/03 §6).
 */
import { DomainError, dom, exporting, type Id } from "@opesvault/domain";
import {
  Adaptive,
  Button,
  DataTable,
  ElidedText,
  EmptyState,
  PageHeader,
  notify,
  type DataColumn,
  type MenuEntry,
  saveFile,
  formatBytes,
} from "@opesvault/ui";
import { useRef, useState } from "react";
import { useGoTo, useReveal } from "../../data/navigation.ts";
import { useLedger, useNotifyDone, useWorkspace } from "../../data/react.tsx";
import { TableBox } from "../../data/table_box.tsx";
import { DocumentPanel } from "./panel.tsx";
import { documentRows, summaryLine, type DocumentRow, type ReceiptUse } from "./rows.ts";
import { exportUnencrypted, NOT_ENCRYPTED } from "../../data/export_file.ts";
import { DOCUMENT_MIME, type DocumentKind } from "../../data/use_document.ts";
import { lockEntries } from "../../data/read_only.ts";
import { dateOr } from "../../data/money.ts";

const COLUMNS: DataColumn<DocumentRow>[] = [
  {
    id: "name",
    header: "Arquivo",
    cell: (row) => <ElidedText>{row.name}</ElidedText>,
    sortValue: (row) => row.name,
    grow: 2,
    width: 160,
  },
  { id: "date", header: "Data", cell: (row) => dateOr(row.date), sortValue: (row) => row.date ?? "", width: 112 },
  {
    id: "where",
    header: "Conta ou cartão",
    cell: (row) => <ElidedText>{row.where}</ElidedText>,
    sortValue: (row) => row.where,
    grow: 1,
    width: 130,
  },
  {
    id: "state",
    header: "Situação",
    cell: (row) => <ElidedText>{row.state}</ElidedText>,
    sortValue: (row) => row.state,
    grow: 1,
    width: 130,
  },
  {
    id: "size",
    header: "Tamanho",
    cell: (row) => formatBytes(row.size),
    sortValue: (row) => row.size,
    align: "end",
    width: 90,
    priority: 3,
  },
];

export function Page() {
  const workspace = useWorkspace();
  const goTo = useGoTo();
  const notifyDone = useNotifyDone();
  const locked = workspace.readOnly;
  const panelBox = useRef<HTMLDivElement>(null);

  const rows = useLedger((ledger) => documentRows(ledger, workspace.session.documents));
  const [pick, setPick] = useState<string | null>(null);
  // The viewer shows something instead of an empty pane (desktop), but only a file already in this tab:
  // a document is fetched and decrypted when the user chooses it, never behind their back.
  const first = rows[0];
  const selected =
    rows.find((row) => row.id === pick) ?? (pick === null && first && workspace.hasDocument(first.id) ? first : null);

  const choose = (id: string) => {
    setPick(id);
    // Stacked (narrow container), the viewer is below the list: bring it into view.
    requestAnimationFrame(() => panelBox.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  // A receipt or an import named by another screen: select its document.
  useReveal((ref) => {
    const id = ref?.startsWith("documento:") ? ref.slice("documento:".length) : ref;
    if (!id) return;
    if (!workspace.session.documents.some((d) => d.meta.id === id)) {
      notify("Esse documento não existe mais.");
      return;
    }
    choose(id);
  });

  /** Without asking: nothing uses the file, and the notice's Desfazer puts it back with its bytes. */
  const remove = async (row: DocumentRow) => {
    try {
      // Undo puts the file back with its bytes, so they must be in this tab before it goes.
      await workspace.loadDocument(row.id);
      workspace.act((_ledger, session) => session.removeDocument(row.id), "excluir documento");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Não foi possível remover o documento.", { tone: "negative" });
      return;
    }
    setPick(null);
    notifyDone(`“${row.name}” removido do projeto.`);
  };

  /**
   * Takes a receipt off an operation; a file nothing else uses leaves the project with it (docs/04). Without
   * asking: the notice says what happened and its Desfazer puts the link (and the file) back.
   */
  const detach = async (row: DocumentRow, use: ReceiptUse) => {
    const last = row.receipts.length === 1 && row.batchId === null;
    try {
      // Undo puts the file back with its bytes, so they must be in this tab before it can go.
      await workspace.loadDocument(row.id);
      workspace.act((_ledger, session) => dom.attachments.detach(session, use.attachmentId), "desvincular comprovante");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Não foi possível desvincular o comprovante.", {
        tone: "negative",
      });
      return;
    }
    if (last) setPick(null);
    notifyDone(
      last
        ? `“${row.name}” deixou de ser comprovante de “${use.description}” e saiu do projeto, porque nada mais o usa.`
        : `“${row.name}” deixou de ser comprovante de “${use.description}”.`,
    );
  };

  const save = async (row: DocumentRow, bytes: Uint8Array, kind: DocumentKind) => {
    await exportUnencrypted({
      title: "Salvar o original sem criptografia?",
      text: `${exporting.WARNING} O arquivo “${row.name}” (${formatBytes(row.size)}) vai para a pasta de downloads deste aparelho.`,
      confirmLabel: "Salvar o original",
      save: () => saveFile(row.name, bytes, DOCUMENT_MIME[kind]),
      done: `Arquivo salvo. ${NOT_ENCRYPTED}`,
    });
  };

  /** "Salvar o original…" from a row's menu: the bytes are fetched and decrypted now, as the panel does. */
  const saveRow = async (row: DocumentRow) => {
    let bytes: Uint8Array;
    try {
      bytes = await workspace.loadDocument(row.id);
    } catch (error) {
      notify(error instanceof DomainError ? error.message : "Não foi possível abrir este documento.", {
        tone: "negative",
      });
      return;
    }
    await save(row, bytes, (dom.attachments.kindOf(bytes) ?? "other") as DocumentKind);
  };

  /**
   * A document's context menu: save the original, open what uses it, and the commands that take it off
   * (Desvincular from each operation, Remover when nothing uses it) apart and in red; their notice offers Desfazer.
   */
  const rowMenu = (row: DocumentRow): MenuEntry[] => {
    const seeImport: MenuEntry[] = row.batchId
      ? [{ id: "import", label: "Ver importação", onSelect: () => goTo("importar", { ref: row.batchId as Id }) }]
      : [];
    const seeOperation = (use: ReceiptUse, id: string, label: string): MenuEntry => ({
      id,
      label,
      onSelect: () => goTo("livro", { ref: use.operationId }),
    });
    const unlink = (use: ReceiptUse, id: string, label: string): MenuEntry => ({
      id,
      label,
      danger: true,
      onSelect: () => void detach(row, use),
    });
    const [only] = row.receipts;
    const several = row.receipts.length > 1;
    const operations: MenuEntry[] = several
      ? [
          {
            kind: "submenu",
            id: "operations",
            label: "Ver lançamento",
            items: row.receipts.map((use, i) => seeOperation(use, `operation-${i}`, use.description)),
          },
        ]
      : only
        ? [seeOperation(only, "operation", "Ver lançamento")]
        : [];
    const removal: MenuEntry[] = several
      ? [
          {
            kind: "submenu",
            id: "detach",
            label: "Desvincular",
            items: row.receipts.map((use, i) => unlink(use, `detach-${i}`, use.description)),
          },
        ]
      : only
        ? [unlink(only, "detach", "Desvincular")]
        : row.free
          ? [{ id: "remove", label: "Remover", danger: true, onSelect: () => void remove(row) }]
          : [];
    const free = ["save", "import", "operations", "operation", ...row.receipts.map((_, i) => `operation-${i}`)];
    return lockEntries(
      [
        { id: "save", label: "Salvar o original…", onSelect: () => void saveRow(row) },
        ...(seeImport.length || operations.length ? [{ kind: "separator", id: "s1" } as const] : []),
        ...seeImport,
        ...operations,
        ...(removal.length ? [{ kind: "separator", id: "s2" } as const] : []),
        ...removal,
      ],
      locked,
      free,
    );
  };

  const context = summaryLine(rows);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Documentos" context={context} />

      {rows.length > 0 ? (
        <Adaptive at={1200} columns="5fr 4fr" gap={24}>
          <section aria-label="Documentos no projeto" className="min-w-0">
            <TableBox rows={rows.length} cap={12}>
              {(height) => (
                <DataTable
                  label="Documentos no projeto"
                  rows={rows}
                  columns={COLUMNS}
                  getRowId={(row) => row.id}
                  selectedId={selected?.id ?? null}
                  onSelect={choose}
                  rowMenu={rowMenu}
                  rowMenuLabel={(row) => `Ações de ${row.name}`}
                  cardTitle={(row) => <ElidedText>{row.name}</ElidedText>}
                  height={height}
                />
              )}
            </TableBox>
          </section>
          <div ref={panelBox} className="min-w-0">
            {selected ? (
              <DocumentPanel
                key={selected.id}
                row={selected}
                locked={locked}
                onSeeImport={(batchId: Id) => goTo("importar", { ref: batchId })}
                onSeeOperation={(operationId: Id) => goTo("livro", { ref: operationId })}
                onDetach={(row, use) => void detach(row, use)}
                onRemove={(row) => void remove(row)}
                onSave={(row, bytes, kind) => void save(row, bytes, kind)}
              />
            ) : (
              <div className="rounded-xl border border-dashed border-separator-strong bg-window/40 px-4 py-10 text-center">
                <p className="text-body text-secondary">
                  Selecione um documento na lista para abrir o original. Ele é baixado e decifrado só agora.
                </p>
              </div>
            )}
          </div>
        </Adaptive>
      ) : (
        <EmptyState
          framed
          title="Nenhum documento no projeto"
          description="Os arquivos importados e os comprovantes anexados no Livro ficam guardados aqui, cifrados, como evidência dos lançamentos."
          actions={<Button onClick={() => goTo("livro")}>Abrir o Livro financeiro</Button>}
        />
      )}
    </div>
  );
}
