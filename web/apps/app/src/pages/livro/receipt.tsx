/**
 * Opening a receipt (desktop: "Abrir comprovante" went to Documentos): the original is fetched and decrypted
 * on demand (`loadDocument`), then shown here, a PDF drawn page by page and an image as it is, with a button
 * to save the file. The bytes only ever live in this tab.
 */
import { type Id } from "@opesvault/domain";
import { Button, Dialog, Skeleton, useElementWidth, saveFile } from "@opesvault/ui";
import { Download } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { renderPdf, type RenderedPdf } from "../../data/pdf_render.ts";
import { useWorkspace } from "../../data/react.tsx";
import { DOCUMENT_MIME, useDocument, useImageUrl, type LoadedDocument } from "../../data/use_document.ts";

export interface ReceiptDialogProps {
  open: boolean;
  onClose: () => void;
  documentId: Id;
}

export function ReceiptDialog({ open, onClose, documentId }: ReceiptDialogProps) {
  const workspace = useWorkspace();
  const meta = workspace.session.documents.find((d) => d.meta.id === documentId)?.meta;
  const name = meta?.original_name ?? "comprovante";
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const pages = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string | null>(null);

  const fetched = useDocument(documentId, "Não foi possível abrir o comprovante.").loaded;
  const loaded = useMemo<LoadedDocument>(
    () =>
      fetched.state === "ready" && fetched.kind === "other"
        ? { state: "error", message: "Este arquivo não é um PDF nem uma imagem." }
        : fetched,
    [fetched],
  );

  useEffect(() => {
    if (loaded.state !== "ready") return;
    if (loaded.kind === "pdf") {
      const host = pages.current;
      if (!host || width === 0) return;
      let rendered: RenderedPdf | null = null;
      let alive = true;
      renderPdf(loaded.bytes, host, width).then(
        (result) => {
          rendered = result;
          if (!alive) result.destroy();
          else if (result.pages > 30)
            setNote(`Mostrando as 30 primeiras de ${result.pages} páginas; salve o arquivo para ver tudo.`);
        },
        () => {
          if (alive) setNote("Não foi possível desenhar o PDF aqui. Salve o arquivo para abri-lo no seu leitor.");
        },
      );
      return () => {
        alive = false;
        rendered?.destroy();
      };
    }
  }, [loaded, width]);

  const imageUrl = useImageUrl(loaded);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Comprovante"
      description={name}
      size="lg"
      footer={
        <>
          <Button
            icon={<Download />}
            disabled={loaded.state !== "ready"}
            onClick={() => loaded.state === "ready" && saveFile(name, loaded.bytes, DOCUMENT_MIME[loaded.kind])}
          >
            Salvar arquivo
          </Button>
          <Button variant="primary" onClick={onClose}>
            Fechar
          </Button>
        </>
      }
    >
      <div ref={measure} className="min-h-40" aria-busy={loaded.state === "loading"}>
        {loaded.state === "loading" ? <Skeleton lines={6} /> : null}
        {loaded.state === "error" ? (
          <p role="alert" className="text-body text-negative">
            {loaded.message}
          </p>
        ) : null}
        {loaded.state === "ready" && loaded.kind === "pdf" ? (
          <div ref={pages} aria-label="Páginas do comprovante" />
        ) : null}
        {loaded.state === "ready" && loaded.kind !== "pdf" && imageUrl ? (
          <img
            src={imageUrl}
            alt={`Comprovante ${name}`}
            className="mx-auto max-h-[70dvh] w-auto max-w-full rounded-md"
          />
        ) : null}
        {note ? <p className="mt-2 text-caption text-secondary">{note}</p> : null}
      </div>
    </Dialog>
  );
}
