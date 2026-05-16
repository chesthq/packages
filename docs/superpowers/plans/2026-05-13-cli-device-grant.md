# CLI Device-Grant Login Implementation Plan (kyiv side)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the PKCE-loopback `runPkceLogin` in `@chest-gate/auth-flow` with an RFC 8628 device-grant `runDeviceGrant`. Update `@chest-gate/cli` `login` and `@chest-gate/install` to use it. `chest-gate login` becomes the same one-flow command on desktop, SSH, Docker, and CI — no `127.0.0.1` loopback, no `--port`, no `state`/`challenge` in the URL.

**Architecture:** The CLI hits two new endpoints on `gate.chest.sh` (`/v1/oauth/device/code` to mint a short user code; `/v1/oauth/token` to poll). The user opens `chest.sh/device?code=…` on any device with a browser, signs in via Privy, and confirms. The CLI polls until it gets a token, `access_denied`, or `expired_token`. The existing `runPkceLogin` is **removed** in this same release (semver-major bumps for `auth-flow` and `cli`); old binaries already in the wild keep working because the gate's old `/cli/login` + `/v1/cli/exchange` endpoints stay live.

**Tech Stack:** Node ≥20, `@chest-gate/auth-flow` (TypeScript lib, no test framework today), `@chest-gate/cli` (commander), `@chest-gate/install` (no deps). `open` library kept for "open browser automatically when possible."

**Pairs with:** `/Users/dm/conductor/workspaces/chest-gate/seattle-v1/docs/superpowers/plans/2026-05-13-cli-device-grant.md` (server + web side). **Land the gate side first** — this plan calls endpoints that don't exist until the gate PR is merged.

---

## Background — why this change

The current `@chest-gate/auth-flow` `runPkceLogin` binds `127.0.0.1:<port>` and waits for `chest.sh/cli/login` to redirect a browser back. Under SSH, the loopback is on the remote host but the browser is on the laptop, so the redirect fails. RFC 8628 (Device Authorization Grant) is the industry-standard fix used by `gh`, `gcloud --device-code`, `az`, `aws sso login`, `stripe`, npm, HashiCorp, etc. Trade: one extra copy/paste step (or one click on `verification_uri_complete`), in exchange for *one* flow that works everywhere.

We are deleting `runPkceLogin` rather than keeping both. The maintenance cost of two flows isn't justified once device-grant exists — `gh` proves it can be the only flow.

## File structure

**Modified:**
- `auth-flow/package.json` — version bump (`0.1.2` → `0.2.0`).
- `auth-flow/src/index.ts` — replace `runPkceLogin` + `runLoopbackFlow` with `runDeviceGrant` + `pollForToken`. Drop `htmlPage` (no loopback HTML response anymore). Keep `PkceLoginError` renamed to `DeviceGrantError` (or alias both for one release for old install binaries — see Task 9).
- `cli/package.json` — version bump (`1.1.1` → `2.0.0` since the `--port` flag is removed).
- `cli/src/commands/login.ts` — call `runDeviceGrant`; remove `--port`; reword UX.
- `install/src/index.ts` — `runBrowserLogin` calls `runDeviceGrant`.
- `cli/README.md` and `install/README.md` if they reference loopback/port.

**No new files** — the device-grant code replaces the loopback code in the same module. Tests live alongside as `.test.ts` files (Vitest config added in Task 1).

---

## API consumed (from the gate plan)

```
POST https://gate.chest.sh/v1/oauth/device/code
  request:  { client_id: "chest-cli", hostname: string }
  response: { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }

POST https://gate.chest.sh/v1/oauth/token
  request:  { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code, client_id: "chest-cli" }
  response (200): { token, ownerWallet, tokenId, label }
  response (400): { error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_grant" | "invalid_request" | "unsupported_grant_type", error_description? }
```

---

## Task breakdown

### Task 1: Vitest setup for `auth-flow`

The package has no tests today. Add Vitest so TDD steps work.

**Files:**
- Modify: `auth-flow/package.json`
- Create: `auth-flow/vitest.config.ts`

- [ ] **Step 1: Add Vitest to `auth-flow/package.json`**

Update the `devDependencies` and `scripts` blocks:

```json
{
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepublishOnly": "npm run build"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

(Keep existing devDependencies; just add `vitest`. Keep typescript at whatever version it's pinned at — don't bump unless it's missing.)

- [ ] **Step 2: Create the Vitest config**

Create `auth-flow/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: Install**

From the kyiv repo root:

```bash
npm install --workspaces --include-workspace-root
```

- [ ] **Step 4: Verify Vitest runs (no tests yet)**

```bash
npm test -w @chest-gate/auth-flow
```

Expected: "No test files found" — that's fine; the harness works.

- [ ] **Step 5: Commit**

```bash
git add auth-flow/package.json auth-flow/vitest.config.ts package-lock.json
git commit -m "chore(auth-flow): set up Vitest"
```

---

### Task 2: `runDeviceGrant` happy path — TDD

**Files:**
- Create: `auth-flow/src/index.test.ts`
- Modify: `auth-flow/src/index.ts`

We rewrite `auth-flow/src/index.ts` end-to-end in this task; later tasks add edge-case tests and error paths.

- [ ] **Step 1: Write the failing test**

Create `auth-flow/src/index.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runDeviceGrant, DeviceGrantError } from "./index.js";

describe("runDeviceGrant — happy path", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    global.fetch = realFetch;
  });

  it("requests a code, polls until authorized, returns the token", async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: any, init: any) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const path = new URL(url).pathname;
      if (path === "/v1/oauth/device/code") {
        return new Response(
          JSON.stringify({
            device_code: "x".repeat(43),
            user_code: "WXYZ-PQRS",
            verification_uri: "https://chest.sh/device",
            verification_uri_complete: "https://chest.sh/device?code=WXYZ-PQRS",
            expires_in: 900,
            interval: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/oauth/token") {
        // Two pending polls, then success.
        const callIdx = calls.filter((c) => c.endsWith("/v1/oauth/token")).length;
        if (callIdx < 2) {
          return new Response(JSON.stringify({ error: "authorization_pending" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            token: "ca_live_test",
            ownerWallet: "wallet-1",
            tokenId: "tok-1",
            label: "CLI: host-1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    const onCodeIssued = vi.fn();
    const promise = runDeviceGrant({
      gateUrl: "https://gate.chest.sh",
      hostname: "host-1",
      openBrowser: false,
      onCodeIssued,
    });

    // Drive the polling interval forward.
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.token).toBe("ca_live_test");
    expect(result.ownerWallet).toBe("wallet-1");
    expect(onCodeIssued).toHaveBeenCalledOnce();
    expect(onCodeIssued.mock.calls[0][0].userCode).toBe("WXYZ-PQRS");
    expect(onCodeIssued.mock.calls[0][0].verificationUri).toBe("https://chest.sh/device");
    // device/code + ≥3 token polls.
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -w @chest-gate/auth-flow
```

Expected: failure — `runDeviceGrant` / `DeviceGrantError` not exported.

- [ ] **Step 3: Replace `auth-flow/src/index.ts`**

Overwrite `auth-flow/src/index.ts` entirely:

```typescript
/**
 * @chest-gate/auth-flow — OAuth 2.0 Device Authorization Grant (RFC 8628)
 * login flow for Chest Gate clients.
 *
 * The CLI requests a short user code from gate.chest.sh, prints it for the
 * user, optionally opens the verification URL in a browser, and polls until
 * the user signs in at chest.sh/device. Returns the freshly-minted agent
 * token. Works under SSH, Docker, CI, and headless boxes — no loopback.
 *
 * The token returned is an ordinary `ca_live_…` agent token bound to the
 * Privy-authenticated user's wallet — same kind paste-flow users mint at
 * chest.sh/dashboard/agent-wallet. Per-device, revocable, no scope
 * differences.
 */

import open from "open";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceGrantArgs {
  /// gate.chest.sh API base URL.
  gateUrl: string;
  /// Hostname recorded in the token label.
  hostname: string;
  /// Open the browser automatically. Default: true.
  openBrowser?: boolean;
  /// Called once when the device code has been issued — caller prints UI.
  onCodeIssued?: (info: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresInSec: number;
  }) => void;
  /// Optional override for the overall login timeout. Defaults to 15 min
  /// (matches the server-issued `expires_in`).
  timeoutMs?: number;
}

export interface DeviceGrantResult {
  token: string;
  ownerWallet: string;
  tokenId: string;
  label: string;
}

export type DeviceGrantErrorKind =
  | "network"
  | "request"
  | "denied"
  | "expired"
  | "timeout"
  | "unknown";

export class DeviceGrantError extends Error {
  constructor(
    public readonly kind: DeviceGrantErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DeviceGrantError";
  }
}

/**
 * Run the full RFC 8628 device-grant flow and return the minted token.
 *
 * @throws DeviceGrantError on any failure (network, denied, expired,
 *   timeout, unknown server error).
 */
export async function runDeviceGrant(
  args: DeviceGrantArgs,
): Promise<DeviceGrantResult> {
  const gateUrl = args.gateUrl.replace(/\/$/, "");
  const overallTimeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const codeRes = await requestDeviceCode(gateUrl, args.hostname);

  args.onCodeIssued?.({
    userCode: codeRes.user_code,
    verificationUri: codeRes.verification_uri,
    verificationUriComplete: codeRes.verification_uri_complete,
    expiresInSec: codeRes.expires_in,
  });

  if (args.openBrowser !== false) {
    open(codeRes.verification_uri_complete).catch(() => {
      // Non-fatal — the caller printed the URL via onCodeIssued.
    });
  }

  return pollForToken({
    gateUrl,
    deviceCode: codeRes.device_code,
    intervalSec: codeRes.interval,
    expiresInSec: codeRes.expires_in,
    overallTimeoutMs,
  });
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

async function requestDeviceCode(
  gateUrl: string,
  hostname: string,
): Promise<DeviceCodeResponse> {
  let res: Response;
  try {
    res = await fetch(`${gateUrl}/v1/oauth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "chest-cli", hostname }),
    });
  } catch (err) {
    throw new DeviceGrantError(
      "network",
      `Network error contacting ${gateUrl}: ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    throw new DeviceGrantError(
      "request",
      `Device code request failed (${res.status}): ${detail}`,
    );
  }

  return (await res.json()) as DeviceCodeResponse;
}

interface PollArgs {
  gateUrl: string;
  deviceCode: string;
  intervalSec: number;
  expiresInSec: number;
  overallTimeoutMs: number;
}

async function pollForToken(args: PollArgs): Promise<DeviceGrantResult> {
  const deadline = Date.now() + Math.min(
    args.expiresInSec * 1000,
    args.overallTimeoutMs,
  );
  let intervalMs = args.intervalSec * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    let res: Response;
    try {
      res = await fetch(`${args.gateUrl}/v1/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: DEVICE_CODE_GRANT,
          device_code: args.deviceCode,
          client_id: "chest-cli",
        }),
      });
    } catch (err) {
      // Transient network error — keep polling until the deadline.
      continue;
    }

    if (res.ok) {
      return (await res.json()) as DeviceGrantResult;
    }

    let body: { error?: string; error_description?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // ignore — fall through to "unknown"
    }

    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += 5_000;
        continue;
      case "access_denied":
        throw new DeviceGrantError(
          "denied",
          "Authorization denied in the browser.",
        );
      case "expired_token":
        throw new DeviceGrantError(
          "expired",
          "Login code expired before authorization. Run `chest-gate login` again.",
        );
      case "invalid_grant":
      case "invalid_request":
      case "unsupported_grant_type":
        throw new DeviceGrantError(
          "request",
          body.error_description || body.error,
        );
      default:
        throw new DeviceGrantError(
          "unknown",
          body.error_description ||
            body.error ||
            `Unexpected ${res.status} from token endpoint`,
        );
    }
  }

  throw new DeviceGrantError(
    "timeout",
    "Timed out waiting for browser authorization.",
  );
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; error_description?: string };
    return body.error_description || body.error || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Run the happy-path test to verify it passes**

```bash
npm test -w @chest-gate/auth-flow
```

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add auth-flow/src/index.ts auth-flow/src/index.test.ts
git commit -m "feat(auth-flow)!: replace PKCE loopback with RFC 8628 device grant"
```

---

### Task 3: Error-path tests for `runDeviceGrant`

**Files:**
- Modify: `auth-flow/src/index.test.ts`

- [ ] **Step 1: Append the error tests**

Add to `auth-flow/src/index.test.ts`:

```typescript
describe("runDeviceGrant — errors", () => {
  const realFetch = global.fetch;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    global.fetch = realFetch;
  });

  function tokenResponder(body: object, status = 400): typeof fetch {
    return vi.fn(async (url: any) => {
      const path = new URL(url).pathname;
      if (path === "/v1/oauth/device/code") {
        return new Response(
          JSON.stringify({
            device_code: "x".repeat(43),
            user_code: "WXYZ-PQRS",
            verification_uri: "https://chest.sh/device",
            verification_uri_complete: "https://chest.sh/device?code=WXYZ-PQRS",
            expires_in: 900,
            interval: 1,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  }

  it("access_denied → DeviceGrantError kind=denied", async () => {
    global.fetch = tokenResponder({ error: "access_denied" });
    const p = runDeviceGrant({
      gateUrl: "https://gate.chest.sh",
      hostname: "h",
      openBrowser: false,
    });
    const drained = (async () => {
      try {
        await vi.runAllTimersAsync();
        await p;
        return null;
      } catch (e) {
        return e;
      }
    })();
    const err = (await drained) as DeviceGrantError;
    expect(err).toBeInstanceOf(DeviceGrantError);
    expect(err.kind).toBe("denied");
  });

  it("expired_token → DeviceGrantError kind=expired", async () => {
    global.fetch = tokenResponder({ error: "expired_token" });
    const p = runDeviceGrant({
      gateUrl: "https://gate.chest.sh",
      hostname: "h",
      openBrowser: false,
    });
    const err = await captureRejection(p);
    expect(err.kind).toBe("expired");
  });

  it("slow_down increases interval; eventually completes", async () => {
    let polls = 0;
    global.fetch = vi.fn(async (url: any) => {
      const path = new URL(url).pathname;
      if (path === "/v1/oauth/device/code") {
        return new Response(
          JSON.stringify({
            device_code: "x".repeat(43),
            user_code: "WXYZ-PQRS",
            verification_uri: "https://chest.sh/device",
            verification_uri_complete: "https://chest.sh/device?code=WXYZ-PQRS",
            expires_in: 900,
            interval: 1,
          }),
          { status: 200 },
        );
      }
      polls += 1;
      if (polls < 2) {
        return new Response(JSON.stringify({ error: "slow_down" }), {
          status: 400,
        });
      }
      return new Response(
        JSON.stringify({
          token: "ca_live_ok",
          ownerWallet: "w",
          tokenId: "t",
          label: "CLI: h",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const p = runDeviceGrant({
      gateUrl: "https://gate.chest.sh",
      hostname: "h",
      openBrowser: false,
    });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.token).toBe("ca_live_ok");
  });

  it("device/code 503 throws kind=request", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "service_unavailable" }), {
        status: 503,
      }),
    ) as typeof fetch;
    const err = await captureRejection(
      runDeviceGrant({
        gateUrl: "https://gate.chest.sh",
        hostname: "h",
        openBrowser: false,
      }),
    );
    expect(err.kind).toBe("request");
  });
});

async function captureRejection(p: Promise<unknown>): Promise<DeviceGrantError> {
  try {
    await vi.runAllTimersAsync();
    await p;
    throw new Error("expected rejection");
  } catch (e) {
    return e as DeviceGrantError;
  }
}
```

- [ ] **Step 2: Run tests to verify pass**

```bash
npm test -w @chest-gate/auth-flow
```

Expected: 1 + 4 = 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add auth-flow/src/index.test.ts
git commit -m "test(auth-flow): cover device-grant error paths"
```

---

### Task 4: Rewrite `cli/src/commands/login.ts`

**Files:**
- Modify: `cli/src/commands/login.ts`

- [ ] **Step 1: Replace the file**

Overwrite `cli/src/commands/login.ts`:

```typescript
import { Command } from "commander";
import chalk from "chalk";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runDeviceGrant, DeviceGrantError } from "@chest-gate/auth-flow";
import {
  loadCredentials,
  saveCredentials,
  getDefaultGateUrl,
  getDefaultWebUrl,
  type Credentials,
} from "../credentials.js";

interface LoginOptions {
  webUrl?: string;
  gateUrl?: string;
  force?: boolean;
  noBrowser?: boolean;
}

export const loginCommand = new Command("login")
  .description("Sign in to Chest. Prints a code, opens chest.sh/device, returns a CLI token to this device.")
  .option("--web-url <url>", "Override chest.sh URL", getDefaultWebUrl())
  .option("--gate-url <url>", "Override gate.chest.sh URL", getDefaultGateUrl())
  .option("-f, --force", "Skip the 'already logged in' prompt")
  .option("--no-browser", "Print the URL instead of opening a browser")
  .action(async (opts: LoginOptions) => {
    console.log(chalk.bold("\n  ⚡ Chest Login\n"));

    const existing = await loadCredentials();
    if (existing && existing.source === "file" && !opts.force) {
      if (!stdin.isTTY) {
        console.error(
          chalk.red(
            "  Already logged in. Pass --force to mint a new token, or set CHEST_AGENT_TOKEN env var.\n",
          ),
        );
        process.exit(1);
      }
      console.log(
        chalk.gray(`  Already logged in as `) +
          chalk.cyan(existing.ownerWallet || existing.label) +
          chalk.gray(`.`),
      );
      console.log(
        chalk.gray("  Re-running mints a new token; the old one stays valid until revoked."),
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
        chalk.red("  Non-interactive shell detected. Set CHEST_AGENT_TOKEN instead of running `login`.\n"),
      );
      process.exit(1);
    }

    const gateUrl = (opts.gateUrl || getDefaultGateUrl()).replace(/\/$/, "");

    try {
      const result = await runDeviceGrant({
        gateUrl,
        hostname: hostname() || "unknown",
        openBrowser: opts.noBrowser !== true,
        onCodeIssued: ({ userCode, verificationUri, verificationUriComplete }) => {
          console.log(chalk.gray("  Your one-time code:"));
          console.log("    " + chalk.bold.cyan(userCode));
          console.log();
          if (opts.noBrowser) {
            console.log(chalk.gray("  Visit ") + chalk.cyan(verificationUriComplete));
          } else {
            console.log(
              chalk.gray("  Opening ") +
                chalk.cyan(verificationUri) +
                chalk.gray(" — or visit from any device:"),
            );
            console.log("    " + chalk.cyan(verificationUriComplete));
          }
          console.log();
          process.stdout.write(chalk.gray("  Waiting for authorization… "));
        },
      });
      console.log(chalk.green("✓"));

      const creds: Credentials = {
        version: 1,
        token: result.token,
        ownerWallet: result.ownerWallet,
        tokenId: result.tokenId,
        label: result.label,
        gateUrl,
        createdAt: new Date().toISOString(),
      };
      const path = await saveCredentials(creds);

      console.log();
      console.log(chalk.green("  ✓ Logged in as ") + chalk.cyan(result.ownerWallet));
      console.log(chalk.gray(`    Token label: `) + chalk.white(result.label));
      console.log(chalk.gray(`    Saved to:    `) + chalk.white(path));
      console.log();
      const webUrl = (opts.webUrl || getDefaultWebUrl()).replace(/\/$/, "");
      console.log(chalk.gray("  Manage tokens at ") + chalk.cyan(`${webUrl}/dashboard/agent-wallet`));
      console.log();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof DeviceGrantError && err.kind === "denied") {
        console.log(chalk.red("✗"));
      } else if (err instanceof DeviceGrantError) {
        console.log(chalk.red("✗"));
      }
      console.error(chalk.red(`\n  ✗ ${message}\n`));
      process.exit(1);
    }
  });
```

- [ ] **Step 2: Build the cli package**

```bash
npm run build -w @chest-gate/cli
```

Expected: zero TypeScript errors.

- [ ] **Step 3: Smoke-test the help output**

```bash
node cli/dist/index.js login --help
```

Expected: prints the new description, shows `--web-url`, `--gate-url`, `--force`, `--no-browser`. **No `--port` flag.**

- [ ] **Step 4: Commit**

```bash
git add cli/src/commands/login.ts
git commit -m "feat(cli)!: drop --port; use device-grant for login"
```

---

### Task 5: Update `install/src/index.ts`

**Files:**
- Modify: `install/src/index.ts`

- [ ] **Step 1: Find the existing import and call**

Locate these in `install/src/index.ts`:

```typescript
import { runPkceLogin, PkceLoginError } from "@chest-gate/auth-flow";
```

```typescript
async function runBrowserLogin(): Promise<void> {
  const webUrl = process.env.CHEST_WEB ?? DEFAULT_WEB;
  const gateUrl = process.env.CHEST_API ?? DEFAULT_API;
  try {
    const result = await runPkceLogin({
      webUrl,
      gateUrl,
      hostname: hostname() || "unknown",
      onListen: ({ loginUrl }) => {
        console.log();
        console.log(`  Opening ${webUrl} in your browser to authorize this device…`);
        console.log(`  If it doesn't open, visit:`);
        console.log(`    ${loginUrl}`);
      },
    });
    ...
```

- [ ] **Step 2: Replace import + function**

Replace the import:

```typescript
import { runDeviceGrant, DeviceGrantError } from "@chest-gate/auth-flow";
```

Replace `runBrowserLogin`:

```typescript
async function runBrowserLogin(): Promise<void> {
  const gateUrl = process.env.CHEST_API ?? DEFAULT_API;
  try {
    const result = await runDeviceGrant({
      gateUrl,
      hostname: hostname() || "unknown",
      onCodeIssued: ({ userCode, verificationUri, verificationUriComplete }) => {
        console.log();
        console.log(`  Your one-time code:  ${userCode}`);
        console.log(`  Opening ${verificationUri} — or visit from any device:`);
        console.log(`    ${verificationUriComplete}`);
        process.stdout.write(`  Waiting for authorization… `);
      },
    });
    console.log(`ok`);

    writeTokenFile({
      version: 1,
      token: result.token,
      ownerWallet: result.ownerWallet,
      tokenId: result.tokenId,
      label: result.label,
      gateUrl,
      createdAt: new Date().toISOString(),
    });
    console.log();
    console.log(`  ✓ Logged in as ${result.ownerWallet}`);
    console.log(`    Token label: ${result.label}`);
    console.log(`    Saved to:    ${TOKEN_FILE}`);
  } catch (err) {
    const message =
      err instanceof DeviceGrantError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    console.log(`  auth:    browser sign-in failed (${message}).`);
    console.log(`           Falling back to paste — you can also run \`chest-gate login\` later.`);
    await runPasteFlow();
  }
}
```

- [ ] **Step 3: Build install package**

```bash
npm run build -w @chest-gate/install
```

Expected: zero TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add install/src/index.ts
git commit -m "feat(install): use device-grant for browser login"
```

---

### Task 6: End-to-end manual test against the gate

Prereq: the gate-side PR is merged to `main` and deployed to `gate.chest.sh` (or you have a local gate running on `localhost:4030` with the device-grant routes mounted).

- [ ] **Step 1: Build everything fresh**

```bash
npm run build
```

- [ ] **Step 2: Run `chest-gate login` against staging/local**

If testing against a local gate:
```bash
node cli/dist/index.js login --gate-url http://localhost:4030 --web-url http://localhost:3030
```

If staging:
```bash
node cli/dist/index.js login
```

Expected output structure:
```
  ⚡ Chest Login

  Your one-time code:
    WXYZ-PQRS

  Opening https://chest.sh/device — or visit from any device:
    https://chest.sh/device?code=WXYZ-PQRS

  Waiting for authorization…
```

- [ ] **Step 3: Authorize via the browser**

The browser should open `chest.sh/device?code=WXYZ-PQRS` (or `localhost:3030/device?...`). Sign in via Privy, click "Authorize this device."

- [ ] **Step 4: Verify the CLI finished**

Within a few seconds of authorizing, the CLI should print:
```
  Waiting for authorization… ✓

  ✓ Logged in as <wallet>
    Token label: CLI: <hostname>
    Saved to:    ~/.chest/agent-token.json
```

- [ ] **Step 5: Verify the saved token works**

```bash
node cli/dist/index.js whoami
```

Expected: shows ownerWallet, tokenId, label.

- [ ] **Step 6: Test the SSH case (the whole reason for this work)**

From your laptop:
```bash
ssh you@some-remote 'npx --yes @chest-gate/cli@<dev-tarball> login --gate-url …'
```

Or, easier: scp the built `cli/dist` over and run it remotely. Confirm:
- The CLI prints a code on the remote terminal.
- You can authorize from your *laptop's* browser (the verification URL works from anywhere).
- The remote CLI completes the login without any 127.0.0.1 dependency.

- [ ] **Step 7: Test the deny path**

`chest-gate login` again, then on the `/device` page click "Not me — deny." Expected CLI output:
```
  ✗ Authorization denied in the browser.
```
exit code 1.

- [ ] **Step 8: No commit** — verification only.

---

### Task 7: README updates

**Files:**
- Modify: `auth-flow/README.md`
- Modify: `cli/README.md`
- Modify: `install/README.md` (if it references loopback)

- [ ] **Step 1: Update `auth-flow/README.md`**

Replace the description with:

```markdown
# @chest-gate/auth-flow

OAuth 2.0 Device Authorization Grant (RFC 8628) login flow for Chest Gate
clients. Used by `@chest-gate/cli` and `@chest-gate/install`.

```typescript
import { runDeviceGrant } from "@chest-gate/auth-flow";

const result = await runDeviceGrant({
  gateUrl: "https://gate.chest.sh",
  hostname: "alice-laptop",
  onCodeIssued: ({ userCode, verificationUriComplete }) => {
    console.log(`Code: ${userCode}`);
    console.log(`Visit: ${verificationUriComplete}`);
  },
});
console.log(result.token); // ca_live_…
```

Replaces the previous PKCE loopback flow. The device grant works under SSH,
Docker, CI, and any environment without a usable 127.0.0.1.
```

- [ ] **Step 2: Update `cli/README.md`**

Find any mention of `--port` and remove it. Add a "headless / SSH" note:

```markdown
### Headless / SSH login

`chest-gate login` works the same on every machine — desktop, SSH, Docker,
CI. It prints a short code and opens (or asks you to open) `chest.sh/device`
in any browser. No loopback, no port forwarding needed.
```

- [ ] **Step 3: Commit**

```bash
git add auth-flow/README.md cli/README.md install/README.md
git commit -m "docs: device-grant login replaces PKCE loopback"
```

---

### Task 8: Version bumps + CHANGELOGs

**Files:**
- Modify: `auth-flow/package.json`, `cli/package.json`, `install/package.json`
- Modify: `auth-flow/CHANGELOG.md`, `cli/CHANGELOG.md`, `install/CHANGELOG.md` (if they exist)

- [ ] **Step 1: Check current versions**

```bash
grep -H '"version"' auth-flow/package.json cli/package.json install/package.json
```

Note the current numbers.

- [ ] **Step 2: Bump versions**

This is a breaking change in `@chest-gate/auth-flow` (exported names changed: `runPkceLogin` → `runDeviceGrant`, `PkceLoginError` → `DeviceGrantError`).

- `auth-flow`: `0.1.2` → `0.2.0` (still 0.x, breaking allowed in minor).
- `cli`: `1.1.1` → `2.0.0` (`--port` flag removed, breaking).
- `install`: bump minor (`0.x.0`) — same flow from the user's POV, just a new transitive dep.

Edit each `package.json` accordingly. Also update the `@chest-gate/auth-flow` dependency in `cli/package.json` and `install/package.json` to `^0.2.0`.

- [ ] **Step 3: Update CHANGELOGs if they exist**

For each that exists, prepend:

```markdown
## <new-version> — 2026-05-13

### Breaking
- Replaced PKCE loopback login (`runPkceLogin`) with RFC 8628 device grant
  (`runDeviceGrant`). Works under SSH and other headless environments.
- `chest-gate login` no longer accepts `--port`.

### Migration
- Replace `runPkceLogin(...)` with `runDeviceGrant({ gateUrl, hostname, onCodeIssued })`.
- `onListen` callback is now `onCodeIssued`; receives `{ userCode, verificationUri, verificationUriComplete }`.
- `PkceLoginError` → `DeviceGrantError`.
```

- [ ] **Step 4: Refresh package-lock**

```bash
npm install --workspaces --include-workspace-root
```

- [ ] **Step 5: Commit**

```bash
git add auth-flow/package.json cli/package.json install/package.json auth-flow/CHANGELOG.md cli/CHANGELOG.md install/CHANGELOG.md package-lock.json
git commit -m "chore(release): auth-flow 0.2.0, cli 2.0.0, install minor bump"
```

---

### Task 9: PR

- [ ] **Step 1: Push and open PR**

```bash
git push -u origin smd00/paste-callback-url
gh pr create --base main --title "feat!: device-grant login (RFC 8628), drops PKCE loopback" \
  --body "$(cat <<'EOF'
## Summary
- Replaces PKCE loopback login in `@chest-gate/auth-flow` with RFC 8628 device authorization grant.
- `chest-gate login` works identically on desktop, SSH, Docker, and CI — no 127.0.0.1 callback, no `--port` flag.
- Updates `@chest-gate/cli` and `@chest-gate/install` to call the new `runDeviceGrant`.

## Why
The loopback flow breaks when the CLI runs on a remote host (SSH): the browser on the user's laptop redirects to `127.0.0.1`, which is the laptop's loopback, not the remote's. Device grant is the industry standard fix (`gh`, `gcloud --device-code`, `az`, `stripe`, AWS SSO).

## Depends on
- gate-side PR adding `/v1/oauth/device/code`, `/v1/oauth/token`, and `/device` page (must be merged + deployed first).

## Breaking
- `@chest-gate/auth-flow` 0.2.0 — renamed exports.
- `@chest-gate/cli` 2.0.0 — `--port` flag removed.

## Test plan
- [ ] `npm test -w @chest-gate/auth-flow`
- [ ] `npm run build` succeeds across workspaces.
- [ ] Manual: local `chest-gate login --gate-url http://localhost:4030` completes successfully.
- [ ] Manual: SSH session uses device code from laptop browser.
- [ ] Manual: deny path returns `DeviceGrantError kind=denied`.
EOF
)"
```

- [ ] **Step 2: Done.**

---

## Self-review

**Spec coverage:**
- ✅ Vitest setup — Task 1.
- ✅ `runDeviceGrant` happy path + types — Task 2.
- ✅ Error paths (denied, expired, slow_down, request) — Task 3.
- ✅ `chest-gate login` rewrite — Task 4.
- ✅ `install` rewrite — Task 5.
- ✅ End-to-end manual verification — Task 6.
- ✅ READMEs — Task 7.
- ✅ Version + CHANGELOG — Task 8.
- ✅ PR — Task 9.

**Placeholder scan:**
- All code blocks complete.
- Task 8 Step 3 says "if they exist" for CHANGELOG files — that's a real conditional, not a placeholder. If you find no CHANGELOG.md files, skip them.

**Type consistency:**
- `runDeviceGrant` accepts `gateUrl`, `hostname`, `openBrowser`, `onCodeIssued`, `timeoutMs`. Same shape used in tests and in both `cli` and `install` callsites.
- `onCodeIssued` receives `{ userCode, verificationUri, verificationUriComplete, expiresInSec }` — same name in test and prod uses.
- `DeviceGrantError.kind` enum (`network | request | denied | expired | timeout | unknown`) used consistently.

**Coordination note:**
The gate plan introduces a `client_id: "chest-cli"` check on `/v1/oauth/device/code` and the `grant_type: "urn:ietf:params:oauth:grant-type:device_code"` literal on `/v1/oauth/token`. Both are emitted by this plan exactly. If you change one in the server plan, change the other here.
