/** Build flags. The component catalog exists in development and in the e2e build (VITE_CATALOG=1). */
export const SHOW_CATALOG: boolean = import.meta.env.DEV || import.meta.env.VITE_CATALOG === "1";

/** The fake services answer for now (the vault and the server arrive with W1/W2). */
export const USE_FAKE_SERVICES = true;
