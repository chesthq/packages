/**
 * @chest-gate/auth-flow — PKCE loopback login flow for Chest Gate clients.
 *
 * Wraps the device-pairing pattern shared by `chest-gate login` and
 * `npx @chest-gate/install`: bind a loopback server, open the browser to
 * `chest.sh/cli/login`, await the callback, exchange `code+verifier` at
 * `gate.chest.sh/v1/cli/exchange`, return the freshly-minted agent token.
 *
 * The token returned is an ordinary `ca_live_…` agent token bound to the
 * Privy-authenticated user's wallet — the same kind paste-flow users mint
 * at `chest.sh/dashboard/agent-wallet`. Per-device, revocable, no scope
 * differences today.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import open from "open";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface PkceLoginArgs {
  /** chest.sh web base URL, e.g. `https://chest.sh`. */
  webUrl: string;
  /** gate.chest.sh API base URL, e.g. `https://gate.chest.sh`. */
  gateUrl: string;
  /** Hostname recorded in the token label (e.g. "alice-laptop"). */
  hostname: string;
  /** Loopback port. Default: random free port. */
  desiredPort?: number;
  /** Open the browser automatically. Default: true. */
  openBrowser?: boolean;
  /** Called once when the loopback is bound — caller prints UI. */
  onListen?: (info: { loginUrl: string; port: number }) => void;
  /** Browser-callback timeout. Default: 5 min. */
  timeoutMs?: number;
}

export interface PkceLoginResult {
  /** Plaintext `ca_live_…` token, single-use code already exchanged. */
  token: string;
  /** Solana wallet the token is bound to. */
  ownerWallet: string;
  /** Server-side row id (for revocation). */
  tokenId: string;
  /** Human label assigned to the token (e.g. "CLI: alice-laptop"). */
  label: string;
}

export type PkceLoginErrorKind =
  | "browser"
  | "state"
  | "missing-code"
  | "timeout"
  | "exchange"
  | "loopback";

export class PkceLoginError extends Error {
  constructor(
    public readonly kind: PkceLoginErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "PkceLoginError";
  }
}

/**
 * Run the full PKCE loopback flow and return the minted token.
 *
 * @throws PkceLoginError on any failure (browser error, state mismatch,
 *   missing code, timeout, exchange failure, loopback bind failure).
 */
export async function runPkceLogin(args: PkceLoginArgs): Promise<PkceLoginResult> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(24));

  const code = await runLoopbackFlow({
    webUrl: args.webUrl.replace(/\/$/, ""),
    state,
    challenge,
    hostname: args.hostname,
    desiredPort: args.desiredPort ?? 0,
    openBrowser: args.openBrowser ?? true,
    onListen: args.onListen,
    timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  return exchangeCode({
    gateUrl: args.gateUrl.replace(/\/$/, ""),
    code,
    verifier,
  });
}

interface LoopbackArgs {
  webUrl: string;
  state: string;
  challenge: string;
  hostname: string;
  desiredPort: number;
  openBrowser: boolean;
  onListen?: (info: { loginUrl: string; port: number }) => void;
  timeoutMs: number;
}

function runLoopbackFlow(args: LoopbackArgs): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, code?: string) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {}
      clearTimeout(timer);
      if (err) reject(err);
      else if (code) resolve(code);
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const recvState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const errorParam = url.searchParams.get("error");

      if (errorParam) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(htmlPage("Login failed", errorParam, false));
        finish(new PkceLoginError("browser", `Browser returned error: ${errorParam}`));
        return;
      }
      if (!recvState || recvState !== args.state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(htmlPage("Invalid state", "State mismatch. Try again.", false));
        finish(new PkceLoginError("state", "State mismatch on callback (possible CSRF)."));
        return;
      }
      if (!code) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(htmlPage("Missing code", "No authorization code on the callback.", false));
        finish(new PkceLoginError("missing-code", "Callback missing code parameter."));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(htmlPage("You're signed in", "You can close this tab and return to the terminal.", true));
      finish(null, code);
    });

    server.on("error", (err) => {
      finish(new PkceLoginError("loopback", `Loopback server failed: ${err.message}`));
    });

    server.listen(args.desiredPort, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        finish(new PkceLoginError("loopback", "Could not bind loopback server."));
        return;
      }
      const port = addr.port;
      const params = new URLSearchParams({
        state: args.state,
        challenge: args.challenge,
        port: String(port),
        hostname: args.hostname,
      });
      const loginUrl = `${args.webUrl}/cli/login?${params.toString()}`;
      args.onListen?.({ loginUrl, port });
      if (args.openBrowser) {
        open(loginUrl).catch(() => {
          // Non-fatal; the user can still copy the URL printed by onListen.
        });
      }
    });

    const timer = setTimeout(() => {
      finish(
        new PkceLoginError(
          "timeout",
          `Timed out waiting for browser sign-in (${Math.round(args.timeoutMs / 60000)} min).`,
        ),
      );
    }, args.timeoutMs);
  });
}

interface ExchangeArgs {
  gateUrl: string;
  code: string;
  verifier: string;
}

async function exchangeCode(args: ExchangeArgs): Promise<PkceLoginResult> {
  let res: Response;
  try {
    res = await fetch(`${args.gateUrl}/v1/cli/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: args.code, verifier: args.verifier }),
    });
  } catch (err) {
    throw new PkceLoginError("exchange", `Network error: ${(err as Error).message}`);
  }

  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      msg = body.error || body.message || msg;
    } catch {}
    throw new PkceLoginError("exchange", msg);
  }

  const body = (await res.json()) as {
    token?: string;
    ownerWallet?: string;
    tokenId?: string;
    label?: string;
  };
  if (!body.token || !body.ownerWallet || !body.tokenId) {
    throw new PkceLoginError("exchange", "Malformed response from gate.");
  }
  return {
    token: body.token,
    ownerWallet: body.ownerWallet,
    tokenId: body.tokenId,
    label: body.label || "CLI",
  };
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function htmlPage(title: string, body: string, ok: boolean): string {
  const accent = ok ? "#10b981" : "#ef4444";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif; background:#0b0b0d; color:#e5e5e5; }
  .card { background:#141418; border:1px solid #26262c; border-radius:12px;
          padding:32px 36px; max-width:420px; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%;
         background:${accent}; margin-right:10px; vertical-align:middle; }
  h1 { margin:0 0 8px; font-size:18px; font-weight:600; }
  p  { margin:0; color:#a3a3aa; }
</style></head>
<body><div class="card"><h1><span class="dot"></span>${title}</h1><p>${body}</p></div></body></html>`;
}
