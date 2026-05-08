#!/usr/bin/env node
/**
 * Chest MCP Server
 *
 * Exposes x402-gated APIs as MCP tools. Any AI agent using this server earns
 * commission on every paid call. Two attribution modes:
 *   1. CHEST_API_KEY (Bearer cg_live_…) — recommended, payout wallet bound
 *      at key-mint time on the dashboard.
 *   2. REFERRER_WALLET + ed25519 signing — self-custodial, signed per call.
 *
 * Tool surface:
 *   - discover_apis      → list every known API (pricing, endpoints, category)
 *   - get_api_info       → details for one API (incl. on-chain split metadata)
 *   - call_api           → make any GET/POST against any registered API
 *   - analyze_token      → convenience: parallel call to the trading data APIs
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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { signReferral } from "./referrer.js";

// ─── Config ──────────────────────────────────────────────────────────────────

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
 * (and rejects any other), and analyze_token is hidden from tools/list.
 * Matches the chest-gate dashboard's per-gate install snippet.
 */
const CHEST_SLUG = process.env.CHEST_SLUG || "";

const gate = (slug: string) => `${CHEST_GATE_BASE_URL}/g/${slug}`;

// ─── Gate catalog ────────────────────────────────────────────────────────────
//
// Loaded dynamically from the public gates listing at startup and refreshed on
// a TTL. The package no longer ships a hardcoded list, so newly published
// gates appear without a release. A small fallback list (FALLBACK_APIS) keeps
// the server functional when /api/gates is unreachable (offline dev,
// outage). Per-API gate URLs remain overrideable via {SLUG}_GATE_URL env vars.

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
    const r = await fetch(`${gateUrl}/.well-known/chest.json`);
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

/**
 * Tiny offline fallback. Used only when /api/gates is unreachable AND we
 * have no cached catalog yet. Keep this short, the live gates listing is the
 * source of truth, this just unblocks first-call dev with no network.
 */
const FALLBACK_APIS: ApiInfo[] = [
  {
    name: "market-data",
    category: "data",
    description: "Spot prices and L2 orderbook snapshots for major tokens",
    gateUrl: gateUrlFor("market-data"),
    endpoints: {
      "GET /prices": "All token spot prices",
      "GET /price/:token": "Price for one token",
      "GET /orderbook/:token": "L2 bid/ask snapshot",
      "GET /tokens": "List supported tokens (free)",
    },
    price: "$0.001",
  },
];

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
      const r = await fetch(`${CHEST_GATE_BASE_URL}/api/gates`);
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
        `${cachedGates ? "using stale cache" : "using fallback"}`,
      );
      if (cachedGates) return cachedGates;
      // Single-gate fallback: synthesize the configured slug. Otherwise
      // return the tiny built-in FALLBACK_APIS list.
      return CHEST_SLUG ? [stubApiInfo(CHEST_SLUG)] : FALLBACK_APIS;
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
 * Make a request to an x402-gated endpoint. Handles:
 *   - first try (might be free / freebie / session-cached)
 *   - 402 response → build payment payload
 *   - referrer attribution via either CHEST_API_KEY (Bearer) or ed25519
 *     signed REFERRER_WALLET headers
 *   - retry with x-payment + referrer headers
 *
 * Body is sent as JSON when method is POST.
 */
async function callGatedApi(
  baseUrl: string,
  path: string,
  slug: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<any> {
  const method = opts.method ?? "GET";
  const url = `${baseUrl}${path}`;
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
  const firstResponse = await fetch(url, { method, headers: baseHeaders, body });

  if (firstResponse.status !== 402) {
    if (!firstResponse.ok) {
      const text = await firstResponse.text();
      throw new Error(`API error ${firstResponse.status}: ${text}`);
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

  const paidResponse = await fetch(url, {
    method,
    headers: { ...baseHeaders, ...paymentHeaders },
    body,
  });

  if (!paidResponse.ok) {
    const text = await paidResponse.text();
    throw new Error(`Paid API error ${paidResponse.status}: ${text}`);
  }
  return paidResponse.json();
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "chest", version: "0.5.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const apis = await loadGates();
  const apiNames = apis.map((a) => a.name);
  const singleGate = !!CHEST_SLUG;

  // In single-gate mode, the `api` argument is optional and defaults to the
  // configured slug. analyze_token fans out to specific slugs that aren't
  // in scope, so it's hidden.
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
        "Make a request to a Chest-gated API. Pays via x402 on Solana automatically (using your AGENT_WALLET_PRIVATE_KEY) " +
        "and attaches referrer attribution (CHEST_API_KEY Bearer if set, else ed25519-signed REFERRER_WALLET). " +
        "For GET endpoints, only `path` is needed. For POST endpoints (e.g. ai-inference), pass `body` as a JSON object. " +
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
        },
        required: singleGate ? ["path"] : ["api", "path"],
      },
    },
  ];

  if (!singleGate) {
    tools.push({
      name: "analyze_token",
      description:
        "Comprehensive token analysis, calls sentiment, technicals, and liquidations APIs in parallel and returns the combined picture. " +
        "Total cost: ~$0.011 (3 paid calls). Use this when you need a full market view in one shot. " +
        "For deeper analysis (funding, IV, unlocks), pass `deep: true`, adds ~$0.009 and 3 more APIs.",
      inputSchema: {
        type: "object",
        properties: {
          token: {
            type: "string",
            description: "Token symbol (e.g. SOL, BTC, ETH)",
          },
          deep: {
            type: "boolean",
            description: "If true, also fetch funding rate, implied volatility, and token unlocks (BTC/ETH have IV).",
          },
        },
        required: ["token"],
      },
    });
  }

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "discover_apis": {
        const apis = await loadGates();
        const cat = a.category as string | undefined;
        const filtered = cat ? apis.filter((x) => x.category === cat) : apis;
        return {
          content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
        };
      }

      case "get_api_info": {
        const slug = resolveSlug(a.api);
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
          const r = await fetch(`${api.gateUrl}/.well-known/chest.json`);
          if (r.ok) discovery = await r.json();
        } catch {
          // Gate may not be running, return catalog info only.
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ ...api, discovery }, null, 2) }],
        };
      }

      case "call_api": {
        const slug = resolveSlug(a.api);
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
        const path = a.path as string;
        if (!path?.startsWith("/")) {
          return {
            content: [{ type: "text", text: `Path must start with '/', got '${path}'` }],
            isError: true,
          };
        }
        const data = await callGatedApi(api.gateUrl, path, api.name, {
          method: (a.method as string) ?? "GET",
          body: a.body,
        });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "analyze_token": {
        if (CHEST_SLUG) {
          return {
            content: [{ type: "text", text: `analyze_token is unavailable in single-gate mode (CHEST_SLUG='${CHEST_SLUG}'). Use call_api instead.` }],
            isError: true,
          };
        }
        const token = (a.token as string).toUpperCase();
        const deep = !!a.deep;

        // Always fetch the core 3.
        const coreCalls: Array<{ slug: string; promise: Promise<any> }> = [
          { slug: "sentiment-api", promise: callForToken("sentiment-api", `/sentiment/${token}`) },
          { slug: "technicals-api", promise: callForToken("technicals-api", `/technicals/${token}`) },
          { slug: "liquidations-api", promise: callForToken("liquidations-api", `/liquidations/${token}`) },
        ];

        // Deep adds funding, IV (only for BTC/ETH), and any matching upcoming unlocks.
        if (deep) {
          coreCalls.push({ slug: "funding-rates", promise: callForToken("funding-rates", `/funding/${token}`) });
          if (token === "BTC" || token === "ETH") {
            coreCalls.push({ slug: "implied-volatility", promise: callForToken("implied-volatility", `/iv/${token}`) });
          }
          coreCalls.push({ slug: "token-unlocks", promise: callForToken("token-unlocks", `/unlocks/${token}`) });
        }

        const results = await Promise.allSettled(coreCalls.map((c) => c.promise));
        const out: Record<string, unknown> = {
          token,
          deep,
          referrer: REFERRER_WALLET || null,
          timestamp: new Date().toISOString(),
        };
        results.forEach((r, i) => {
          const key = coreCalls[i].slug.replace(/-api$/, "");
          out[key] = r.status === "fulfilled"
            ? r.value
            : { error: (r as PromiseRejectedResult).reason?.message };
        });

        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

/** Helper for analyze_token, looks up an API and calls one of its endpoints. */
async function callForToken(apiName: string, path: string): Promise<any> {
  const api = await findApi(apiName);
  if (!api) throw new Error(`API ${apiName} not in gate catalog`);
  return callGatedApi(api.gateUrl, path, api.name);
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
  console.error(`[chest-mcp] Single-gate mode: locked to '${CHEST_SLUG}' (analyze_token disabled)`);
}
if (CHEST_API_KEY) {
  const prefix = CHEST_API_KEY.slice(0, 12);
  console.error(`[chest-mcp] Referrer: API key ${prefix}… (earning commission per paid call)`);
  if (REFERRER_WALLET) {
    console.error("[chest-mcp] Note: REFERRER_WALLET is ignored when CHEST_API_KEY is set");
  }
} else if (REFERRER_WALLET) {
  console.error(`[chest-mcp] Referrer: ${REFERRER_WALLET} (earning commission per paid call)`);
} else {
  console.error("[chest-mcp] Warning: no CHEST_API_KEY or REFERRER_WALLET set, not earning commissions");
}
if (!AGENT_PRIVATE_KEY_RAW) {
  console.error("[chest-mcp] Warning: AGENT_WALLET_PRIVATE_KEY not set, cannot pay for API calls beyond freebies");
}

// Warm the gate catalog so the first ListTools call doesn't pay the fan-out
// latency. Failures are non-fatal: loadGates returns the fallback.
const initialGates = await loadGates();
const source = cachedGates === initialGates ? "live gates" : "fallback";
console.error(
  `[chest-mcp] Ready, ${initialGates.length} APIs registered (${source}: ${CHEST_GATE_BASE_URL})`,
);
