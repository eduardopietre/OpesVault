/**
 * Opening a receipt (desktop: "Abrir comprovante" went to Documentos): the original is fetched and decrypted
 * on demand (`loadDocument`), then shown here, a PDF drawn page by page and an image as it is, with a button
 * to save the file. The bytes only ever live in this tab.
 */
import { DomainError, dom, type Id } from "@opesvault/domain";
import { Button, Dialog, Skeleton, useElementWidth, saveFile } from "@opesvault/ui";
import { Download } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { renderPdf, type RenderedPdf } from "../../data/pdf_render.ts";
import { useWorkspace } from "../../data/react.tsx";

export interface ReceiptDialogProps {
  open: boolean;
  onClose: () => void;
  documentId: Id;
}

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; bytes: Uint8Array; kind: "pdf" | "png" | "jpeg" };

export function ReceiptDialog({ open, onClose, documentId }: ReceiptDialogProps) {
  const workspace = useWorkspace();
  const meta = workspace.session.documents.find((d) => d.meta.id === documentId)?.meta;
  const name = meta?.original_name ?? "comprovante";
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const pages = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    workspace.loadDocument(documentId).then(
      (bytes) => {
        if (!alive) return;
        const kind = dom.attachments.kindOf(bytes);
        if (kind === null) setLoaded({ state: "error", message: "Este arquivo não é um PDF nem uma imagem." });
        else setLoaded({ state: "ready", bytes, kind: kind as "pdf" | "png" | "jpeg" });
      },
      (error: unknown) => {
        if (!alive) return;
        setLoaded({
          state: "error",
          message: error instanceof DomainError ? error.message : "Não foi possível abrir o comprovante.",
        });
      },
    );
    return () => {
      alive = false;
    };
  }, [workspace, documentId]);

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

  // An image is shown from a temporary address that goes away with the dialog.
  const imageUrl = useMemo(
    () =>
      loaded.state === "ready" && loaded.kind !== "pdf"
        ? URL.createObjectURL(new Blob([loaded.bytes as BlobPart], { type: `image/${loaded.kind}` }))
        : null,
    [loaded],
  );
  useEffect(() => () => (imageUrl ? URL.revokeObjectURL(imageUrl) : undefined), [imageUrl]);

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
            onClick={() => loaded.state === "ready" && saveFile(name, loaded.bytes, mime(loaded.kind))}
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

function mime(kind: "pdf" | "png" | "jpeg"): string {
  return kind === "pdf" ? "application/pdf" : `image/${kind}`;
}
