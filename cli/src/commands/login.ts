import { Command } from "commander";
import chalk from "chalk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import open from "open";
import {
  loadCredentials,
  saveCredentials,
  getCredentialsPath,
  getDefaultGateUrl,
  getDefaultWebUrl,
  type Credentials,
} from "../credentials.js";

interface LoginOptions {
  webUrl?: string;
  gateUrl?: string;
  port?: string;
  force?: boolean;
  noBrowser?: boolean;
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export const loginCommand = new Command("login")
  .description("Sign in to Chest. Opens a browser, returns a CLI token to this device.")
  .option("--web-url <url>", "Override chest.sh URL", getDefaultWebUrl())
  .option("--gate-url <url>", "Override gate.chest.sh URL", getDefaultGateUrl())
  .option("--port <port>", "Loopback port (default: random)")
  .option("-f, --force", "Skip the 'already logged in' prompt")
  .option("--no-browser", "Print the URL instead of opening a browser")
  .action(async (opts: LoginOptions) => {
    console.log(chalk.bold("\n  ⚡ Chest Login\n"));

    const existing = await loadCredentials();
    if (existing && existing.source === "file" && !opts.force) {
      if (!stdin.isTTY) {
        console.error(
          chalk.red("  Already logged in. Pass --force to mint a new token, or set CHEST_TOKEN env var.\n")
        );
        process.exit(1);
      }
      console.log(
        chalk.gray(`  Already logged in as `) +
          chalk.cyan(existing.ownerWallet || existing.label) +
          chalk.gray(`.`)
      );
      console.log(
        chalk.gray("  Re-running mints a new token; the old one stays valid until revoked.")
      );
      const rl = createInterface({ input: stdin, output: stdout });
      const answer = await rl.question(chalk.gray("  Continue? (y/N) "));
      rl.close();
      if (answer.trim().toLowerCase() !== "y") {
        console.log(chalk.gray("\n  Cancelled.\n"));
        return;
      }
      console.log();
    }

    if (!stdin.isTTY && !process.env.CI_ALLOW_NON_TTY_LOGIN) {
      console.error(
        chalk.red("  Non-interactive shell detected. Set CHEST_TOKEN instead of running `login`.\n")
      );
      process.exit(1);
    }

    const webUrl = (opts.webUrl || getDefaultWebUrl()).replace(/\/$/, "");
    const gateUrl = (opts.gateUrl || getDefaultGateUrl()).replace(/\/$/, "");

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(24));
    const host = hostname() || "unknown";

    const portArg = opts.port ? parseInt(opts.port, 10) : 0;
    if (opts.port && (!Number.isFinite(portArg) || portArg < 0 || portArg > 65535)) {
      console.error(chalk.red(`  Invalid --port: ${opts.port}`));
      process.exit(1);
    }

    const result = await runLoopbackFlow({
      webUrl,
      state,
      challenge,
      hostname: host,
      desiredPort: portArg,
      openBrowser: opts.noBrowser !== true,
    });

    if (result.kind === "error") {
      console.error(chalk.red(`  ✗ ${result.message}\n`));
      process.exit(1);
    }

    process.stdout.write(chalk.gray("  Exchanging code… "));
    const exchanged = await exchangeCode({
      gateUrl,
      code: result.code,
      verifier,
    });

    if (!exchanged.ok) {
      console.log(chalk.red("failed"));
      console.error(chalk.red(`\n  ✗ ${exchanged.error}\n`));
      process.exit(1);
    }

    console.log(chalk.green("done"));

    const creds: Credentials = {
      version: 1,
      token: exchanged.token,
      ownerWallet: exchanged.ownerWallet,
      tokenId: exchanged.tokenId,
      label: exchanged.label,
      gateUrl,
      createdAt: new Date().toISOString(),
    };
    const path = await saveCredentials(creds);

    console.log();
    console.log(chalk.green("  ✓ Logged in as ") + chalk.cyan(exchanged.ownerWallet));
    console.log(chalk.gray(`    Token label: `) + chalk.white(exchanged.label));
    console.log(chalk.gray(`    Saved to:    `) + chalk.white(path));
    console.log();
    console.log(chalk.gray("  Manage tokens at ") + chalk.cyan(`${webUrl}/dashboard/agent-wallet`));
    console.log();
  });

interface LoopbackArgs {
  webUrl: string;
  state: string;
  challenge: string;
  hostname: string;
  desiredPort: number;
  openBrowser: boolean;
}

type LoopbackResult =
  | { kind: "ok"; code: string }
  | { kind: "error"; message: string };

function runLoopbackFlow(args: LoopbackArgs): Promise<LoopbackResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: LoopbackResult) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {}
      clearTimeout(timer);
      resolve(r);
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://127.0.0.1`);
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const recvState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(htmlPage("Login failed", error, false));
        finish({ kind: "error", message: `Browser returned error: ${error}` });
        return;
      }
      if (!recvState || recvState !== args.state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(htmlPage("Invalid state", "State mismatch. Try again.", false));
        finish({ kind: "error", message: "State mismatch on callback (possible CSRF)." });
        return;
      }
      if (!code) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(htmlPage("Missing code", "No authorization code on the callback.", false));
        finish({ kind: "error", message: "Callback missing code parameter." });
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(htmlPage("You're signed in", "You can close this tab and return to the terminal.", true));
      finish({ kind: "ok", code });
    });

    server.on("error", (err) => {
      finish({ kind: "error", message: `Loopback server failed: ${err.message}` });
    });

    server.listen(args.desiredPort, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        finish({ kind: "error", message: "Could not bind loopback server." });
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

      console.log(chalk.gray("  Opening browser to authorize this device…"));
      console.log(chalk.gray("  If it doesn't open, visit:"));
      console.log(chalk.cyan(`    ${loginUrl}`));
      console.log();
      console.log(chalk.gray(`  Listening on http://127.0.0.1:${port}/callback`));
      console.log();

      if (args.openBrowser) {
        open(loginUrl).catch(() => {
          // Non-fatal; the user can still copy the URL.
        });
      }
    });

    const timer = setTimeout(() => {
      finish({ kind: "error", message: "Timed out waiting for browser sign-in (5 min)." });
    }, LOGIN_TIMEOUT_MS);
  });
}

interface ExchangeArgs {
  gateUrl: string;
  code: string;
  verifier: string;
}

type ExchangeResult =
  | {
      ok: true;
      token: string;
      ownerWallet: string;
      tokenId: string;
      label: string;
    }
  | { ok: false; error: string };

async function exchangeCode(args: ExchangeArgs): Promise<ExchangeResult> {
  let res: Response;
  try {
    res = await fetch(`${args.gateUrl}/v1/cli/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: args.code, verifier: args.verifier }),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${(err as Error).message}` };
  }

  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      msg = body.error || body.message || msg;
    } catch {}
    return { ok: false, error: msg };
  }

  const body = (await res.json()) as {
    token?: string;
    ownerWallet?: string;
    tokenId?: string;
    label?: string;
  };
  if (!body.token || !body.ownerWallet || !body.tokenId) {
    return { ok: false, error: "Malformed response from gate." };
  }
  return {
    ok: true,
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
