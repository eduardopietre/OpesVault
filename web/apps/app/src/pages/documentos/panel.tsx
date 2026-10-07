/**
 * The selected document (desktop `PdfView` plus the page's "Abrir na revisão"): what uses it, and the original
 * itself. The bytes are fetched and decrypted only now (`loadDocument`) and live in this tab; a PDF is drawn
 * page by page with pdf.js, an image is shown as it is. A protected PDF asks for its password once and does not
 * keep it.
 */
import { DomainError, dom, formatDateBr, type Id } from "@opesvault/domain";
import { Button, ElidedText, Skeleton, useMotionPreset } from "@opesvault/ui";
import { Download, FileQuestion, KeyRound, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PdfPasswordRequired, renderPdf, type RenderedPdf } from "../../data/pdf_render.ts";
import { useWorkspace } from "../../data/react.tsx";
import { DocumentsPasswordDialog } from "../../dialogs/documents_password.tsx";
import { fileSize, usedBy, type DocumentRow, type ReceiptUse } from "./rows.ts";
import { READ_ONLY_TIP } from "../../data/read_only.ts";

type Kind = "pdf" | "png" | "jpeg" | "other";

type Loaded =
  { state: "loading" } | { state: "error"; message: string } | { state: "ready"; bytes: Uint8Array; kind: Kind };

type Drawing =
  | { state: "idle" }
  | { state: "password"; incorrect: boolean }
  | { state: "ready"; pages: number }
  | { state: "failed" };

const MAX_PAGES = 30;

export interface DocumentPanelProps {
  row: DocumentRow;
  locked: boolean;
  onSeeImport: (batchId: Id) => void;
  onSeeOperation: (operationId: Id) => void;
  onDetach: (row: DocumentRow, use: ReceiptUse) => void;
  onRemove: (row: DocumentRow) => void;
  onSave: (row: DocumentRow, bytes: Uint8Array, kind: Kind) => void;
}

export function DocumentPanel({
  row,
  locked,
  onSeeImport,
  onSeeOperation,
  onDetach,
  onRemove,
  onSave,
}: DocumentPanelProps) {
  const workspace = useWorkspace();
  const preset = useMotionPreset();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [drawing, setDrawing] = useState<Drawing>({ state: "idle" });
  const [asking, setAsking] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const rendered = useRef<RenderedPdf | null>(null);
  const token = useRef(0);

  // The original is fetched when this document is shown, and again if that failed and the user tries once more.
  useEffect(() => {
    let alive = true;
    workspace.loadDocument(row.id).then(
      (bytes) => {
        if (!alive) return;
        const kind = dom.attachments.kindOf(bytes);
        setLoaded({ state: "ready", bytes, kind: (kind ?? "other") as Kind });
      },
      (error: unknown) => {
        if (!alive) return;
        setLoaded({
          state: "error",
          message: error instanceof DomainError ? error.message : "Não foi possível abrir este documento.",
        });
      },
    );
    return () => {
      alive = false;
    };
  }, [workspace, row.id, attempt]);

  const draw = useCallback(async (bytes: Uint8Array, password?: string): Promise<"ok" | "password" | "failed"> => {
    const host = pages.current;
    if (!host) return "failed";
    const mine = ++token.current;
    try {
      const result = await renderPdf(
        bytes,
        host,
        Math.min(Math.max(box.current?.getBoundingClientRect().width || 720, 480), 1000),
        MAX_PAGES,
        password,
      );
      if (mine !== token.current) {
        result.destroy();
        return "ok";
      }
      rendered.current?.destroy();
      rendered.current = result;
      setDrawing({ state: "ready", pages: result.pages });
      return "ok";
    } catch (error) {
      if (mine !== token.current) return "ok";
      if (error instanceof PdfPasswordRequired) {
        setDrawing({ state: "password", incorrect: error.incorrect });
        return "password";
      }
      setDrawing({ state: "failed" });
      return "failed";
    }
  }, []);

  useEffect(() => {
    if (loaded.state !== "ready" || loaded.kind !== "pdf") return;
    void draw(loaded.bytes);
    return () => {
      token.current += 1;
      rendered.current?.destroy();
      rendered.current = null;
    };
  }, [loaded, draw]);

  // An image is shown from a temporary address that goes away with the panel.
  const imageUrl = useMemo(
    () =>
      loaded.state === "ready" && (loaded.kind === "png" || loaded.kind === "jpeg")
        ? URL.createObjectURL(new Blob([loaded.bytes as BlobPart], { type: `image/${loaded.kind}` }))
        : null,
    [loaded],
  );
  useEffect(() => () => (imageUrl ? URL.revokeObjectURL(imageUrl) : undefined), [imageUrl]);

  const submitPassword = async (password: string) => {
    if (loaded.state !== "ready") return;
    const outcome = await draw(loaded.bytes, password);
    if (outcome === "password") throw new DomainError("Senha incorreta. Tente de novo.");
    if (outcome === "failed") throw new DomainError("Não foi possível abrir este PDF.");
  };

  const needsPassword = drawing.state === "password";
  const ready = loaded.state === "ready";
  const tip = locked ? READ_ONLY_TIP : undefined;
  const removeNote = !row.free ? `Em uso por ${usedBy(row)}: desfaça o vínculo para poder remover.` : null;

  return (
    <motion.section
      aria-label="Documento selecionado"
      {...preset.enter}
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-separator bg-raised p-4 shadow-sm"
    >
      <div className="min-w-0">
        <h2 className="text-headline font-semibold">
          <ElidedText>{row.name}</ElidedText>
        </h2>
        <p className="mt-0.5 text-caption text-secondary">
          {fileSize(row.size)} · SHA-256 <span className="font-mono">{row.sha256.slice(0, 12)}…</span>
        </p>
      </div>

      <div className="flex flex-col gap-2" role="group" aria-label="O que usa este documento">
        <h3 className="text-caption font-semibold text-secondary">Usado por</h3>
        {row.batchId ? (
          <UseLine
            text={`Importação (${row.batchStatus ?? "—"}) · ${row.where}`}
            action={
              <Button size="sm" onClick={() => onSeeImport(row.batchId as Id)}>
                Ver importação
              </Button>
            }
          />
        ) : null}
        {row.receipts.map((use) => (
          <UseLine
            key={use.operationId}
            text={`Comprovante de “${use.description}”${use.date ? ` · ${formatDateBr(use.date)}` : ""}`}
            action={
              <span className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  aria-label={`Ver lançamento: ${use.description}`}
                  onClick={() => onSeeOperation(use.operationId)}
                >
                  Ver lançamento
                </Button>
                <Button
                  size="sm"
                  tone="negative"
                  aria-label={`Desvincular de ${use.description}`}
                  disabled={locked}
                  title={tip}
                  onClick={() => onDetach(row, use)}
                >
                  Desvincular…
                </Button>
              </span>
            }
          />
        ))}
        {row.free ? <p className="text-body text-secondary">Nada usa este documento.</p> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {needsPassword ? (
          <Button variant="primary" icon={<KeyRound />} onClick={() => setAsking(true)}>
            Informar senha…
          </Button>
        ) : null}
        <Button
          icon={<Download />}
          disabled={!ready}
          onClick={() => loaded.state === "ready" && onSave(row, loaded.bytes, loaded.kind)}
        >
          Salvar o original…
        </Button>
        <Button
          icon={<Trash2 />}
          tone="negative"
          disabled={locked || !row.free}
          title={tip ?? removeNote ?? undefined}
          onClick={() => onRemove(row)}
        >
          Remover…
        </Button>
      </div>
      {removeNote ? <p className="-mt-2 text-caption text-secondary">{removeNote}</p> : null}

      <div
        ref={box}
        className="min-h-40 min-w-0"
        aria-busy={
          loaded.state === "loading" || (loaded.state === "ready" && loaded.kind === "pdf" && drawing.state === "idle")
        }
      >
        {loaded.state === "loading" ? (
          <div role="status" aria-label="Abrindo o documento">
            <Skeleton lines={8} />
          </div>
        ) : null}
        {loaded.state === "error" ? (
          <div role="alert" className="flex flex-col items-start gap-3">
            <p className="text-body text-negative">{loaded.message}</p>
            <Button
              onClick={() => {
                setLoaded({ state: "loading" });
                setAttempt((n) => n + 1);
              }}
            >
              Tentar de novo
            </Button>
          </div>
        ) : null}
        {loaded.state === "ready" && loaded.kind === "pdf" ? (
          <div className="flex flex-col gap-2">
            {needsPassword ? (
              <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-body text-text">
                {drawing.incorrect ? "Senha incorreta. Tente de novo." : "Este PDF é protegido por senha."}
              </p>
            ) : null}
            {drawing.state === "failed" ? (
              <p role="alert" className="text-body text-negative">
                Não foi possível desenhar este PDF aqui. Salve o original para abri-lo no seu leitor.
              </p>
            ) : null}
            {drawing.state === "ready" && drawing.pages > MAX_PAGES ? (
              <p className="text-caption text-secondary">
                Mostrando as {MAX_PAGES} primeiras de {drawing.pages} páginas; salve o original para ver tudo.
              </p>
            ) : null}
            {drawing.state === "ready" ? (
              <p className="text-caption text-secondary">
                {drawing.pages === 1 ? "1 página" : `${drawing.pages} páginas`}
              </p>
            ) : null}
            {drawing.state === "idle" ? (
              <div role="status" aria-label="Desenhando as páginas">
                <Skeleton lines={8} />
              </div>
            ) : null}
            <div
              ref={pages}
              role="region"
              tabIndex={0}
              aria-label="Páginas do documento"
              className="max-h-[70dvh] overflow-y-auto rounded-md [&>canvas:last-child]:mb-0"
            />
          </div>
        ) : null}
        {loaded.state === "ready" && imageUrl ? (
          <img
            src={imageUrl}
            alt={`Documento ${row.name}`}
            className="mx-auto max-h-[70dvh] w-auto max-w-full rounded-md border border-separator"
          />
        ) : null}
        {loaded.state === "ready" && loaded.kind === "other" ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <FileQuestion aria-hidden="true" className="size-8 text-secondary" />
            <p className="text-body text-secondary">Arquivo estruturado (CSV/OFX): sem visualização de página.</p>
          </div>
        ) : null}
      </div>

      <DocumentsPasswordDialog
        key={`${row.id}:${asking}`}
        open={asking}
        onClose={() => setAsking(false)}
        name={row.name}
        onSubmit={submitPassword}
      />
    </motion.section>
  );
}

function UseLine({ text, action }: { text: string; action: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-lg bg-window/60 px-3 py-2">
      <span className="min-w-0 flex-1 basis-48 text-body [overflow-wrap:anywhere]">{text}</span>
      {action}
    </div>
  );
}
