/**
 * The original document beside the review (desktop `PdfView` and the evidence of `ImportPage._select_item`):
 * the page where the selected item came from, drawn with pdf.js, with a box around the text the item was read
 * from. A CSV or an OFX has no page: the line of the file and its text are shown instead. The bytes are fetched
 * and decrypted only when this document is shown (`loadDocument`) and live in this tab. A protected PDF asks
 * for its password to be shown; that password opens the view and is not kept.
 */
import { type Id } from "@opesvault/domain";
import { Button, IconButton, Skeleton, useElementWidth, useReduceMotion } from "@opesvault/ui";
import { ChevronLeft, ChevronRight, FileQuestion, KeyRound } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { openPdf } from "../../data/pdf_render.ts";
import { DocumentsPasswordDialog } from "../../dialogs/documents_password.tsx";
import { boxStyle, type EvidenceView } from "./rows.ts";
import { useDocument, usePdfView } from "../../data/use_document.ts";

export interface DocumentViewerProps {
  documentId: Id | null;
  name: string;
  /** The evidence of the selected item. */
  evidence: EvidenceView | null;
}

export function DocumentViewer({ documentId, name, evidence }: DocumentViewerProps) {
  return (
    <section id="importar-original" aria-label="Documento original" className="flex min-w-0 scroll-mt-4 flex-col gap-2">
      <h2 className="text-headline font-semibold">Documento original</h2>
      {documentId === null ? (
        <p className="rounded-lg border border-dashed border-separator-strong px-4 py-10 text-center text-body text-secondary">
          Nenhum documento selecionado.
        </p>
      ) : (
        <Viewing key={documentId} documentId={documentId} name={name} evidence={evidence} />
      )}
    </section>
  );
}

function Viewing({ documentId, name, evidence }: DocumentViewerProps & { documentId: Id }) {
  const reduce = useReduceMotion();
  const [page, setPage] = useState(1);
  const [points, setPoints] = useState<{ width: number; height: number } | null>(null);
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const scroller = useRef<HTMLDivElement | null>(null);
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      scroller.current = node;
      measure(node);
    },
    [measure],
  );
  const host = useRef<HTMLDivElement>(null);
  const boxElement = useRef<HTMLDivElement>(null);

  // The original is fetched when this document is shown, and again if that failed and the person tries once more.
  const { loaded, retry } = useDocument(documentId, "Não foi possível abrir este documento.");
  const isPdf = loaded.state === "ready" && loaded.kind === "pdf";
  // The PDF is opened (with the password the person typed, if any); the handle stays for page changes.
  const {
    opening,
    handle: pdf,
    asking,
    ask,
    stopAsking,
    fail,
    submitPassword,
  } = usePdfView(isPdf ? loaded.bytes : null, openPdf);

  // The page of the selected item is shown.
  const wanted = evidence?.page ?? null;
  const evidenceKey = evidence ? `${evidence.page}|${evidence.box?.join(",")}|${evidence.line}` : "";
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- following the selection is the point
    if (wanted !== null) setPage(wanted);
  }, [wanted, evidenceKey]);

  // Draws the page at the room it has (a new canvas replaces the old one when it is ready).
  const pages = opening.state === "ready" ? opening.pages : 0;
  // Before the first measure (and where nothing is laid out) the page is drawn at a common width.
  const drawWidth = width > 0 ? Math.max(200, Math.round((width - 16) / 8) * 8) : 480;
  const current = Math.min(Math.max(1, page), Math.max(1, pages));
  useEffect(() => {
    const handle = pdf.current;
    if (opening.state !== "ready" || !handle) return;
    let alive = true;
    handle.draw(current, drawWidth).then(
      (drawing) => {
        if (!alive || !host.current) return;
        drawing.canvas.className = "block h-auto w-full rounded-sm bg-white";
        drawing.canvas.setAttribute("role", "img");
        drawing.canvas.setAttribute("aria-label", `Página ${current} de ${pages} de ${name}`);
        host.current.replaceChildren(drawing.canvas);
        setPoints(drawing.points);
      },
      () => {
        if (alive) fail();
      },
    );
    return () => {
      alive = false;
    };
  }, [opening, current, drawWidth, width, pages, name, pdf, fail]);

  // The box is brought to the middle of what is visible.
  const box = evidence?.box && points && evidence.page === current ? boxStyle(evidence.box, points) : null;
  useEffect(() => {
    const element = boxElement.current;
    const area = scroller.current;
    if (!element || !area) return;
    const e = element.getBoundingClientRect();
    const a = area.getBoundingClientRect();
    const top = area.scrollTop + (e.top - a.top) - (a.height / 2 - e.height / 2);
    if (typeof area.scrollTo === "function")
      area.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
  }, [box?.top, box?.left, points, reduce]);

  const needsPassword = opening.state === "password";
  const structured = loaded.state === "ready" && !isPdf;

  return (
    <div className="flex min-w-0 flex-col gap-2" aria-busy={loaded.state === "loading"}>
      {loaded.state === "loading" ? (
        <div role="status" aria-label="Abrindo o documento">
          <Skeleton lines={8} />
        </div>
      ) : null}
      {loaded.state === "error" ? (
        <div role="alert" className="flex flex-col items-start gap-3">
          <p className="text-body text-negative">{loaded.message}</p>
          <Button onClick={retry}>Tentar de novo</Button>
        </div>
      ) : null}

      {isPdf ? (
        <>
          <div className="flex min-h-8 flex-wrap items-center gap-2">
            {pages > 0 ? (
              <>
                <IconButton
                  label="Página anterior"
                  icon={<ChevronLeft />}
                  size="sm"
                  disabled={current <= 1}
                  onClick={() => setPage(current - 1)}
                />
                <span className="text-caption text-secondary" aria-live="polite">
                  Página {current} de {pages}
                </span>
                <IconButton
                  label="Próxima página"
                  icon={<ChevronRight />}
                  size="sm"
                  disabled={current >= pages}
                  onClick={() => setPage(current + 1)}
                />
              </>
            ) : null}
            {needsPassword ? (
              <Button size="sm" variant="primary" icon={<KeyRound />} onClick={ask}>
                Informar senha…
              </Button>
            ) : null}
          </div>
          {needsPassword ? (
            <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-body text-text">
              {opening.incorrect ? "Senha incorreta. Tente de novo." : "Este PDF é protegido por senha."} A senha só
              serve para mostrar o original aqui; a leitura dos itens já foi feita.
            </p>
          ) : null}
          {opening.state === "failed" ? (
            <p role="alert" className="text-body text-negative">
              Não foi possível desenhar este PDF aqui.
            </p>
          ) : null}
          {opening.state === "idle" ? (
            <div role="status" aria-label="Desenhando a página">
              <Skeleton lines={8} />
            </div>
          ) : null}
          <div
            ref={attach}
            tabIndex={0}
            role="region"
            aria-label="Página do documento"
            className={
              opening.state === "ready"
                ? "max-h-[min(78dvh,52rem)] overflow-auto rounded-lg border border-separator bg-sunken p-2"
                : "h-0 overflow-hidden"
            }
          >
            <div className="relative mx-auto w-full">
              <div ref={host} />
              {box ? (
                <motion.div
                  key={`${evidence?.page}:${evidence?.box?.join(",")}`}
                  ref={boxElement}
                  data-evidence-box=""
                  aria-hidden="true"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.04 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.2 }}
                  className="pointer-events-none absolute rounded-sm border-2 border-accent bg-accent/15"
                  style={box}
                />
              ) : null}
            </div>
          </div>
        </>
      ) : null}

      {structured ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-separator-strong px-4 py-8 text-center">
          <FileQuestion aria-hidden="true" className="size-8 text-secondary" />
          <p className="text-body text-secondary">Arquivo estruturado: a linha de origem de cada item aparece aqui.</p>
        </div>
      ) : null}

      {evidence ? (
        <figure aria-label="Evidência do item selecionado" className="rounded-lg bg-sunken px-3 py-2">
          <figcaption className="text-caption font-semibold text-secondary">
            {evidence.page !== null ? `Evidência: página ${evidence.page}` : `Linha ${evidence.line ?? "?"} do arquivo`}
          </figcaption>
          <p className="mt-0.5 font-mono text-caption [overflow-wrap:anywhere] whitespace-pre-wrap">{evidence.text}</p>
        </figure>
      ) : null}

      <DocumentsPasswordDialog
        key={`${documentId}:${asking}`}
        open={asking}
        onClose={stopAsking}
        name={name}
        onSubmit={submitPassword}
      />
    </div>
  );
}
