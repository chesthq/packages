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

// Mirrors chest.sh's dark-mode design tokens (globals.css `.dark` block).
// Uses literal oklch() values so the browser computes them identically to
// the chest.sh authorize page the user just came from.
function htmlPage(title: string, body: string, ok: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:          oklch(0.07 0.005 270);
    --bg-elevated: oklch(0.11 0.005 270);
    --border:      oklch(0.22 0.008 260);
    --fg:          oklch(0.98 0.003 95);
    --fg-muted:    oklch(0.68 0.006 260);
    --success:     oklch(0.72 0.17 155);
    --danger:      oklch(0.6 0.22 25);
    --accent:      ${ok ? "var(--success)" : "var(--danger)"};
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; min-height: 100vh;
    background: var(--bg); color: var(--fg);
    font-family: "Geist", "Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
  }
  body { display: grid; place-items: center; padding: 24px; }
  .card {
    width: 100%; max-width: 460px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 24px 28px;
  }
  .row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .dot {
    width: 8px; height: 8px; border-radius: 9999px;
    background: var(--accent);
    flex: 0 0 auto;
  }
  h1 {
    margin: 0;
    font-size: 17px; font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--fg);
    line-height: 1.3;
  }
  p {
    margin: 0;
    color: var(--fg-muted);
    font-size: 14px; line-height: 1.55;
    letter-spacing: -0.005em;
  }
</style></head>
<body><div class="card"><div class="row"><span class="dot"></span><h1>${title}</h1></div><p>${body}</p></div></body></html>`;
}
