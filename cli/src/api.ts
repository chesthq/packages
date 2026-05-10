/**
 * Bearer-auth client for owner-scoped chest.sh endpoints.
 *
 * The CLI mints a `ca_live_*` token at `chest-gate login` and the server
 * accepts it on every dashboard endpoint (see chest-gate#171). This helper
 * wraps the boilerplate: load creds, attach Authorization, give a clean
 * "not logged in" error when missing.
 */

import { loadCredentials, type ResolvedCredentials } from "./credentials.js";

export class NotLoggedInError extends Error {
  constructor() {
    super("Not logged in. Run `chest-gate login` first.");
    this.name = "NotLoggedInError";
  }
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

interface ApiOptions {
  /** Override the gate URL (default: creds.gateUrl, then CHEST_SERVER, then https://gate.chest.sh). */
  server?: string;
  /** HTTP method, default GET. */
  method?: string;
  /** JSON body. Will be stringified and content-type set. */
  body?: unknown;
  /** Pre-loaded creds, skips the disk read. */
  creds?: ResolvedCredentials;
}

/**
 * Call an authenticated chest.sh endpoint and return the parsed JSON body.
 * Throws NotLoggedInError if no CLI token is available, ApiError otherwise.
 */
export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const creds = opts.creds ?? (await loadCredentials());
  if (!creds) throw new NotLoggedInError();

  const base = (opts.server || creds.gateUrl).replace(/\/$/, "");
  const url = path.startsWith("http") ? path : `${base}${path}`;

  const headers: Record<string, string> = {
    authorization: `Bearer ${creds.token}`,
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, { method: opts.method ?? "GET", headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as text
    }
  }

  if (!res.ok) {
    const errMsg =
      parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)
        ? String((parsed as Record<string, unknown>).error)
        : res.statusText || `HTTP ${res.status}`;
    throw new ApiError(res.status, parsed, errMsg);
  }

  return parsed as T;
}

/** Resolve the server origin the CLI should call (creds.gateUrl wins, then env, then default). */
export async function resolveServer(override?: string): Promise<string> {
  if (override) return override.replace(/\/$/, "");
  const creds = await loadCredentials();
  if (creds?.gateUrl) return creds.gateUrl.replace(/\/$/, "");
  return (process.env.CHEST_SERVER || "https://gate.chest.sh").replace(/\/$/, "");
}
