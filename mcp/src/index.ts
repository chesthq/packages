#!/usr/bin/env node
/**
 * Chest MCP Server
 *
 * Exposes x402-gated APIs as MCP tools. Three call modes, in precedence
 * order — first-set wins:
 *   1. CHEST_AGENT_TOKEN (ca_live_…) — hosted-wallet via /api/agent/fetch.
 *      Server holds the Privy wallet, MCP never touches a keypair.
 *   2. CHEST_API_KEY (Bearer cg_live_…) — referrer attribution; client
 *      pays via AGENT_WALLET_PRIVATE_KEY.
 *   3. REFERRER_WALLET + ed25519 signing — self-custodial; client pays via
 *      AGENT_WALLET_PRIVATE_KEY and signs each referral claim.
 *
 * Tool surface:
 *   - discover_apis      → list every known gate (pricing, endpoints, category)
 *   - get_api_info       → details for one gate (incl. on-chain split metadata)
 *   - call_api           → make any GET/POST against any registered gate
 *   - list_apps          → list installable apps (skill | plugin | mcp) wrapping gates
 *   - get_app            → full app detail incl. install snippets
 *
 * Usage (stdio):
 *   CHEST_API_KEY=cg_live_… AGENT_WALLET_PRIVATE_KEY='[1,2,3,…]' npx @chest-gate/mcp
 *
 * Claude Desktop config (~/.config/claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "chest": {
 *         "command": "npx",
 *         "args": ["-y", "@chest-gate/mcp"],
 *         "env": {
 *           "CHEST_API_KEY": "cg_live_...",
 *           "AGENT_WALLET_PRIVATE_KEY": "[1,2,3,...]"
 *         }
 *       }
 *     }
 *   }
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { signReferral } from "./referrer.js";

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Hosted-wallet agent token (ca_live_…) minted on the dashboard. When set,
 * call_api dispatches paid calls through POST /api/agent/fetch — the server
 * holds a Privy-managed wallet and performs the entire x402 dance, so the
 * MCP needs no Solana keypair. AGENT_WALLET_PRIVATE_KEY, REFERRER_WALLET,
 * REFERRER_PAYOUT_WALLET, and CHEST_API_KEY are all ignored when set.
 */
const CHEST_AGENT_TOKEN = process.env.CHEST_AGENT_TOKEN || "";

/**
 * Bearer-format referrer key (cg_live_… / cg_test_…) minted at chest.sh/dashboard/keys.
 * When set, the server resolves payout from the API key and we skip ed25519 signing
 * entirely, REFERRER_WALLET / REFERRER_PAYOUT_WALLET / @noble/curves are unused.
 * x402 payment still requires AGENT_WALLET_PRIVATE_KEY.
 */
const CHEST_API_KEY = process.env.CHEST_API_KEY || "";

/**
 * Hot wallet that signs referral claims (proves ownership).
 * Ignored when CHEST_API_KEY is set.
 */
const REFERRER_WALLET = process.env.REFERRER_WALLET || "";

/**
 * Optional cold wallet to receive commission payouts.
 * The hot key (REFERRER_WALLET) signs; funds go here. Set this to separate
 * signing risk from funds. Ignored when CHEST_API_KEY is set.
 */
const REFERRER_PAYOUT_WALLET = process.env.REFERRER_PAYOUT_WALLET || "";

/** Secret key for paying x402 API calls, JSON array [1,2,3,...] or base64 string. */
const AGENT_PRIVATE_KEY_RAW = process.env.AGENT_WALLET_PRIVATE_KEY || "";

/** Base URL of the Chest gate. Per-API URLs default to {BASE}/g/{slug}. */
const CHEST_GATE_BASE_URL = process.env.CHEST_GATE_BASE_URL || "https://gate.chest.sh";

/**
 * Optional single-gate scope. When set, the MCP exposes only this slug:
 * discover_apis returns one entry, call_api defaults `api` to this slug
 * (and rejects any other). Matches the chest-gate dashboard's per-gate
 * install snippet.
 */
const CHEST_SLUG = process.env.CHEST_SLUG || "";

const gate = (slug: string) => `${CHEST_GATE_BASE_URL}/g/${slug}`;

// ─── Package metadata ────────────────────────────────────────────────────────

/** Read version from sibling package.json so the User-Agent and server name
 *  stay in sync without editing two files on every release. */
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
}
const PKG_VERSION = readPackageVersion();
const USER_AGENT = `chest-gate-mcp/${PKG_VERSION}`;
const FETCH_TIMEOUT_MS = 30_000;

// ─── HTTP helper ─────────────────────────────────────────────────────────────

/**
 * Wrapped fetch: 30s AbortController timeout + User-Agent stamp on every
 * outbound request. Use this for all chest-gate / gate calls so timeouts
 * and identification are uniform.
 */
async function chestFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
  try {
    return await fetch(url, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Thrown when an upstream gate or chest-gate API responds non-2xx. The
 *  raw status + body text travel with the error so handlers can surface
 *  them verbatim per the MCP tool spec. */
class UpstreamError extends Error {
  constructor(public status: number, public bodyText: string, label = "upstream") {
    super(`${label} ${status}: ${bodyText}`);
    this.name = "UpstreamError";
  }
}

// ─── Gate catalog ────────────────────────────────────────────────────────────
//
// Loaded dynamically from the public gates listing at startup and refreshed
// on a TTL. The package ships zero hardcoded slugs; on /api/gates failure we
// return an empty catalog (multi-gate mode) or a single CHEST_SLUG-derived
// stub (single-gate mode). Per-API gate URLs remain overrideable via
// {SLUG}_GATE_URL env vars.

type Category = "trading" | "ai" | "data" | "content" | "utility";

interface ApiInfo {
  /** Slug used as the API name (matches split config and call_api dispatch key) */
  name: string;
  category: Category;
  description: string;
  /** Default upstream URL, override per API via {SLUG}_GATE_URL env. */
  gateUrl: string;
  /** Endpoints exposed by this API. Path → human description. */
  endpoints: Record<string, string>;
  /** Per-call price in USD (display only, actual price comes from the 402 challenge). */
  price: string;
  /** Solana network the gate settles on, e.g. "solana-mainnet" or "solana-devnet". */
  network?: string | null;
  /** Curated/verified flag from the chest-gate registry. */
  verified?: boolean;
  /** Editorial blurb if the gate is curated. */
  editorial?: string | null;
  /** Referrer commission rate in basis points (10000 = 100%). */
  referrerBps?: number | null;
  /** Protocol fee in basis points. */
  protocolBps?: number | null;
  /** On-chain split-config PDA. */
  splitConfigPda?: string | null;
  /** When true, X-Referrer-Wallet alone (no signature) is accepted by this gate. */
  allowUnsignedReferrers?: boolean;
  /** Number of endpoints the gate publishes. */
  endpointCount?: number;
}

function isCategory(s: unknown): s is Category {
  return s === "trading" || s === "ai" || s === "data" || s === "content" || s === "utility";
}

/** Env override key for a slug, e.g. "sentiment-api" → "SENTIMENT_API_GATE_URL". */
function gateUrlEnvKey(slug: string): string {
  return `${slug.toUpperCase().replace(/-/g, "_")}_GATE_URL`;
}

function gateUrlFor(slug: string): string {
  return process.env[gateUrlEnvKey(slug)] ?? gate(slug);
}

/** Minimal ApiInfo for an unknown slug (single-gate mode + offline / not-yet-listed). */
function stubApiInfo(slug: string): ApiInfo {
  return {
    name: slug,
    category: "data",
    description: slug,
    gateUrl: gateUrlFor(slug),
    endpoints: {},
    price: "",
  };
}

interface GateDeployment {
  slug: string;
  name?: string | null;
  description?: string | null;
  category?: string | null;
  price?: string | number | null;
  routePrices?: Record<string, string> | null;
  network?: string | null;
  verified?: boolean;
  editorial?: string | null;
  referrerBps?: number | null;
  protocolBps?: number | null;
  splitConfigPda?: string | null;
  allowUnsignedReferrers?: boolean;
  endpointCount?: number;
}

interface BazaarEndpoint {
  path: string;
  description?: string;
  price?: string;
}

/**
 * Best-effort fetch of a gate's discovery doc to recover the per-endpoint
 * path table (which the gates summary doesn't include). Returns an empty
 * map on any failure, the API still works without it, agents just lose
 * endpoint hints in `discover_apis`.
 */
async function fetchGateEndpoints(gateUrl: string): Promise<Record<string, string>> {
  try {
    const r = await chestFetch(`${gateUrl}/.well-known/chest.json`);
    if (!r.ok) return {};
    const body = await r.json() as { apps?: { bazaar?: { endpoints?: BazaarEndpoint[] } } };
    const eps = body.apps?.bazaar?.endpoints ?? [];
    const out: Record<string, string> = {};
    for (const e of eps) {
      if (typeof e.path !== "string") continue;
      out[e.path] = e.description ?? "";
    }
    return out;
  } catch {
    return {};
  }
}

const GATES_TTL_MS = 10 * 60_000;
let cachedGates: ApiInfo[] | null = null;
let cachedAt = 0;
let inflight: Promise<ApiInfo[]> | null = null;

async function loadGates(): Promise<ApiInfo[]> {
  const now = Date.now();
  if (cachedGates && now - cachedAt < GATES_TTL_MS) return cachedGates;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const r = await chestFetch(`${CHEST_GATE_BASE_URL}/api/gates`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json() as { deployments?: GateDeployment[] };
      let deployments = body.deployments ?? [];

      // Single-gate mode: keep only the configured slug. Endpoint discovery
      // for the rest is wasted work.
      if (CHEST_SLUG) {
        deployments = deployments.filter((d) => d.slug === CHEST_SLUG);
      }

      const apis = await Promise.all(
        deployments.map(async (d): Promise<ApiInfo> => {
          const gateUrl = gateUrlFor(d.slug);
          const endpoints = await fetchGateEndpoints(gateUrl);
          return {
            name: d.slug,
            category: isCategory(d.category) ? d.category : "data",
            description: d.description ?? d.name ?? d.slug,
            gateUrl,
            endpoints,
            price: d.price != null ? `$${d.price}` : "",
            network: d.network ?? null,
            verified: d.verified ?? false,
            editorial: d.editorial ?? null,
            referrerBps: d.referrerBps ?? null,
            protocolBps: d.protocolBps ?? null,
            splitConfigPda: d.splitConfigPda ?? null,
            allowUnsignedReferrers: d.allowUnsignedReferrers ?? false,
            endpointCount: d.endpointCount ?? 0,
          };
        }),
      );

      // Single-gate mode + slug missing from live catalog → synthesize a
      // minimal entry so call_api still works (the gate URL is deterministic).
      if (CHEST_SLUG && apis.length === 0) {
        apis.push(stubApiInfo(CHEST_SLUG));
      }

      cachedGates = apis;
      cachedAt = Date.now();
      return apis;
    } catch (err) {
      console.error(
        `[chest-mcp] gates fetch failed: ${(err as Error).message}, ` +
        `${cachedGates ? "using stale cache" : (CHEST_SLUG ? "using single-gate stub" : "returning empty catalog")}`,
      );
      if (cachedGates) return cachedGates;
      // Single-gate fallback: synthesize the configured slug so call_api
      // still works against the deterministic gate URL. Multi-gate mode
      // returns an empty list — the package no longer ships any hardcoded
      // slugs.
      return CHEST_SLUG ? [stubApiInfo(CHEST_SLUG)] : [];
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

async function findApi(name: string): Promise<ApiInfo | undefined> {
  const apis = await loadGates();
  return apis.find((a) => a.name === name);
}

// ─── x402 Payment Client ─────────────────────────────────────────────────────

let paymentClient: any = null;
let agentSecretKey: Uint8Array | null = null;

function parseSecretKey(raw: string): Uint8Array {
  if (raw.startsWith("[")) return new Uint8Array(JSON.parse(raw));
  return new Uint8Array(Buffer.from(raw, "base64"));
}

async function getPaymentClient() {
  if (paymentClient) return paymentClient;
  if (!AGENT_PRIVATE_KEY_RAW) return null;

  agentSecretKey = parseSecretKey(AGENT_PRIVATE_KEY_RAW);

  // Lazy-load heavy Solana deps so the MCP server cold-starts fast.
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  const { registerExactSvmScheme } = await import("@x402/svm/exact/client");
  const { x402Client } = await import("@x402/core/client");

  const keypairSigner = await createKeyPairSignerFromBytes(agentSecretKey);
  const client = new x402Client();
  registerExactSvmScheme(client, { signer: keypairSigner });

  paymentClient = client;
  return client;
}

/**
 * Hosted-wallet path: dispatch the call through `POST /api/agent/fetch`.
 * The chest-gate server holds the Privy wallet bound to CHEST_AGENT_TOKEN
 * and runs the entire 402 dance, so we never sign locally. Returns the
 * server's JSON response unchanged (incl. `success`, `response`, `paid`,
 * `payment` metadata, `dryRun` if applicable).
 */
async function callViaAgentFetch(
  url: string,
  slug: string,
  opts: { method?: string; body?: unknown; idempotencyKey?: string; dryRun?: boolean } = {},
): Promise<any> {
  const payload: Record<string, unknown> = {
    url,
    method: opts.method ?? "GET",
    gateSlug: slug,
  };
  if (opts.body !== undefined) payload.body = opts.body;
  if (opts.idempotencyKey) payload.idempotencyKey = opts.idempotencyKey;
  if (opts.dryRun) payload.dryRun = true;

  const r = await chestFetch(`${CHEST_GATE_BASE_URL}/api/agent/fetch`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CHEST_AGENT_TOKEN}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  if (!r.ok) {
    throw new UpstreamError(r.status, text, "/api/agent/fetch");
  }
  return json;
}

/**
 * Make a request to an x402-gated endpoint. Three modes:
 *   1. CHEST_AGENT_TOKEN set → POST /api/agent/fetch (server holds wallet,
 *      handles 402+settle+attribution).
 *   2. CHEST_API_KEY (Bearer) set → direct gate call; client pays via
 *      AGENT_WALLET_PRIVATE_KEY, server resolves attribution from the key.
 *   3. Else → direct gate call; client pays AND signs ed25519 referral
 *      headers from REFERRER_WALLET (self-custodial fallback).
 *
 * Body is sent as JSON when method is POST.
 */
async function callGatedApi(
  baseUrl: string,
  path: string,
  slug: string,
  opts: { method?: string; body?: unknown; idempotencyKey?: string; dryRun?: boolean } = {}
): Promise<any> {
  const method = opts.method ?? "GET";
  const url = `${baseUrl}${path}`;

  // Mode 1: hosted-wallet via /api/agent/fetch.
  if (CHEST_AGENT_TOKEN) {
    return callViaAgentFetch(url, slug, opts);
  }

  const baseHeaders: Record<string, string> = { "Accept": "application/json" };
  if (method !== "GET" && opts.body !== undefined) {
    baseHeaders["Content-Type"] = "application/json";
  }
  // Bearer key carries referrer attribution on every request, including the
  // pre-402 probe (lets the server short-circuit attribution lookups for
  // cached/freebie responses).
  if (CHEST_API_KEY) {
    baseHeaders["Authorization"] = `Bearer ${CHEST_API_KEY}`;
  }

  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

  // First try, may be free, freebie, or session-cached.
  const firstResponse = await chestFetch(url, { method, headers: baseHeaders, body });

  if (firstResponse.status !== 402) {
    if (!firstResponse.ok) {
      const text = await firstResponse.text();
      throw new UpstreamError(firstResponse.status, text, "gate");
    }
    return firstResponse.json();
  }

  // 402, payment required.
  const client = await getPaymentClient();
  if (!client) {
    throw new Error(
      "Payment required. Set AGENT_WALLET_PRIVATE_KEY env var (JSON array of secret key bytes) to make paid API calls."
    );
  }

  const paymentRequired = await firstResponse.json() as any;
  const amountMicros = parseInt(
    paymentRequired?.accepts?.[0]?.amount ?? paymentRequired?.amount ?? "0",
    10
  );

  const { x402HTTPClient } = await import("@x402/core/client");
  const httpClient = new x402HTTPClient(client);
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired as any);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  // Attribution: CHEST_API_KEY wins. The Bearer header was set on baseHeaders
  // above, the server resolves payout from the api_keys row directly, so no
  // ed25519 signature is needed and REFERRER_WALLET / REFERRER_PAYOUT_WALLET
  // are ignored. Falls back to signed referrer headers when CHEST_API_KEY is
  // unset and a REFERRER_WALLET is configured.
  if (!CHEST_API_KEY && REFERRER_WALLET && agentSecretKey) {
    const referralHeaders = await signReferral(
      agentSecretKey,
      REFERRER_WALLET,
      slug,
      amountMicros,
      REFERRER_PAYOUT_WALLET || undefined
    );
    Object.assign(paymentHeaders, referralHeaders);
  }

  const paidResponse = await chestFetch(url, {
    method,
    headers: { ...baseHeaders, ...paymentHeaders },
    body,
  });

  if (!paidResponse.ok) {
    const text = await paidResponse.text();
    throw new UpstreamError(paidResponse.status, text, "gate (paid)");
  }
  return paidResponse.json();
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "chest", version: PKG_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const apis = await loadGates();
  const apiNames = apis.map((a) => a.name);
  const singleGate = !!CHEST_SLUG;

  // In single-gate mode, the `api` argument is optional and defaults to the
  // configured slug.
  const apiArg = singleGate
    ? {
        type: "string",
        const: CHEST_SLUG,
        description: `API name. Locked to '${CHEST_SLUG}' in single-gate mode (CHEST_SLUG env). Optional.`,
      }
    : {
        type: "string",
        enum: apiNames,
        description: `API name. One of: ${apiNames.join(", ")}`,
      };

  const tools: any[] = [
    {
      name: "discover_apis",
      description: singleGate
        ? `List the configured Chest gate ('${CHEST_SLUG}') with pricing, endpoints, and metadata. ` +
          "Use the returned `name` as the `api` argument to call_api (or omit it; this MCP is locked to one gate)."
        : "List every Chest-gated API with pricing, endpoints, category, and supported parameters. " +
          "Call this first to explore what's available, the catalog covers trading data, AI inference, " +
          "market data, content, and utility APIs. Use the returned `name` as the `api` argument to call_api.",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Optional filter: 'trading' | 'ai' | 'data' | 'content' | 'utility'",
          },
        },
      },
    },
    {
      name: "get_api_info",
      description:
        "Get detailed info about one API including its on-chain split metadata (network, referrerBps, protocolBps, " +
        "splitConfigPda, allowUnsignedReferrers, verified). Useful before paying, agents can decide whether the " +
        "commission rate is worth it.",
      inputSchema: {
        type: "object",
        properties: { api: apiArg },
        required: singleGate ? [] : ["api"],
      },
    },
    {
      name: "call_api",
      description:
        "Make a request to a Chest-gated API. Pays via x402 on Solana automatically. " +
        "Auth precedence: CHEST_AGENT_TOKEN (server-held wallet via /api/agent/fetch) > " +
        "CHEST_API_KEY (Bearer; client pays from AGENT_WALLET_PRIVATE_KEY) > " +
        "REFERRER_WALLET (ed25519-signed; client pays). " +
        "For GET endpoints, only `path` is needed. For POST endpoints, pass `body` as a JSON object. " +
        (singleGate
          ? `This MCP is locked to '${CHEST_SLUG}'; the \`api\` argument is optional.`
          : "Use discover_apis first to find available endpoints."),
      inputSchema: {
        type: "object",
        properties: {
          api: apiArg,
          path: {
            type: "string",
            description: "Endpoint path including any params (e.g. '/sentiment/SOL', '/funding/BTC', '/scrape/news')",
          },
          method: {
            type: "string",
            enum: ["GET", "POST"],
            description: "HTTP method. Defaults to GET.",
          },
          body: {
            type: "object",
            description: "JSON body (POST only). E.g. { text: '...' } for ai-inference endpoints.",
          },
          idempotencyKey: {
            type: "string",
            description: "Idempotency key for retry-safe charges (only honored in CHEST_AGENT_TOKEN mode; same key returns the cached settlement).",
          },
          dryRun: {
            type: "boolean",
            description: "If true, validate and price-quote without charging on-chain (only honored in CHEST_AGENT_TOKEN mode).",
          },
        },
        required: singleGate ? ["path"] : ["api", "path"],
      },
    },
  ];

  // Apps catalog — agent-installable artifacts (skill | plugin | mcp) that
  // wrap one or more gates. Available in both modes; even a single-gate
  // server might want to surface skills/MCPs/plugins built around its gate.
  tools.push(
    {
      name: "list_apps",
      description:
        "List installable Chest apps — skills, plugins, and MCP servers — that wrap one or more paid gates. " +
        "Each entry includes the app slug, kind, author, endpoints, referrer rate, install count, and version. " +
        "Use `kind` to narrow to a specific artifact type and `verified: true` for the curated subset. " +
        "Page with `limit` (1-200, default 50) and `offset`.",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["skill", "plugin", "mcp"],
            description: "Filter by artifact type.",
          },
          verified: {
            type: "boolean",
            description: "When true, return only the curated/verified subset.",
          },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Page size, default 50." },
          offset: { type: "integer", minimum: 0, description: "Page offset, default 0." },
        },
      },
    },
    {
      name: "get_app",
      description:
        "Fetch full detail for one installable app, including its description, README, and install snippets " +
        "(`claudeCode`, `codex`, `cursor`, `mcpConfig`, `prompt`). Use after list_apps to inspect or install.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "App slug, e.g. 'trading-decision'." },
        },
        required: ["slug"],
      },
    },
  );

  return { tools };
});

// ─── Tool input schemas ──────────────────────────────────────────────────────
//
// Validation runs at the case boundary in the dispatcher. The MCP SDK's
// listTools inputSchema is documentation for the model; zod parsing is the
// runtime guarantee.

const DiscoverApisSchema = z.object({
  category: z.enum(["trading", "ai", "data", "content", "utility"]).optional(),
});
const GetApiInfoSchema = z.object({
  api: z.string().min(1).optional(),
});
const CallApiSchema = z.object({
  api: z.string().min(1).optional(),
  path: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional(),
  body: z.unknown().optional(),
  idempotencyKey: z.string().min(1).optional(),
  dryRun: z.boolean().optional(),
});
const ListAppsSchema = z.object({
  kind: z.enum(["skill", "plugin", "mcp"]).optional(),
  verified: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});
const GetAppSchema = z.object({
  slug: z.string().min(1),
});

/** Returns a tool-shaped error envelope with the zod issues flattened. */
function zodErrorReply(name: string, err: z.ZodError) {
  const msg = err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
  return {
    content: [{ type: "text", text: `Invalid arguments to ${name}: ${msg}` }],
    isError: true,
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "discover_apis": {
        const parsed = DiscoverApisSchema.safeParse(a);
        if (!parsed.success) return zodErrorReply(name, parsed.error);
        const apis = await loadGates();
        const cat = parsed.data.category;
        const filtered = cat ? apis.filter((x) => x.category === cat) : apis;
        return {
          content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
        };
      }

      case "get_api_info": {
        const parsed = GetApiInfoSchema.safeParse(a);
        if (!parsed.success) return zodErrorReply(name, parsed.error);
        const slug = resolveSlug(parsed.data.api);
        if (slug instanceof Error) {
          return { content: [{ type: "text", text: slug.message }], isError: true };
        }
        const api = await findApi(slug);
        if (!api) {
          const apis = await loadGates();
          return {
            content: [
              { type: "text", text: `Unknown API '${slug}'. Available: ${apis.map((x) => x.name).join(", ")}` },
            ],
            isError: true,
          };
        }
        // Best-effort fetch of the gate's discovery endpoint. Fails gracefully
        // if the gate isn't running (local dev).
        let discovery: unknown = null;
        try {
          const r = await chestFetch(`${api.gateUrl}/.well-known/chest.json`);
          if (r.ok) discovery = await r.json();
        } catch {
          // Gate may not be running, return catalog info only.
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ ...api, discovery }, null, 2) }],
        };
      }

      case "call_api": {
        const parsed = CallApiSchema.safeParse(a);
        if (!parsed.success) return zodErrorReply(name, parsed.error);
        const slug = resolveSlug(parsed.data.api);
        if (slug instanceof Error) {
          return { content: [{ type: "text", text: slug.message }], isError: true };
        }
        const api = await findApi(slug);
        if (!api) {
          return {
            content: [{ type: "text", text: `Unknown API '${slug}'` }],
            isError: true,
          };
        }
        if (!parsed.data.path.startsWith("/")) {
          return {
            content: [{ type: "text", text: `Path must start with '/', got '${parsed.data.path}'` }],
            isError: true,
          };
        }
        const data = await callGatedApi(api.gateUrl, parsed.data.path, api.name, {
          method: parsed.data.method ?? "GET",
          body: parsed.data.body,
          idempotencyKey: parsed.data.idempotencyKey,
          dryRun: parsed.data.dryRun,
        });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "list_apps": {
        const parsed = ListAppsSchema.safeParse(a);
        if (!parsed.success) return zodErrorReply(name, parsed.error);
        const params = new URLSearchParams();
        if (parsed.data.kind) params.set("kind", parsed.data.kind);
        if (parsed.data.verified === true) params.set("verified", "true");
        if (parsed.data.limit !== undefined) params.set("limit", String(parsed.data.limit));
        if (parsed.data.offset !== undefined) params.set("offset", String(parsed.data.offset));
        const qs = params.toString();
        const url = `${CHEST_GATE_BASE_URL}/api/apps${qs ? `?${qs}` : ""}`;
        const r = await chestFetch(url, { headers: { Accept: "application/json" } });
        if (!r.ok) {
          const text = await r.text();
          // Surface upstream verbatim in a structured envelope rather than
          // reformatting into a sentence — clients can dispatch on status.
          return {
            content: [{ type: "text", text: JSON.stringify({ status: r.status, body: tryParseJson(text) }, null, 2) }],
            isError: true,
          };
        }
        const json = await r.json();
        return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
      }

      case "get_app": {
        const parsed = GetAppSchema.safeParse(a);
        if (!parsed.success) return zodErrorReply(name, parsed.error);
        const url = `${CHEST_GATE_BASE_URL}/api/apps/${encodeURIComponent(parsed.data.slug)}`;
        const r = await chestFetch(url, { headers: { Accept: "application/json" } });
        if (!r.ok) {
          const text = await r.text();
          return {
            content: [{ type: "text", text: JSON.stringify({ status: r.status, body: tryParseJson(text) }, null, 2) }],
            isError: true,
          };
        }
        const json = await r.json();
        return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    // UpstreamError carries the raw status + body so handlers can surface
    // the upstream response verbatim instead of reformatting it.
    if (err instanceof UpstreamError) {
      return {
        content: [{ type: "text", text: JSON.stringify({ status: err.status, body: tryParseJson(err.bodyText) }, null, 2) }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

/** Best-effort JSON parse with string fallback. Used to surface upstream
 *  bodies in their native shape when possible, raw text otherwise. */
function tryParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Resolve the slug for a tool call against `CHEST_SLUG` precedence:
 *   - single-gate mode: arg is optional; if provided, must match `CHEST_SLUG`
 *   - multi-gate mode: arg is required
 * Returns the resolved slug, or an `Error` describing why the input was invalid.
 */
function resolveSlug(arg: unknown): string | Error {
  if (CHEST_SLUG) {
    if (arg !== undefined && arg !== null && arg !== CHEST_SLUG) {
      return new Error(
        `This MCP is locked to '${CHEST_SLUG}' (CHEST_SLUG env). Got '${String(arg)}'. ` +
          `Either omit the \`api\` argument or unset CHEST_SLUG to use other gates.`,
      );
    }
    return CHEST_SLUG;
  }
  if (typeof arg !== "string" || arg.length === 0) {
    return new Error("Missing required `api` argument.");
  }
  return arg;
}

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr (stdout is reserved for MCP protocol).
if (CHEST_SLUG) {
  console.error(`[chest-mcp] Single-gate mode: locked to '${CHEST_SLUG}'`);
}
if (CHEST_AGENT_TOKEN) {
  const prefix = CHEST_AGENT_TOKEN.slice(0, 12);
  console.error(`[chest-mcp] Auth: hosted-wallet (CHEST_AGENT_TOKEN ${prefix}…) — paid calls dispatched via /api/agent/fetch`);
  if (CHEST_API_KEY || REFERRER_WALLET || AGENT_PRIVATE_KEY_RAW) {
    console.error("[chest-mcp] Note: CHEST_API_KEY / REFERRER_WALLET / AGENT_WALLET_PRIVATE_KEY are ignored when CHEST_AGENT_TOKEN is set");
  }
} else if (CHEST_API_KEY) {
  const prefix = CHEST_API_KEY.slice(0, 12);
  console.error(`[chest-mcp] Referrer: API key ${prefix}… (earning commission per paid call)`);
  if (REFERRER_WALLET) {
    console.error("[chest-mcp] Note: REFERRER_WALLET is ignored when CHEST_API_KEY is set");
  }
  if (!AGENT_PRIVATE_KEY_RAW) {
    console.error("[chest-mcp] Warning: AGENT_WALLET_PRIVATE_KEY not set, cannot pay for API calls beyond freebies");
  }
} else if (REFERRER_WALLET) {
  console.error(`[chest-mcp] Referrer: ${REFERRER_WALLET} (earning commission per paid call)`);
  if (!AGENT_PRIVATE_KEY_RAW) {
    console.error("[chest-mcp] Warning: AGENT_WALLET_PRIVATE_KEY not set, cannot pay for API calls beyond freebies");
  }
} else {
  console.error("[chest-mcp] Warning: no CHEST_AGENT_TOKEN, CHEST_API_KEY, or REFERRER_WALLET set, not earning commissions");
  if (!AGENT_PRIVATE_KEY_RAW) {
    console.error("[chest-mcp] Warning: AGENT_WALLET_PRIVATE_KEY not set, cannot pay for API calls beyond freebies");
  }
}

// Warm the gate catalog so the first ListTools call doesn't pay the fan-out
// latency. Failures are non-fatal: loadGates returns the fallback.
const initialGates = await loadGates();
const source = cachedGates === initialGates ? "live gates" : "fallback";
console.error(
  `[chest-mcp] Ready, ${initialGates.length} APIs registered (${source}: ${CHEST_GATE_BASE_URL})`,
);
