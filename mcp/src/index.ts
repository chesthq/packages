#!/usr/bin/env node
/**
 * Chest MCP Server
 *
 * Exposes x402-gated crypto data APIs as MCP tools.
 * Any AI agent using this MCP server earns a commission on every API call
 * by having its wallet address injected as X-Referrer-Wallet automatically.
 *
 * Usage (stdio):
 *   REFERRER_WALLET=<your-sol-address> AGENT_WALLET_PRIVATE_KEY='[1,2,3,...]' npx @chest/mcp
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

/** Hot wallet that signs referral claims (proves ownership). Also used as payout if REFERRER_PAYOUT_WALLET unset. */
const REFERRER_WALLET = process.env.REFERRER_WALLET || "";

/**
 * Optional cold wallet to receive commission payouts.
 * The hot key (REFERRER_WALLET) still signs, but funds go here.
 * Set this to separate signing risk from funds.
 */
const REFERRER_PAYOUT_WALLET = process.env.REFERRER_PAYOUT_WALLET || "";

/** Secret key for paying x402 API calls — JSON array [1,2,3,...] or base64 string */
const AGENT_PRIVATE_KEY_RAW = process.env.AGENT_WALLET_PRIVATE_KEY || "";

// ─── Known API Registry ───────────────────────────────────────────────────────

interface ApiInfo {
  name: string;
  description: string;
  gateUrl: string;
  endpoints: Record<string, string>;
  price: string;
}

const KNOWN_APIS: ApiInfo[] = [
  {
    name: "sentiment-api",
    description: "Real-time crypto market sentiment powered by Perplexity AI",
    gateUrl: process.env.SENTIMENT_GATE_URL || "http://localhost:4010",
    endpoints: {
      "GET /sentiment/:token": "Get sentiment score, label, and summary for a token",
      "GET /tokens": "List supported tokens (free)",
    },
    price: "$0.005",
  },
  {
    name: "technicals-api",
    description: "Real-time technical indicators (RSI, MACD, EMA) powered by Binance",
    gateUrl: process.env.TECHNICALS_GATE_URL || "http://localhost:4011",
    endpoints: {
      "GET /technicals/:token": "Get RSI-14, MACD, EMA-20/50/200 and trend signal",
      "GET /tokens": "List supported tokens (free)",
    },
    price: "$0.003",
  },
  {
    name: "liquidations-api",
    description: "Real-time liquidation data and key price levels powered by Coinglass",
    gateUrl: process.env.LIQUIDATIONS_GATE_URL || "http://localhost:4012",
    endpoints: {
      "GET /liquidations/:token": "Get 24h liquidation totals, key levels, open interest",
      "GET /tokens": "List supported tokens (free)",
    },
    price: "$0.003",
  },
];

// ─── x402 Payment Client ──────────────────────────────────────────────────────

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

  // Lazy-load heavy Solana deps
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  const { registerExactSvmScheme } = await import("@x402/svm/exact/client");
  const { x402Client } = await import("@x402/core/client");

  // @x402/svm client signer is just the keypair signer directly (ClientSvmSigner = TransactionSigner)
  const keypairSigner = await createKeyPairSignerFromBytes(agentSecretKey);

  const client = new x402Client();
  registerExactSvmScheme(client, { signer: keypairSigner });

  paymentClient = client;
  return client;
}

/**
 * Make a paid request to an x402-gated endpoint.
 * Automatically signs and injects X-Referrer-Wallet + X-Referrer-Sig so the
 * MCP operator earns commissions verified on-chain.
 *
 * @param baseUrl - Gate URL (e.g. http://localhost:4010)
 * @param path    - API path (e.g. /sentiment/SOL)
 * @param slug    - API name matching the split config (for referral signature)
 */
async function callGatedApi(baseUrl: string, path: string, slug: string): Promise<any> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    "Accept": "application/json",
  };

  // First try — might be a freebie or session-cached (no payment or sig needed)
  const firstResponse = await fetch(url, { headers });

  if (firstResponse.status !== 402) {
    if (!firstResponse.ok) {
      const text = await firstResponse.text();
      throw new Error(`API error ${firstResponse.status}: ${text}`);
    }
    return firstResponse.json();
  }

  // 402 — payment required
  const client = await getPaymentClient();
  if (!client) {
    throw new Error(
      "Payment required. Set AGENT_WALLET_PRIVATE_KEY env var (JSON array of secret key bytes) to make paid API calls."
    );
  }

  // Parse the 402 response to get payment requirements
  const paymentRequired = await firstResponse.json() as any;

  // Extract amount from the first accepted requirement for referral signing
  const amountMicros = parseInt(
    paymentRequired?.accepts?.[0]?.amount ?? paymentRequired?.amount ?? "0",
    10
  );

  // Create payment payload using x402 client
  const { x402HTTPClient } = await import("@x402/core/client");
  const httpClient = new x402HTTPClient(client);
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired as any);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  // Sign the referral claim if we have a wallet + key
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

  // Retry with payment + referral signature
  const paidResponse = await fetch(url, {
    headers: { ...headers, ...paymentHeaders },
  });

  if (!paidResponse.ok) {
    const text = await paidResponse.text();
    throw new Error(`Paid API error ${paidResponse.status}: ${text}`);
  }

  return paidResponse.json();
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "chest", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "discover_apis",
      description:
        "List all available Chest-gated crypto data APIs with pricing and endpoints. Call this first to explore what data is available.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_api_info",
      description:
        "Get detailed info about a specific API including its on-chain discovery data (referrer commission rates, vault address, split config).",
      inputSchema: {
        type: "object",
        properties: {
          api: {
            type: "string",
            description: "API name: 'sentiment-api', 'technicals-api', or 'liquidations-api'",
          },
        },
        required: ["api"],
      },
    },
    {
      name: "get_sentiment",
      description:
        "Get real-time market sentiment for a crypto token. Returns: sentiment score (-1.0 bearish to +1.0 bullish), label (bullish/bearish/neutral), AI summary, and news sources. Powered by Perplexity AI. Costs $0.005.",
      inputSchema: {
        type: "object",
        properties: {
          token: {
            type: "string",
            description: "Token symbol (SOL, BTC, ETH, JUP, BONK, RAY, WIF, JTO, PYTH, ORCA)",
          },
        },
        required: ["token"],
      },
    },
    {
      name: "get_technicals",
      description:
        "Get technical indicators for a crypto token: RSI-14 (overbought/oversold signal), MACD (momentum), EMA-20/50/200 (trend), and overall trend direction. Powered by Binance. Costs $0.003.",
      inputSchema: {
        type: "object",
        properties: {
          token: {
            type: "string",
            description: "Token symbol (SOL, BTC, ETH, JUP, BONK, RAY, WIF, JTO, PYTH, ORCA)",
          },
        },
        required: ["token"],
      },
    },
    {
      name: "get_liquidations",
      description:
        "Get 24h liquidation data for a crypto token: total USD liquidated (longs vs shorts), key price levels where liquidations are clustered, open interest, and long/short ratio. Powered by Coinglass. Costs $0.003.",
      inputSchema: {
        type: "object",
        properties: {
          token: {
            type: "string",
            description: "Token symbol (BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK, DOT)",
          },
        },
        required: ["token"],
      },
    },
    {
      name: "analyze_token",
      description:
        "Comprehensive token analysis combining sentiment + technicals + liquidations in one call. Returns structured data from all three APIs. Total cost: $0.011 (3 calls). Use this when you need a full market picture.",
      inputSchema: {
        type: "object",
        properties: {
          token: {
            type: "string",
            description: "Token symbol (e.g. SOL, BTC, ETH)",
          },
        },
        required: ["token"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, string>;

  try {
    switch (name) {
      case "discover_apis":
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(KNOWN_APIS, null, 2),
            },
          ],
        };

      case "get_api_info": {
        const api = KNOWN_APIS.find((x) => x.name === a.api);
        if (!api) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown API '${a.api}'. Available: ${KNOWN_APIS.map((x) => x.name).join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        // Fetch discovery endpoint
        let discovery: unknown = null;
        try {
          const r = await fetch(`${api.gateUrl}/.well-known/chest.json`);
          if (r.ok) discovery = await r.json();
        } catch {
          // Gate may not be running
        }

        return {
          content: [
            { type: "text", text: JSON.stringify({ ...api, discovery }, null, 2) },
          ],
        };
      }

      case "get_sentiment": {
        const token = a.token.toUpperCase();
        const api = KNOWN_APIS.find((x) => x.name === "sentiment-api")!;
        const data = await callGatedApi(api.gateUrl, `/sentiment/${token}`, api.name);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "get_technicals": {
        const token = a.token.toUpperCase();
        const api = KNOWN_APIS.find((x) => x.name === "technicals-api")!;
        const data = await callGatedApi(api.gateUrl, `/technicals/${token}`, api.name);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "get_liquidations": {
        const token = a.token.toUpperCase();
        const api = KNOWN_APIS.find((x) => x.name === "liquidations-api")!;
        const data = await callGatedApi(api.gateUrl, `/liquidations/${token}`, api.name);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "analyze_token": {
        const token = a.token.toUpperCase();
        const [sentimentApi, techApi, liqApi] = [
          KNOWN_APIS.find((x) => x.name === "sentiment-api")!,
          KNOWN_APIS.find((x) => x.name === "technicals-api")!,
          KNOWN_APIS.find((x) => x.name === "liquidations-api")!,
        ];

        const [sentiment, technicals, liquidations] = await Promise.allSettled([
          callGatedApi(sentimentApi.gateUrl, `/sentiment/${token}`, sentimentApi.name),
          callGatedApi(techApi.gateUrl, `/technicals/${token}`, techApi.name),
          callGatedApi(liqApi.gateUrl, `/liquidations/${token}`, liqApi.name),
        ]);

        const result = {
          token,
          timestamp: new Date().toISOString(),
          referrer: REFERRER_WALLET || null,
          sentiment:
            sentiment.status === "fulfilled"
              ? sentiment.value
              : { error: (sentiment as PromiseRejectedResult).reason?.message },
          technicals:
            technicals.status === "fulfilled"
              ? technicals.value
              : { error: (technicals as PromiseRejectedResult).reason?.message },
          liquidations:
            liquidations.status === "fulfilled"
              ? liquidations.value
              : { error: (liquidations as PromiseRejectedResult).reason?.message },
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr (stdout is reserved for MCP protocol)
if (!REFERRER_WALLET) {
  console.error("[chest-mcp] Warning: REFERRER_WALLET not set — not earning commissions");
} else {
  console.error(`[chest-mcp] Referrer: ${REFERRER_WALLET} (earning 10% commission per call)`);
}
if (!AGENT_PRIVATE_KEY_RAW) {
  console.error("[chest-mcp] Warning: AGENT_WALLET_PRIVATE_KEY not set — cannot pay for API calls beyond freebies");
}
console.error("[chest-mcp] Ready");
