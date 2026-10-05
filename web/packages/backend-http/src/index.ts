/**
 * `SyncBackend` over the self-hosted server's HTTP API (`apps/server`, docs/20).
 *
 * - Same-origin by default (`/api/v1`), cookies included, the CSRF header on every request.
 * - HTTP errors become `BackendError` codes; a network failure (or a proxy that cannot reach the
 *   server) is `offline`, so the vault keeps changes queued and retries.
 * - Responses are validated with zod at this boundary: a malformed answer is `server`.
 */
import {
  BackendError,
  type AccountSession,
  type B64,
  type BackendErrorCode,
  type EditLease,
  type Envelope,
  type EnvelopeContent,
  type ProjectMember,
  type ProjectSummary,
  type PullResult,
  type PushRecord,
  type PushResult,
  type SyncBackend,
} from "@opesvault/vault";
import { z } from "zod";

export const CSRF_HEADER = "X-OpesVault";
export const LEASE_HEADER = "X-OpesVault-Lease";

const CODES: readonly BackendErrorCode[] = [
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "lease_held",
  "no_lease",
  "too_large",
  "rate_limited",
  "offline",
  "invalid",
  "server",
];

function codeForStatus(status: number): BackendErrorCode {
  switch (status) {
    case 400:
      return "invalid";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "too_large";
    case 423:
      return "lease_held";
    case 429:
      return "rate_limited";
    case 502:
    case 503:
    case 504:
      return "offline";
    default:
      return "server";
  }
}

const Role = z.enum(["owner", "member"]);
const Session = z.object({ accountId: z.string(), email: z.string() });
const Summary = z.object({
  projectId: z.string(),
  sealedName: z.string(),
  createdAt: z.string(),
  revision: z.number().int(),
  role: Role,
});
const EnvelopeSchema = z.object({
  version: z.number().int(),
  kdf: z.object({
    algorithm: z.literal("argon2id"),
    memoryKiB: z.number().int(),
    iterations: z.number().int(),
    parallelism: z.number().int(),
    salt: z.string(),
  }),
  wrappedByPassword: z.string(),
  recoverySalt: z.string().nullable(),
  wrappedByRecovery: z.string().nullable(),
  revision: z.number().int(),
});
const Member = z.object({ accountId: z.string(), email: z.string(), role: Role });
const Lease = z.object({
  leaseId: z.string(),
  holder: z.string(),
  accountId: z.string(),
  email: z.string(),
  expiresAt: z.string(),
});
const Pull = z.object({
  revision: z.number().int(),
  records: z.array(z.object({ id: z.string(), revision: z.number().int(), ciphertext: z.string().nullable() })),
  more: z.boolean(),
});
const Push = z.object({ ok: z.boolean(), revision: z.number().int(), conflicts: z.array(z.string()) });

export interface HttpBackendOptions {
  /** Origin of the server; empty for the same origin as the app (the default). */
  readonly baseUrl?: string;
  /** Injected in tests (a cookie jar for Node); the browser's fetch otherwise. */
  readonly fetch?: typeof fetch;
}

interface RequestOptions {
  readonly json?: unknown;
  readonly bytes?: Uint8Array;
  readonly headers?: Record<string, string>;
  readonly query?: Record<string, string>;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

export class HttpBackend implements SyncBackend {
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(options: HttpBackendOptions = {}) {
    this.#base = `${(options.baseUrl ?? "").replace(/\/+$/, "")}/api/v1`;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async #send(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { [CSRF_HEADER]: "1", ...options.headers };
    let body: BodyInit | undefined;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.bytes !== undefined) {
      headers["Content-Type"] = "application/octet-stream";
      body = options.bytes as Uint8Array<ArrayBuffer>;
    }
    const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
    const attempt = () =>
      this.#fetch(`${this.#base}${path}${query}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      });
    let response: Response;
    try {
      response = await attempt();
    } catch {
      // A reused connection the server already closed fails at once; an idempotent read is
      // retried once on a new connection. Writes are never retried here: the vault decides.
      if (method !== "GET") throw new BackendError("offline");
      try {
        response = await attempt();
      } catch {
        throw new BackendError("offline");
      }
    }
    if (response.ok) return response;
    let code = codeForStatus(response.status);
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload.error === "string" && (CODES as readonly string[]).includes(payload.error)) {
        code = payload.error as BackendErrorCode;
      }
    } catch {
      // Not our JSON (a proxy page): keep the status mapping.
    }
    throw new BackendError(code);
  }

  async #json<T extends z.ZodType>(schema: T, method: string, path: string, options?: RequestOptions) {
    const response = await this.#send(method, path, options);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new BackendError("offline");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new BackendError("server");
    return parsed.data as z.output<T>;
  }

  async #none(method: string, path: string, options?: RequestOptions): Promise<void> {
    const response = await this.#send(method, path, options);
    await response.body?.cancel();
  }

  #project(projectId: string): string {
    return `/projects/${segment(projectId)}`;
  }

  // accounts

  signUp(email: string, loginSecret: B64): Promise<AccountSession> {
    return this.#json(Session, "POST", "/auth/signup", { json: { email, loginSecret } });
  }

  signIn(email: string, loginSecret: B64): Promise<AccountSession> {
    return this.#json(Session, "POST", "/auth/signin", { json: { email, loginSecret } });
  }

  signOut(): Promise<void> {
    return this.#none("POST", "/auth/signout");
  }

  async currentSession(): Promise<AccountSession | null> {
    return (await this.#json(z.object({ session: Session.nullable() }), "GET", "/auth/session")).session;
  }

  async loginSalt(email: string): Promise<B64> {
    return (await this.#json(z.object({ salt: z.string() }), "POST", "/auth/salt", { json: { email } })).salt;
  }

  // projects

  async listProjects(): Promise<readonly ProjectSummary[]> {
    return (await this.#json(z.object({ projects: z.array(Summary) }), "GET", "/projects")).projects;
  }

  createProject(projectId: string, sealedName: B64, envelope: EnvelopeContent): Promise<ProjectSummary> {
    return this.#json(Summary, "POST", "/projects", {
      json: {
        projectId,
        sealedName,
        envelope: {
          version: envelope.version,
          kdf: envelope.kdf,
          wrappedByPassword: envelope.wrappedByPassword,
          recoverySalt: envelope.recoverySalt,
          wrappedByRecovery: envelope.wrappedByRecovery,
        },
      },
    });
  }

  renameProject(projectId: string, sealedName: B64): Promise<void> {
    return this.#none("PATCH", this.#project(projectId), { json: { sealedName } });
  }

  deleteProject(projectId: string): Promise<void> {
    return this.#none("DELETE", this.#project(projectId));
  }

  async listMembers(projectId: string): Promise<readonly ProjectMember[]> {
    const path = `${this.#project(projectId)}/members`;
    return (await this.#json(z.object({ members: z.array(Member) }), "GET", path)).members;
  }

  addMember(projectId: string, email: string): Promise<ProjectMember> {
    return this.#json(Member, "POST", `${this.#project(projectId)}/members`, { json: { email } });
  }

  removeMember(projectId: string, accountId: string): Promise<void> {
    return this.#none("DELETE", `${this.#project(projectId)}/members/${segment(accountId)}`);
  }

  getEnvelope(projectId: string): Promise<Envelope> {
    return this.#json(EnvelopeSchema, "GET", `${this.#project(projectId)}/envelope`);
  }

  putEnvelope(projectId: string, envelope: EnvelopeContent, expectedRevision: number): Promise<Envelope> {
    return this.#json(EnvelopeSchema, "PUT", `${this.#project(projectId)}/envelope`, {
      json: {
        envelope: {
          version: envelope.version,
          kdf: envelope.kdf,
          wrappedByPassword: envelope.wrappedByPassword,
          recoverySalt: envelope.recoverySalt,
          wrappedByRecovery: envelope.wrappedByRecovery,
        },
        expectedRevision,
      },
    });
  }

  // records

  pull(projectId: string, sinceRevision: number, limit?: number): Promise<PullResult> {
    if (!Number.isSafeInteger(sinceRevision) || sinceRevision < 0) return Promise.reject(new BackendError("invalid"));
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      return Promise.reject(new BackendError("invalid"));
    }
    const query: Record<string, string> = { since: String(sinceRevision) };
    if (limit !== undefined) query.limit = String(Math.min(limit, 999_999));
    return this.#json(Pull, "GET", `${this.#project(projectId)}/records`, { query });
  }

  push(projectId: string, leaseId: string, records: readonly PushRecord[]): Promise<PushResult> {
    return this.#json(Push, "POST", `${this.#project(projectId)}/records`, { json: { leaseId, records } });
  }

  // blobs

  putBlob(projectId: string, leaseId: string, blobId: string, data: Uint8Array): Promise<void> {
    return this.#none("PUT", `${this.#project(projectId)}/blobs/${segment(blobId)}`, {
      bytes: data,
      headers: { [LEASE_HEADER]: leaseId },
    });
  }

  async getBlob(projectId: string, blobId: string): Promise<Uint8Array> {
    const response = await this.#send("GET", `${this.#project(projectId)}/blobs/${segment(blobId)}`);
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new BackendError("offline");
    }
  }

  deleteBlob(projectId: string, leaseId: string, blobId: string): Promise<void> {
    return this.#none("DELETE", `${this.#project(projectId)}/blobs/${segment(blobId)}`, {
      headers: { [LEASE_HEADER]: leaseId },
    });
  }

  // edit lease

  acquireEditLease(projectId: string, holder: string, takeOver = false): Promise<EditLease> {
    return this.#json(Lease, "POST", `${this.#project(projectId)}/lease`, { json: { holder, takeOver } });
  }

  renewEditLease(projectId: string, leaseId: string): Promise<EditLease> {
    return this.#json(Lease, "POST", `${this.#project(projectId)}/lease/renew`, { json: { leaseId } });
  }

  releaseEditLease(projectId: string, leaseId: string): Promise<void> {
    return this.#none("POST", `${this.#project(projectId)}/lease/release`, { json: { leaseId } });
  }

  async currentLease(projectId: string): Promise<EditLease | null> {
    const path = `${this.#project(projectId)}/lease`;
    return (await this.#json(z.object({ lease: Lease.nullable() }), "GET", path)).lease;
  }
}

/**
 * A fetch with its own cookie jar, for Node (tests, tools): the browser keeps cookies itself.
 * Each instance is one "browser".
 */
export function cookieJarFetch(base: typeof fetch = globalThis.fetch): typeof fetch {
  const jar = new Map<string, string>();
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (jar.size > 0) headers.set("Cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
    const response = await base(input, { ...init, headers });
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const index = pair!.indexOf("=");
      const name = pair!.slice(0, index).trim();
      const value = pair!.slice(index + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute)) || value === "";
      if (expired) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
}
