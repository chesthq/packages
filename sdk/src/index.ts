/**
 * @chest-gate/sdk, pay x402 gates from any agent.
 *
 * Three credential modes, all behind the same `paidFetch(url, opts)` API:
 *
 * - **api-key** (recommended for deployed agents): pass a Chest API key via
 *   the `apiKey` option or `CHEST_API_KEY` env var. Signing happens
 *   server-side via a Privy-managed wallet bound to the key. No browser, no
 *   keypair on disk. Mint keys at https://chest.sh/app/keys.
 *
 * - **privy** (interactive sessions): a token JSON at
 *   `~/.chest/agent-token.json` (`{ version, token, gateUrl?, ... }` — the
 *   shape written by `chest-gate login` and `npx @chest-gate/install`).
 *   Signing happens server-side via the user's Privy-managed wallet.
 *
 * - **local** (self-custody fallback): a Solana secret-key JSON file at
 *   `~/.chest/agent-keypair.json`. Signing happens locally; chest.sh is not
 *   in the path. Required when chest.sh is unreachable or the caller wants
 *   to hold their own keys.
 *
 * Mode auto-detect (when `mode` is unset or `"auto"`):
 *   1. `apiKey` option provided                → api-key
 *   2. `CHEST_API_KEY` env set                 → api-key
 *   3. `~/.chest/agent-token.json` exists      → privy
 *   4. `~/.chest/agent-keypair.json` exists    → local
 *   5. throw with a helpful message
 *
 * `appSlug` (optional): declare which App is calling. Forwarded as
 * `x-chest-app` on the paid request — the gate attributes the referrer
 * cut to the app's registered author wallet. Authors register an app once
 * on chest.sh, no key needs to ship in skill source. Pass `referrerWallet`
 * to override.
 *
 * Auto-discovery: if `appSlug` is not provided, the SDK falls back to
 * `process.env.CHEST_APP_SLUG`, then to the nearest `app.md` walking up
 * from `cwd` (Node only). Set `CHEST_APP_SLUG_DISABLE=1` to opt out of
 * filesystem discovery.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAppSlug } from "./app-slug.js";

export type { RequestEvent, SettledEvent } from "./hooks.js";
export { resolveAppSlug } from "./app-slug.js";

const DEFAULT_CHEST_API = "https://gate.chest.sh";

/** Modes describe where the credential comes from. */
export type PaidFetchMode = "api-key" | "privy" | "local" | "auto";

export interface PaidFetchOptions {
  /** Forwarded to fetch() for the *initial* (unauthenticated) request. */
  init?: RequestInit;
  /** Override mode detection. Default: "auto". */
  mode?: PaidFetchMode;
  /**
   * Chest API key (e.g. `ca_live_…`). Takes precedence over file-based
   * credentials. Falls back to `process.env.CHEST_API_KEY` if not provided
   * and mode is api-key.
   */
  apiKey?: string;
  /**
   * Declares which App is calling, `@author/app-name`. Forwarded as
   * `x-chest-app` on the paid request so the gate attributes the referrer
   * cut to the app's registered author wallet. The target gate must be
   * one of the app's registered endpoints. Pass `referrerWallet` to
   * override (explicit beats implicit).
   */
  appSlug?: string;
  /** Override chest.sh API URL (used in api-key and privy modes). */
  chestApi?: string;
  /** Override token file path (privy mode). */
  authFile?: string;
  /** Override local-keypair path (local mode). */
  keypairFile?: string;
  /** Explicit referrer wallet. Forwarded as x-referrer-wallet on gate calls. */
  referrerWallet?: string;
}

export interface PaidFetchResult {
  /** The final 200 response body (parsed JSON if content-type matches; else text). */
  body: unknown;
  /** Decoded x-payment-response receipt (txSignature, amount, payer). */
  receipt: {
    txSignature?: string;
    amount?: string | number;
    payer?: string;
    [k: string]: unknown;
  } | null;
  /** Address of the wallet that paid. */
  payer: string | null;
  /** Mode used to settle the call. */
  mode: "api-key" | "privy" | "local";
}

interface AuthFile {
  version?: number;
  gateUrl?: string;
  token: string;
}

/**
 * Pay an x402 gate. On 402 it builds the payment payload, retries with the
 * `x-payment` header, and returns the final body + receipt.
 *
 * Throws if the gate doesn't return 402 (i.e. nothing to pay), callers that
 * want to handle freebie / 200-on-first-try should catch and inspect.
 */
export async function paidFetch(
  url: string,
  opts: PaidFetchOptions = {},
): Promise<PaidFetchResult> {
  const mode = resolveMode(opts);
  const appSlug = resolveAppSlug(opts.appSlug);
  const effectiveOpts: PaidFetchOptions = appSlug === opts.appSlug ? opts : { ...opts, appSlug };

  const initHeaders = new Headers(opts.init?.headers ?? {});
  if (opts.referrerWallet) {
    initHeaders.set("x-referrer-wallet", opts.referrerWallet);
  }
  const initOpts: RequestInit = { ...opts.init, headers: initHeaders };

  const challengeRes = await fetch(url, initOpts);
  if (challengeRes.status !== 402) {
    throw new Error(
      `Expected 402, got ${challengeRes.status}: ${(await safeText(challengeRes)).slice(0, 200)}`,
    );
  }
  const paymentRequired = await challengeRes.json();

  const sign =
    mode === "api-key"
      ? signWithApiKey(paymentRequired, url, effectiveOpts)
      : mode === "privy"
        ? signWithChestApi(paymentRequired, url, effectiveOpts)
        : signWithLocalKeypair(paymentRequired, effectiveOpts);

  const { xPayment, payer } = await sign;

  const paidHeaders = new Headers(opts.init?.headers ?? {});
  paidHeaders.set("x-payment", xPayment);
  if (opts.referrerWallet) paidHeaders.set("x-referrer-wallet", opts.referrerWallet);
  // Skill-author attribution: the gate resolves `appSlug → authorWallet`
  // from its own apps registry, so no key needs to ship in source. Skipped
  // when the caller passed an explicit referrerWallet (explicit beats
  // implicit, same precedence as the agent-fetch path).
  if (appSlug && !opts.referrerWallet) {
    paidHeaders.set("x-chest-app", appSlug);
  }

  const paidRes = await fetch(url, { ...opts.init, headers: paidHeaders });
  if (!paidRes.ok) {
    throw new Error(
      `Paid request failed (${paidRes.status}): ${(await safeText(paidRes)).slice(0, 300)}`,
    );
  }

  const ct = paidRes.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await paidRes.json() : await paidRes.text();

  const receiptHeader = paidRes.headers.get("x-payment-response");
  const receipt = receiptHeader
    ? (() => {
        try {
          return JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf-8"));
        } catch {
          return null;
        }
      })()
    : null;

  return { body, receipt, payer, mode };
}

// ── Mode resolution ───────────────────────────────────────────────────────

function resolveMode(opts: PaidFetchOptions): "api-key" | "privy" | "local" {
  const override = opts.mode ?? (process.env.CHEST_AGENT_MODE as PaidFetchMode | undefined);
  if (override === "api-key" || override === "privy" || override === "local") return override;

  // Auto-detect: api-key wins if a token is reachable, then file-based modes.
  if (opts.apiKey || process.env.CHEST_API_KEY) return "api-key";
  if (tokenFileExists(opts.authFile)) return "privy";
  if (keypairFileExists(opts.keypairFile)) return "local";

  throw new Error(
    "No agent credentials found. Either:\n" +
      "  - run `chest-gate login` (PKCE browser flow, writes ~/.chest/agent-token.json)\n" +
      "  - pass `apiKey` (or set CHEST_API_KEY), mint at https://chest.sh/app/agent-wallet\n" +
      `  - place a Solana keypair JSON at ${join(homedir(), ".chest", "agent-keypair.json")}`,
  );
}

const CHEST_DIR = join(homedir(), ".chest");
const TOKEN_FILE = join(CHEST_DIR, "agent-token.json");
const KEYPAIR_FILE = join(CHEST_DIR, "agent-keypair.json");

function resolveTokenFile(override?: string): string {
  return override ?? TOKEN_FILE;
}

function resolveKeypairFile(override?: string): string {
  return override ?? KEYPAIR_FILE;
}

function tokenFileExists(override?: string): boolean {
  return existsSync(override ?? TOKEN_FILE);
}

function keypairFileExists(override?: string): boolean {
  return existsSync(override ?? KEYPAIR_FILE);
}

// ── api-key mode: token from option / env, sign via chest.sh ──────────────

async function signWithApiKey(
  paymentRequired: unknown,
  gateUrl: string,
  opts: PaidFetchOptions,
): Promise<{ xPayment: string; payer: string | null }> {
  const token = opts.apiKey ?? process.env.CHEST_API_KEY;
  if (!token) {
    throw new Error(
      "api-key mode requires `apiKey` option or CHEST_API_KEY env var. " +
        "Mint a key at https://chest.sh/app/keys.",
    );
  }
  const apiUrl = opts.chestApi ?? process.env.CHEST_API ?? DEFAULT_CHEST_API;
  return signViaChestApi({ token, apiUrl, paymentRequired, gateUrl, appSlug: opts.appSlug });
}

// ── privy mode: token from ~/.chest/agent-token.json, sign via chest.sh ──

async function signWithChestApi(
  paymentRequired: unknown,
  gateUrl: string,
  opts: PaidFetchOptions,
): Promise<{ xPayment: string; payer: string | null }> {
  const path = resolveTokenFile(opts.authFile);
  const auth: AuthFile = JSON.parse(readFileSync(path, "utf-8"));
  const apiUrl = opts.chestApi ?? auth.gateUrl ?? process.env.CHEST_API ?? DEFAULT_CHEST_API;
  return signViaChestApi({
    token: auth.token,
    apiUrl,
    paymentRequired,
    gateUrl,
    appSlug: opts.appSlug,
  });
}

interface SignViaChestApiArgs {
  token: string;
  apiUrl: string;
  paymentRequired: unknown;
  gateUrl: string;
  appSlug?: string;
}

async function signViaChestApi(
  args: SignViaChestApiArgs,
): Promise<{ xPayment: string; payer: string | null }> {
  const res = await fetch(`${args.apiUrl}/api/agent/sign`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify({
      paymentRequired: args.paymentRequired,
      gateUrl: args.gateUrl,
      ...(args.appSlug ? { appSlug: args.appSlug } : {}),
    }),
  });

  if (!res.ok) {
    const txt = await safeText(res);
    throw new Error(`chest.sh /api/agent/sign ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = (await res.json()) as { xPayment: string; walletAddress: string };
  return { xPayment: data.xPayment, payer: data.walletAddress ?? null };
}

// ── Local mode: sign with a keypair on disk ──────────────────────────────

async function signWithLocalKeypair(
  paymentRequired: unknown,
  opts: PaidFetchOptions,
): Promise<{ xPayment: string; payer: string | null }> {
  const { Keypair } = await import("@solana/web3.js");
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  const { x402Client } = await import("@x402/core/client");
  const { registerExactSvmScheme } = await import("@x402/svm/exact/client");

  const path = resolveKeypairFile(opts.keypairFile);
  const raw = JSON.parse(readFileSync(path, "utf-8")) as number[];
  const keypair = Keypair.fromSecretKey(new Uint8Array(raw));
  const signer = await createKeyPairSignerFromBytes(keypair.secretKey);

  const client = new x402Client();
  registerExactSvmScheme(client, { signer });

  const payload = await client.createPaymentPayload(paymentRequired as Parameters<typeof client.createPaymentPayload>[0]);
  const xPayment = Buffer.from(JSON.stringify(payload)).toString("base64");
  return { xPayment, payer: keypair.publicKey.toBase58() };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
