/**
 * Showing a stored original (Documentos, the receipt of a Livro operation, the review in Importar): the bytes
 * are fetched and decrypted only when shown (`loadDocument`) and live in this tab; an image is shown from a
 * temporary address that goes away with the view; a protected PDF asks for its password, which opens the view
 * and is not kept.
 */
import { DomainError, dom, type Id } from "@opesvault/domain";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { PdfPasswordRequired } from "./pdf_render.ts";
import { useWorkspace } from "./react.tsx";

/** What a stored file is, by its first bytes ("other": CSV, OFX or text). */
export type DocumentKind = "pdf" | "png" | "jpeg" | "other";

export const DOCUMENT_MIME: Record<DocumentKind, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  other: "application/octet-stream",
};

export type LoadedDocument =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; bytes: Uint8Array; kind: DocumentKind };

/**
 * The original of `documentId`, fetched when shown and again on `retry`. A failure the domain explains shows
 * its message; any other shows `failure`.
 */
export function useDocument(documentId: Id, failure: string): { loaded: LoadedDocument; retry: () => void } {
  const workspace = useWorkspace();
  const [loaded, setLoaded] = useState<LoadedDocument>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    workspace.loadDocument(documentId).then(
      (bytes) => {
        if (alive)
          setLoaded({ state: "ready", bytes, kind: (dom.attachments.kindOf(bytes) ?? "other") as DocumentKind });
      },
      (error: unknown) => {
        if (alive) setLoaded({ state: "error", message: error instanceof DomainError ? error.message : failure });
      },
    );
    return () => {
      alive = false;
    };
  }, [workspace, documentId, attempt, failure]);
  const retry = useCallback(() => {
    setLoaded({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { loaded, retry };
}

/** The temporary address of a loaded image (null for anything else), revoked when the view goes. */
export function useImageUrl(loaded: LoadedDocument): string | null {
  const url = useMemo(
    () =>
      loaded.state === "ready" && (loaded.kind === "png" || loaded.kind === "jpeg")
        ? URL.createObjectURL(new Blob([loaded.bytes as BlobPart], { type: DOCUMENT_MIME[loaded.kind] }))
        : null,
    [loaded],
  );
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);
  return url;
}

export type PdfOpening =
  | { state: "idle" }
  | { state: "password"; incorrect: boolean }
  | { state: "ready"; pages: number }
  | { state: "failed" };

export interface PdfView<H> {
  opening: PdfOpening;
  /** What `start` gave for the PDF shown now. */
  handle: RefObject<H | null>;
  /** Whether the password dialog is open. */
  asking: boolean;
  ask: () => void;
  stopAsking: () => void;
  /** The PDF opened but a page could not be drawn. */
  fail: () => void;
  /** For the password dialog: opens the PDF with it, or throws the message to show. */
  submitPassword: (password: string) => Promise<void>;
}

/**
 * Opens `bytes` (a PDF; null: nothing to open) with `start`, which draws or opens it and gives a handle with its
 * page count, or null when there is nowhere to draw yet. A protected PDF waits for its password.
 */
export function usePdfView<H extends { pages: number; destroy: () => void }>(
  bytes: Uint8Array | null,
  start: (bytes: Uint8Array, password?: string) => Promise<H | null>,
): PdfView<H> {
  const [opening, setOpening] = useState<PdfOpening>({ state: "idle" });
  const [asking, setAsking] = useState(false);
  const handle = useRef<H | null>(null);
  const token = useRef(0);
  const latest = useRef(start);
  useEffect(() => {
    latest.current = start;
  });

  const open = useCallback(async (data: Uint8Array, password?: string): Promise<"ok" | "password" | "failed"> => {
    const mine = ++token.current;
    try {
      const result = await latest.current(data, password);
      if (result === null) return "failed";
      if (mine !== token.current) {
        result.destroy();
        return "ok";
      }
      handle.current?.destroy();
      handle.current = result;
      setOpening({ state: "ready", pages: result.pages });
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
  }, []);

  useEffect(() => {
    if (!bytes) return;
    void open(bytes);
    return () => {
      token.current += 1;
      handle.current?.destroy();
      handle.current = null;
    };
  }, [bytes, open]);

  const submitPassword = async (password: string) => {
    if (!bytes) return;
    const outcome = await open(bytes, password);
    if (outcome === "password") throw new DomainError("Senha incorreta. Tente de novo.");
    if (outcome === "failed") throw new DomainError("Não foi possível abrir este PDF.");
  };

  const ask = useCallback(() => setAsking(true), []);
  const stopAsking = useCallback(() => setAsking(false), []);
  const fail = useCallback(() => setOpening({ state: "failed" }), []);
  return { opening, handle, asking, ask, stopAsking, fail, submitPassword };
}
