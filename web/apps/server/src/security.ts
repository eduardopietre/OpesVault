import { cspHeader } from "@opesvault/vault";

/** Security headers for every response (docs/18 §3.7, docs/19 §12). The CSP comes from `@opesvault/vault`: one source, also used by the app build. */
export function contentSecurityPolicy(secure: boolean): string {
  return cspHeader(secure);
}

const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "serial=()",
  "usb=()",
].join(", ");

export function securityHeaders(secure: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": contentSecurityPolicy(secure),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
  if (secure) headers["Strict-Transport-Security"] = "max-age=31536000";
  return headers;
}
