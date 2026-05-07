#!/usr/bin/env node
/**
 * Chest MCP Server
 *
 * Exposes x402-gated APIs as MCP tools. Any AI agent using this server earns
 * commission on every paid call by injecting its wallet as X-Referrer-Wallet
 * (with an ed25519 signature, so the merchant's split program can verify it).
 *
 * Tool surface:
 *   - discover_apis      → list every known API (pricing, endpoints, category)
 *   - get_api_info       → details for one API (incl. on-chain split metadata)
 *   - call_api           → make any GET/POST against any registered API
 *   - analyze_token      → convenience: parallel call to the trading data APIs
 *
 * Adding a new example API: extend KNOWN_APIS with one entry. No new tool
 * needed, call_api dispatches by name.
 *
 * Usage (stdio):
 *   REFERRER_WALLET=<addr> AGENT_WALLET_PRIVATE_KEY='[1,2,3,...]' npx @chest-gate/mcp
 *
 * Claude Desktop config (~/.config/claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "chest": {
 *         "command": "npx",
 *         "args": ["-y", "@chest-gate/mcp"],
 *         "env": {
 *           "REFERRER_WALLET": "YOUR_SOLANA_WALLET_ADDRESS",
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

/** Hot wallet that signs referral claims (proves ownership). */
const REFERRER_WALLET = process.env.REFERRER_WALLET || "";

/**
 * Optional cold wallet to receive commission payouts.
 * The hot key (REFERRER_WALLET) signs; funds go here. Set this to separate
 * signing risk from funds.
 */
const REFERRER_PAYOUT_WALLET = process.env.REFERRER_PAYOUT_WALLET || "";

/** Secret key for paying x402 API calls, JSON array [1,2,3,...] or base64 string. */
const AGENT_PRIVATE_KEY_RAW = process.env.AGENT_WALLET_PRIVATE_KEY || "";

/** Base URL of the Chest gate. Per-API URLs default to {BASE}/g/{slug}. */
const CHEST_GATE_BASE_URL = process.env.CHEST_GATE_BASE_URL || "https://gate.chest.sh";

const gate = (slug: string) => `${CHEST_GATE_BASE_URL}/g/${slug}`;

// ─── API Registry ────────────────────────────────────────────────────────────
//
// Loaded dynamically from the live Chest registry at startup and refreshed on
// a TTL. The package no longer ships a hardcoded list, so newly published
// gates appear without a release. A small fallback list (FALLBACK_APIS) keeps
// the server functional when /api/registry is unreachable (offline dev,
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

interface RegistryDeployment {
  slug: string;
  name?: string | null;
  description?: string | null;
  category?: string | null;
  price?: string | number | null;
  routePrices?: Record<string, string> | null;
}

interface BazaarEndpoint {
  path: string;
  description?: string;
  price?: string;
}

/**
 * Best-effort fetch of a gate's discovery doc to recover the per-endpoint
 * path table (which the registry summary doesn't include). Returns an empty
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
 * Tiny offline fallback. Used only when /api/registry is unreachable AND we
 * have no cached registry yet. Keep this short, the live registry is the
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

const REGISTRY_TTL_MS = 10 * 60_000;
let cachedRegistry: ApiInfo[] | null = null;
let cachedAt = 0;
let inflight: Promise<ApiInfo[]> | null = null;

async function loadRegistry(): Promise<ApiInfo[]> {
  const now = Date.now();
  if (cachedRegistry && now - cachedAt < REGISTRY_TTL_MS) return cachedRegistry;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const r = await fetch(`${CHEST_GATE_BASE_URL}/api/registry`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json() as { deployments?: RegistryDeployment[] };
      const deployments = body.deployments ?? [];

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
          };
        }),
      );

      cachedRegistry = apis;
      cachedAt = Date.now();
      return apis;
    } catch (err) {
      console.error(
        `[chest-mcp] registry fetch failed: ${(err as Error).message}, ` +
        `${cachedRegistry ? "using stale cache" : "using fallback"}`,
      );
      return cachedRegistry ?? FALLBACK_APIS;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

async function findApi(name: string): Promise<ApiInfo | undefined> {
  const apis = await loadRegistry();
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
 *   - sign referral claim with REFERRER_WALLET (so we earn commission)
 *   - retry with x-payment + referral headers
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

  // Sign the referral claim, proves we own REFERRER_WALLET so the splitter
  // routes the 10% commission to it (or the cold REFERRER_PAYOUT_WALLET).
  if (REFERRER_WALLET && agentSecretKey) {
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
  { name: "chest", version: "0.2.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const apis = await loadRegistry();
  const apiNames = apis.map((a) => a.name);
  return { tools: [
    {
      name: "discover_apis",
      description:
        "List every Chest-gated API with pricing, endpoints, category, and supported parameters. " +
        "Call this first to explore what's available, the registry covers trading data, AI inference, " +
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
        "Get detailed info about one API including its on-chain discovery metadata (referrer commission rate, " +
        "vault address, split config). Useful before paying, agents can decide whether the commission rate is worth it.",
      inputSchema: {
        type: "object",
        properties: {
          api: {
            type: "string",
            enum: apiNames,
            description: `API name. One of: ${apiNames.join(", ")}`,
          },
        },
        required: ["api"],
      },
    },
    {
      name: "call_api",
      description:
        "Make a request to any Chest-gated API. Pays via x402 on Solana automatically (using your AGENT_WALLET_PRIVATE_KEY) " +
        "and signs an X-Referrer-Sig header with REFERRER_WALLET so you earn commission on every call. " +
        "For GET endpoints, only `path` is needed. For POST endpoints (e.g. ai-inference), pass `body` as a JSON object. " +
        "Use discover_apis first to find available endpoints.",
      inputSchema: {
        type: "object",
        properties: {
          api: {
            type: "string",
            enum: apiNames,
            description: `API name. One of: ${apiNames.join(", ")}`,
          },
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
        required: ["api", "path"],
      },
    },
    {
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
    },
  ] };
});

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "discover_apis": {
        const apis = await loadRegistry();
        const cat = a.category as string | undefined;
        const filtered = cat ? apis.filter((x) => x.category === cat) : apis;
        return {
          content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
        };
      }

      case "get_api_info": {
        const api = await findApi(a.api as string);
        if (!api) {
          const apis = await loadRegistry();
          return {
            content: [
              { type: "text", text: `Unknown API '${a.api}'. Available: ${apis.map((x) => x.name).join(", ")}` },
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
          // Gate may not be running, return registry info only.
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ ...api, discovery }, null, 2) }],
        };
      }

      case "call_api": {
        const api = await findApi(a.api as string);
        if (!api) {
          return {
            content: [{ type: "text", text: `Unknown API '${a.api}'` }],
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
  if (!api) throw new Error(`API ${apiName} not in registry`);
  return callGatedApi(api.gateUrl, path, api.name);
}

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr (stdout is reserved for MCP protocol).
if (!REFERRER_WALLET) {
  console.error("[chest-mcp] Warning: REFERRER_WALLET not set, not earning commissions");
} else {
  console.error(`[chest-mcp] Referrer: ${REFERRER_WALLET} (earning commission per paid call)`);
}
if (!AGENT_PRIVATE_KEY_RAW) {
  console.error("[chest-mcp] Warning: AGENT_WALLET_PRIVATE_KEY not set, cannot pay for API calls beyond freebies");
}

// Warm the registry so the first ListTools call doesn't pay the fan-out
// latency. Failures are non-fatal: loadRegistry returns the fallback.
const initialRegistry = await loadRegistry();
const source = cachedRegistry === initialRegistry ? "live registry" : "fallback";
console.error(
  `[chest-mcp] Ready, ${initialRegistry.length} APIs registered (${source}: ${CHEST_GATE_BASE_URL})`,
);
