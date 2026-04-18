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
 * needed — call_api dispatches by name.
 *
 * Usage (stdio):
 *   REFERRER_WALLET=<addr> AGENT_WALLET_PRIVATE_KEY='[1,2,3,...]' npx @chest/mcp
 *
 * Claude Desktop config (~/.config/claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "chest": {
 *         "command": "node",
 *         "args": ["/path/to/chest-gate/packages/mcp/dist/index.js"],
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

/** Secret key for paying x402 API calls — JSON array [1,2,3,...] or base64 string. */
const AGENT_PRIVATE_KEY_RAW = process.env.AGENT_WALLET_PRIVATE_KEY || "";

// ─── Known API Registry ──────────────────────────────────────────────────────

type Category = "trading" | "ai" | "data" | "content" | "utility";

interface ApiInfo {
  /** Slug used as the API name (matches split config and call_api dispatch key) */
  name: string;
  category: Category;
  description: string;
  /** Default upstream URL — override per API via {NAME}_GATE_URL env. */
  gateUrl: string;
  /** Endpoints exposed by this API. Path → human description. */
  endpoints: Record<string, string>;
  /** Per-call price in USD (display only — actual price comes from the 402 challenge). */
  price: string;
  /** Optional list of supported parameter values (e.g. tokens) for guidance. */
  supports?: string[];
}

/**
 * Every Chest example API lives here. To add a new one:
 *   1. Build it under examples/<slug>/
 *   2. Append an entry below
 *   3. Set {SLUG}_GATE_URL in your env (or accept the localhost default)
 *
 * Endpoints whose price is free (e.g. /tokens) won't trigger a 402 — call_api
 * passes through the raw response.
 */
const KNOWN_APIS: ApiInfo[] = [
  // ─── Trading data ─────────────────────────────────────────────────────────
  {
    name: "sentiment-api",
    category: "trading",
    description: "Real-time crypto market sentiment powered by Perplexity AI",
    gateUrl: process.env.SENTIMENT_GATE_URL || "http://localhost:4010",
    endpoints: {
      "GET /sentiment/:token": "Sentiment score (-1 to +1), label, summary, sources",
      "GET /tokens": "List supported tokens (free)",
    },
    price: "$0.005",
    supports: ["SOL", "BTC", "ETH", "JUP", "BONK", "RAY", "WIF", "JTO", "PYTH", "ORCA"],
  },
  {
    name: "technicals-api",
    category: "trading",
    description: "Real-time technical indicators (RSI, MACD, EMA) powered by Binance",
    gateUrl: process.env.TECHNICALS_GATE_URL || "http://localhost:4011",
    endpoints: {
      "GET /technicals/:token": "RSI-14, MACD, EMA-20/50/200, trend signal",
      "GET /tokens": "List supported tokens (free)",
    },
    price: "$0.003",
    supports: ["SOL", "BTC", "ETH", "JUP", "BONK", "RAY", "WIF", "JTO", "PYTH", "ORCA"],
  },
  {
    name: "liquidations-api",
    category: "trading",
    description: "24h liquidation totals + key levels powered by Coinglass",
    gateUrl: process.env.LIQUIDATIONS_GATE_URL || "http://localhost:4012",
    endpoints: {
      "GET /liquidations/:token": "Long/short liquidations, key levels, open interest",
      "GET /tokens": "List supported tokens (free)",
    },
    price: "$0.003",
    supports: ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "DOT"],
  },
  {
    name: "funding-rates",
    category: "trading",
    description: "Perpetual futures funding rates across major venues — bullish/bearish bias signal",
    gateUrl: process.env.FUNDING_RATES_GATE_URL || "http://localhost:4013",
    endpoints: {
      "GET /funding": "All supported tokens at once",
      "GET /funding/:token": "Funding rate for one token",
      "GET /tokens": "List supported tokens (free)",
    },
    price: "$0.002",
    supports: ["BTC", "ETH", "SOL", "BNB", "AVAX", "ARB", "OP", "JUP", "WIF", "BONK"],
  },
  {
    name: "implied-volatility",
    category: "trading",
    description: "Options implied volatility term structure (7d/30d/90d/180d) — risk pricing signal",
    gateUrl: process.env.IMPLIED_VOLATILITY_GATE_URL || "http://localhost:4015",
    endpoints: {
      "GET /iv/:token": "IV term structure with skew",
      "GET /tokens": "List supported tokens (free)",
    },
    price: "$0.004",
    supports: ["BTC", "ETH"],
  },
  {
    name: "token-unlocks",
    category: "trading",
    description: "Upcoming token unlock schedule with sell-pressure signals (cliff vs vesting)",
    gateUrl: process.env.TOKEN_UNLOCKS_GATE_URL || "http://localhost:4016",
    endpoints: {
      "GET /unlocks": "All upcoming unlocks across tracked tokens",
      "GET /unlocks/:token": "Unlock schedule for one token",
      "GET /tokens": "List supported tokens (free)",
    },
    price: "$0.003",
  },
  {
    name: "trading-signals",
    category: "trading",
    description: "Aggregated long/short signals across major SOL/USDC, ETH/USDC pairs",
    gateUrl: process.env.TRADING_SIGNALS_GATE_URL || "http://localhost:4001",
    endpoints: {
      "GET /signals": "All signals across pairs",
      "GET /signals/:pair": "Signal for one pair (use SOL-USDC, ETH-USDC format)",
      "GET /pairs": "List supported pairs (free)",
    },
    price: "$0.004",
  },

  // ─── Market data ──────────────────────────────────────────────────────────
  {
    name: "market-data",
    category: "data",
    description: "Spot prices and L2 orderbook snapshots for major tokens",
    gateUrl: process.env.MARKET_DATA_GATE_URL || "http://localhost:4004",
    endpoints: {
      "GET /prices": "All token spot prices",
      "GET /price/:token": "Price for one token",
      "GET /orderbook/:token": "L2 bid/ask snapshot",
      "GET /tokens": "List supported tokens (free)",
    },
    price: "$0.001",
  },
  {
    name: "polymarket-prices",
    category: "data",
    description: "Live odds from Polymarket prediction markets",
    gateUrl: process.env.POLYMARKET_PRICES_GATE_URL || "http://localhost:4014",
    endpoints: {
      "GET /markets": "All active markets with prices",
      "GET /markets/:slug": "One market by slug (e.g. 'will-btc-hit-100k-by-2026')",
    },
    price: "$0.002",
  },
  {
    name: "weather-api",
    category: "data",
    description: "Current conditions for major cities (demo / utility example)",
    gateUrl: process.env.WEATHER_GATE_URL || "http://localhost:4000",
    endpoints: {
      "GET /weather/:city": "Current conditions",
      "GET /cities": "List supported cities (free)",
    },
    price: "$0.001",
  },

  // ─── AI / content ─────────────────────────────────────────────────────────
  {
    name: "ai-inference",
    category: "ai",
    description: "Pay-per-call inference: sentiment classification, summarization, topic tagging",
    gateUrl: process.env.AI_INFERENCE_GATE_URL || "http://localhost:4003",
    endpoints: {
      "POST /sentiment": "{ text } → sentiment score + label",
      "POST /summarize": "{ text } → short summary",
      "POST /classify": "{ text } → topic category",
    },
    price: "$0.01",
  },
  {
    name: "content-paywall",
    category: "content",
    description: "Premium long-form articles — preview free, full read paid",
    gateUrl: process.env.CONTENT_PAYWALL_GATE_URL || "http://localhost:4005",
    endpoints: {
      "GET /articles": "List article previews (free)",
      "GET /articles/:id/preview": "Preview only (free)",
      "GET /articles/:id": "Full article (paid)",
    },
    price: "$0.05",
  },
  {
    name: "web-scraper",
    category: "data",
    description: "On-demand structured scrape across 5 categories (news, ecommerce, classifieds, jobs, real estate)",
    gateUrl: process.env.WEB_SCRAPER_GATE_URL || "http://localhost:4002",
    endpoints: {
      "GET /scrape/:category": "Scrape results for one category",
      "GET /categories": "List supported categories (free)",
    },
    price: "$0.02",
  },
];

function findApi(name: string): ApiInfo | undefined {
  return KNOWN_APIS.find((a) => a.name === name);
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

  // First try — may be free, freebie, or session-cached.
  const firstResponse = await fetch(url, { method, headers: baseHeaders, body });

  if (firstResponse.status !== 402) {
    if (!firstResponse.ok) {
      const text = await firstResponse.text();
      throw new Error(`API error ${firstResponse.status}: ${text}`);
    }
    return firstResponse.json();
  }

  // 402 — payment required.
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

  // Sign the referral claim — proves we own REFERRER_WALLET so the splitter
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
  { name: "chest", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

const apiNames = KNOWN_APIS.map((a) => a.name);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "discover_apis",
      description:
        "List every Chest-gated API with pricing, endpoints, category, and supported parameters. " +
        "Call this first to explore what's available — the registry covers trading data, AI inference, " +
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
        "vault address, split config). Useful before paying — agents can decide whether the commission rate is worth it.",
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
        "Comprehensive token analysis — calls sentiment, technicals, and liquidations APIs in parallel and returns the combined picture. " +
        "Total cost: ~$0.011 (3 paid calls). Use this when you need a full market view in one shot. " +
        "For deeper analysis (funding, IV, unlocks), pass `deep: true` — adds ~$0.009 and 3 more APIs.",
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "discover_apis": {
        const cat = a.category as string | undefined;
        const filtered = cat ? KNOWN_APIS.filter((x) => x.category === cat) : KNOWN_APIS;
        return {
          content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
        };
      }

      case "get_api_info": {
        const api = findApi(a.api as string);
        if (!api) {
          return {
            content: [
              { type: "text", text: `Unknown API '${a.api}'. Available: ${apiNames.join(", ")}` },
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
          // Gate may not be running — return registry info only.
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ ...api, discovery }, null, 2) }],
        };
      }

      case "call_api": {
        const api = findApi(a.api as string);
        if (!api) {
          return {
            content: [{ type: "text", text: `Unknown API '${a.api}'` }],
            isError: true,
          };
        }
        const path = a.path as string;
        if (!path?.startsWith("/")) {
          return {
            content: [{ type: "text", text: `Path must start with '/' — got '${path}'` }],
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

/** Helper for analyze_token — looks up an API and calls one of its endpoints. */
async function callForToken(apiName: string, path: string): Promise<any> {
  const api = findApi(apiName);
  if (!api) throw new Error(`API ${apiName} not in registry`);
  return callGatedApi(api.gateUrl, path, api.name);
}

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr (stdout is reserved for MCP protocol).
if (!REFERRER_WALLET) {
  console.error("[chest-mcp] Warning: REFERRER_WALLET not set — not earning commissions");
} else {
  console.error(`[chest-mcp] Referrer: ${REFERRER_WALLET} (earning commission per paid call)`);
}
if (!AGENT_PRIVATE_KEY_RAW) {
  console.error("[chest-mcp] Warning: AGENT_WALLET_PRIVATE_KEY not set — cannot pay for API calls beyond freebies");
}
console.error(`[chest-mcp] Ready — ${KNOWN_APIS.length} APIs registered`);
