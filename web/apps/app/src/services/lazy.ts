/**
 * AppServices that load their implementation on first use. The real services bring the vault, the
 * cryptography (Argon2id as WebAssembly) and the whole domain; the welcome and sign-in screens show without
 * them, and the code arrives while the person types.
 */
import type { AppServices } from "./types.ts";

export function lazyServices(load: () => Promise<AppServices>): AppServices {
  let loaded: Promise<AppServices> | null = null;
  const services = () => (loaded ??= load());
  const handler: ProxyHandler<object> = {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      if (name === "watchSync") {
        return (listener: Parameters<AppServices["watchSync"]>[0]) => {
          let stop: (() => void) | null = null;
          let cancelled = false;
          void services().then((s) => {
            if (!cancelled) stop = s.watchSync(listener);
          });
          return () => {
            cancelled = true;
            stop?.();
          };
        };
      }
      if (name === "setIdleLock") {
        return (minutes: number) => void services().then((s) => s.setIdleLock(minutes));
      }
      return (...args: unknown[]) =>
        services().then((s) => (s as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!(...args));
    },
  };
  return new Proxy({}, handler) as AppServices;
}
