/**
 * Importar e revisar (desktop `ui/pages/imports/page.py`, RF-05..RF-09, docs/07): the documents imported, the
 * conference of the selected one and the original document beside it with the evidence of the selected item.
 * Files arrive by the file picker (Ctrl+I), by a drop on this page or anywhere in the app (`data/dropped_files.ts`)
 * and are read one at a time off the main thread; nothing becomes an operation before the person approves it.
 * The local AI, when it is on, suggests categories for the items that still have none after an import.
 */
import { importing, type Id } from "@opesvault/domain";
import {
  Adaptive,
  Button,
  DataTable,
  ElidedText,
  EmptyState,
  PageHeader,
  notify,
  useMotionPreset,
  type DataColumn,
} from "@opesvault/ui";
import { AnimatePresence, motion } from "motion/react";
import { FileUp, FolderInput, ListChecks } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useReveal } from "../../data/navigation.ts";
import { hasDroppedFiles, subscribeDroppedFiles, takeDroppedFiles } from "../../data/dropped_files.ts";
import { useLedger, useWorkspace } from "../../data/react.tsx";
import { TableBox } from "../../data/table_box.tsx";
import { AiRunRow } from "../../dialogs/ai_review.tsx";
import { ImportCoverageDialog } from "../../dialogs/import_coverage.tsx";
import { useImportAi } from "./ai.tsx";
import { ACCEPT, ReadingStrip, useImportQueue } from "./queue.tsx";
import { Review } from "./review.tsx";
import { batchRows, evidenceOf, queueContext, waitingItems, type BatchRow } from "./rows.ts";
import { DocumentViewer } from "./viewer.tsx";
import { READ_ONLY_TIP } from "../../data/read_only.ts";

const QUEUE_COLUMNS: DataColumn<BatchRow>[] = [
  {
    id: "name",
    header: "Documento",
    cell: (row) => <ElidedText>{row.name}</ElidedText>,
    sortValue: (row) => row.name,
    grow: 3,
    width: 150,
  },
  {
    id: "institution",
    header: "Instituição",
    cell: (row) => <ElidedText>{row.institution}</ElidedText>,
    sortValue: (row) => row.institution,
    grow: 1,
    width: 120,
    priority: 2,
  },
  {
    id: "state",
    header: "Situação",
    cell: (row) => <ElidedText>{row.state}</ElidedText>,
    sortValue: (row) => row.state,
    grow: 2,
    width: 140,
  },
  {
    id: "pending",
    header: "A revisar",
    cell: (row) => row.pending,
    sortValue: (row) => row.pending,
    align: "end",
    width: 92,
  },
  {
    id: "items",
    header: "Itens",
    cell: (row) => row.items,
    sortValue: (row) => row.items,
    align: "end",
    width: 72,
    priority: 3,
  },
];

export function Page() {
  const workspace = useWorkspace();
  const preset = useMotionPreset();
  const readOnly = workspace.readOnly;
  const picker = useRef<HTMLInputElement>(null);
  const [pick, setPick] = useState<Id | null>(null);
  const [itemId, setItemId] = useState<Id | null>(null);
  const [coverage, setCoverage] = useState(false);

  const rows = useLedger((ledger) => batchRows(ledger, workspace.session.documents));
  const waiting = useLedger((ledger) => waitingItems(ledger));
  const batchId = rows.find((row) => row.id === pick)?.id ?? rows[0]?.id ?? null;

  const chooseBatch = (id: Id | null) => {
    setPick(id);
    setItemId(null);
  };

  const ai = useImportAi();
  const queue = useImportQueue({ ai, onImported: chooseBatch });

  // Files dropped anywhere in the app are taken once, when this page opens or when more arrive.
  const { addFiles } = queue;
  useEffect(() => {
    const take = () => {
      if (!hasDroppedFiles()) return;
      addFiles(takeDroppedFiles());
    };
    take();
    return subscribeDroppedFiles(take);
  }, [addFiles]);

  const choose = () => {
    if (readOnly) {
      notify(READ_ONLY_TIP, { tone: "warning" });
      return;
    }
    picker.current?.click();
  };

  // Ctrl+I imports (not while a dialog is open or a field is being typed in).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "i")
        return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      choose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // An import notice: the document waiting for review, ready for Ctrl+Enter.
  useReveal((ref) => {
    if (!ref) return;
    if (!importing.pipeline.batches(workspace.ledger).has(ref)) {
      notify("Esse documento não existe mais.");
      return;
    }
    chooseBatch(ref);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          '[role="grid"][aria-label="Itens extraídos"],[role="listbox"][aria-label="Itens extraídos"]',
        )
        ?.focus(),
    );
  });

  const batch = useLedger(
    (ledger) => (batchId ? (importing.pipeline.batches(ledger).get(batchId) ?? null) : null),
    batchId,
  );
  const documentName = batch
    ? (workspace.session.documents.find((d) => d.meta.id === batch.document_id)?.meta.original_name ?? "Documento")
    : "";
  const evidence = useLedger((ledger) => {
    const item = itemId ? importing.pipeline.items(ledger).get(itemId) : undefined;
    return item && item.batch_id === batchId ? evidenceOf(ledger, item) : null;
  }, `${itemId}|${batchId}`);

  const reviewing = batch !== null;
  const empty = rows.length === 0 && queue.jobs.length === 0;

  const importButton = (
    <Button
      variant={reviewing ? "secondary" : "primary"}
      icon={<FileUp />}
      onClick={choose}
      disabled={readOnly}
      title={readOnly ? READ_ONLY_TIP : "PDF, CSV ou OFX (Ctrl+I); ou arraste para cá"}
    >
      Importar arquivos…
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Importar e revisar"
        context={queueContext(rows, waiting)}
        actions={
          <Button
            variant="ghost"
            icon={<ListChecks />}
            onClick={() => setCoverage(true)}
            title="Bancos e documentos lidos"
          >
            Layouts suportados
          </Button>
        }
        primary={importButton}
      />

      <ReadingStrip queue={queue} readOnly={readOnly} />

      <AnimatePresence initial={false}>
        {ai.run.running ? (
          <motion.div
            key="ai-run"
            initial={preset.fade.initial}
            animate={preset.fade.animate}
            exit={preset.fade.exit}
            transition={preset.fade.transition}
          >
            <AiRunRow run={ai.run} />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {empty ? (
        <EmptyState
          framed
          icon={<FolderInput />}
          title="Nenhum documento importado"
          description="Importe faturas de cartão, extratos e notas de corretagem em PDF, CSV ou OFX. Cada item é revisado aqui antes de virar lançamento; o arquivo original fica guardado no projeto, cifrado. Você também pode arrastar os arquivos para esta janela."
          actions={
            <Button onClick={choose} disabled={readOnly}>
              Importar arquivos…
            </Button>
          }
        />
      ) : (
        <Adaptive at={1400} columns="1fr 5fr" gap={24}>
          <section aria-label="Documentos importados" className="min-w-0">
            {rows.length ? (
              <TableBox rows={rows.length} cap={8}>
                {(height) => (
                  <DataTable
                    label="Documentos importados"
                    rows={rows}
                    columns={QUEUE_COLUMNS}
                    getRowId={(row) => row.id}
                    selectedId={batchId}
                    onSelect={chooseBatch}
                    cardTitle={(row) => <ElidedText>{row.name}</ElidedText>}
                    height={height === "none" ? "min(60dvh, 36rem)" : height}
                  />
                )}
              </TableBox>
            ) : (
              <p className="rounded-lg border border-dashed border-separator-strong px-4 py-6 text-center text-body text-secondary">
                O documento aparece aqui quando a leitura terminar.
              </p>
            )}
          </section>
          {batchId && batch ? (
            <Adaptive at={1000} columns="3fr 2fr" gap={24}>
              <Review key={batchId} batchId={batchId} selected={itemId} onSelect={setItemId} queue={queue} ai={ai} />
              <DocumentViewer documentId={batch.document_id} name={documentName} evidence={evidence} />
            </Adaptive>
          ) : (
            <EmptyState
              framed
              level={2}
              title="Selecione um documento"
              description="Os itens extraídos aparecem aqui para revisão."
            />
          )}
        </Adaptive>
      )}

      <input
        ref={picker}
        type="file"
        multiple
        aria-label="Escolher os arquivos para importar"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const chosen = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (chosen.length) queue.addFiles(chosen);
        }}
      />

      <ImportCoverageDialog open={coverage} onClose={() => setCoverage(false)} />
      {queue.passwordDialog}
    </div>
  );
}
