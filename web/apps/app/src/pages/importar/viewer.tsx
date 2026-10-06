/**
 * The original document beside the review (desktop `PdfView` and the evidence of `ImportPage._select_item`):
 * the page where the selected item came from, drawn with pdf.js, with a box around the text the item was read
 * from. A CSV or an OFX has no page: the line of the file and its text are shown instead. The bytes are fetched
 * and decrypted only when this document is shown (`loadDocument`) and live in this tab. A protected PDF asks
 * for its password to be shown; that password opens the view and is not kept.
 */
import { DomainError, dom, type Id } from "@opesvault/domain";
import { Button, IconButton, Skeleton, useElementWidth, useReduceMotion } from "@opesvault/ui";
import { ChevronLeft, ChevronRight, FileQuestion, KeyRound } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PdfPasswordRequired, openPdf, type OpenPdf } from "../../data/pdf_render.ts";
import { useWorkspace } from "../../data/react.tsx";
import { DocumentsPasswordDialog } from "../../dialogs/documents_password.tsx";
import { boxStyle, type EvidenceView } from "./rows.ts";

type Loaded =
  { state: "loading" } | { state: "error"; message: string } | { state: "ready"; bytes: Uint8Array; pdf: boolean };

type Opening =
  | { state: "idle" }
  | { state: "password"; incorrect: boolean }
  | { state: "ready"; pages: number }
  | { state: "failed" };

export interface DocumentViewerProps {
  documentId: Id | null;
  name: string;
  /** The evidence of the selected item. */
  evidence: EvidenceView | null;
}

export function DocumentViewer({ documentId, name, evidence }: DocumentViewerProps) {
  return (
    <section aria-label="Documento original" className="flex min-w-0 flex-col gap-2">
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
  const workspace = useWorkspace();
  const reduce = useReduceMotion();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState<Opening>({ state: "idle" });
  const [asking, setAsking] = useState(false);
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
  const pdf = useRef<OpenPdf | null>(null);
  const token = useRef(0);

  // The original is fetched when this document is shown, and again if that failed and the person tries once more.
  useEffect(() => {
    let alive = true;
    workspace.loadDocument(documentId).then(
      (bytes) => {
        if (!alive) return;
        setLoaded({ state: "ready", bytes, pdf: dom.attachments.kindOf(bytes) === "pdf" });
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
  }, [workspace, documentId, attempt]);

  /** Opens the PDF (with the password the person typed, if any); the handle stays for page changes. */
  const open = async (bytes: Uint8Array, password?: string): Promise<"ok" | "password" | "failed"> => {
    const mine = ++token.current;
    try {
      const opened = await openPdf(bytes, password);
      if (mine !== token.current) {
        opened.destroy();
        return "ok";
      }
      pdf.current?.destroy();
      pdf.current = opened;
      setOpening({ state: "ready", pages: opened.pages });
      return "ok";
    } catch (error) {
      if (mine !== token.current) return "ok";
      if (error instanceof PdfPasswordRequired) {
        setOpening({ state: "password", incorrect: error.incorrect });
        return "password";
      }
      setOpening({ state: "failed" });
      return "failed";
    }
  };

  useEffect(() => {
    if (loaded.state !== "ready" || !loaded.pdf) return;
    const bytes = loaded.bytes;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening the file is the effect; its outcome is state
    void open(bytes);
    return () => {
      token.current += 1;
      pdf.current?.destroy();
      pdf.current = null;
    };
  }, [loaded]);

  const submitPassword = async (password: string) => {
    if (loaded.state !== "ready") return;
    const outcome = await open(loaded.bytes, password);
    if (outcome === "password") throw new DomainError("Senha incorreta. Tente de novo.");
    if (outcome === "failed") throw new DomainError("Não foi possível abrir este PDF.");
  };

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
        if (alive) setOpening({ state: "failed" });
      },
    );
    return () => {
      alive = false;
    };
  }, [opening, current, drawWidth, width, pages, name]);

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
  const structured = loaded.state === "ready" && !loaded.pdf;

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

      {loaded.state === "ready" && loaded.pdf ? (
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
              <Button size="sm" variant="primary" icon={<KeyRound />} onClick={() => setAsking(true)}>
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
        onClose={() => setAsking(false)}
        name={name}
        onSubmit={submitPassword}
      />
    </div>
  );
}
