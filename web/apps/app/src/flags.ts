/** Build flags. The component catalog exists in development and in the e2e build (VITE_CATALOG=1). */
export const SHOW_CATALOG: boolean = import.meta.env.DEV || import.meta.env.VITE_CATALOG === "1";

/**
 * Which services answer. Production talks to the server and the encrypted vault; development and the e2e
 * build use the in-memory fake unless VITE_SERVICES=real (a local server on the same origin or proxied).
 */
export const USE_FAKE_SERVICES: boolean =
  import.meta.env.VITE_SERVICES === "fake" ||
  (import.meta.env.VITE_SERVICES !== "real" && (import.meta.env.DEV || import.meta.env.VITE_CATALOG === "1"));
