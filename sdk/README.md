# @chest-gate/sdk

[![npm](https://img.shields.io/npm/v/@chest-gate/sdk.svg)](https://www.npmjs.com/package/@chest-gate/sdk)
[![license](https://img.shields.io/npm/l/@chest-gate/sdk.svg)](./LICENSE)

> Drop-in `paidFetch()` that pays [x402](https://x402.org) gates from any agent. One line replaces `fetch()`, the SDK signs the 402 challenge, settles USDC on Solana, and returns the response.

## Install

```bash
npm install @chest-gate/sdk
```

## Quickstart

Mint an API key at [chest.sh/app/keys](https://chest.sh/app/keys), then:

```ts
import { paidFetch } from "@chest-gate/sdk";

const { body, receipt, payer } = await paidFetch(
  "https://gate.chest.sh/g/market-read/price/BTC",
  {
    mode: "api-key",
    apiKey: process.env.CHEST_API_KEY,
    appSlug: "@alice/market-read", // optional, declares the calling App
  },
);

console.log(body);                 // gate response
console.log(receipt.txSignature);  // on-chain settlement
```

`chest.sh` resolves the key, signs the x402 payload server-side from a Privy-managed wallet, and returns the gate response. Atomic 4-way USDC split (provider, referrer, protocol, remainder) settles via the `chest_splitter` Anchor program.

## Credential modes

Same `paidFetch(url, opts)` signature for both.

| Mode | Where the credential lives | Best for |
|---|---|---|
| **`api-key`** | `apiKey` option or `CHEST_API_KEY` env | deployed agents, MCP servers, CI jobs |
| **`local`** | `~/.chest/agent.json` (Solana secret-key JSON) | self-custody, offline-signed |

`api-key` mode posts the 402 challenge to `chest.sh/api/agent/sign` and signs server-side via a Privy-managed wallet. `local` mode signs locally; `chest.sh` is not in the path.

If `mode` is unset (or `"auto"`), the SDK picks in this order:

1. `apiKey` option provided → `api-key`
2. `CHEST_API_KEY` env set → `api-key`
3. `~/.chest/agent.json` exists → `local`
4. Throws with a helpful message

You almost never need to pass `mode` explicitly.

## Options

```ts
type PaidFetchOptions = {
  init?: RequestInit;          // forwarded to fetch() for the initial request
  mode?: "api-key" | "local" | "auto";
  apiKey?: string;             // ca_live_…, overrides file-based modes
  appSlug?: string;            // @author/app-name, analytics + referrer resolution
  referrerWallet?: string;     // explicit referrer; overrides manifest resolution
  chestApi?: string;           // override https://gate.chest.sh
  keypairFile?: string;        // override ~/.chest/agent.json (local mode)
};
```

## Returns

```ts
type PaidFetchResult = {
  body: unknown;               // gate response (parsed JSON or text)
  receipt: {                   // decoded x-payment-response header
    txSignature?: string;
    amount?: string | number;
    payer?: string;
  } | null;
  payer: string | null;        // wallet that paid
  mode: "api-key" | "privy" | "local";
};
```

## `appSlug` and the producer side

Pass `appSlug: "@alice/market-read"` when you're calling a gate on behalf of a registered App (Claude skill, MCP server, agent integration). The server logs it today and resolves the **referrer wallet** from the App's manifest, so the App's author earns a referral split on every paid call routed through their integration.

Want to route a referral split immediately? Pass `referrerWallet` explicitly.

## Hook event types

The SDK re-exports the typed payloads emitted by the proxy's lifecycle hooks, so any caller (a deployed proxy, a webhook handler, an indexer) can import the same shapes:

```ts
import type { RequestEvent, SettledEvent } from "@chest-gate/sdk";
```

`RequestEvent` is fired before settlement (and can be rejected); `SettledEvent` extends it with the on-chain tx signature and predicted split amounts.

## Related

- [`@chest-gate/install`](https://www.npmjs.com/package/@chest-gate/install) — one-command installer for Chest Gate skills
- [`@chest-gate/mcp`](https://www.npmjs.com/package/@chest-gate/mcp) — MCP server exposing chest.sh APIs as tools
- [`@chest-gate/upstream-proxy`](https://www.npmjs.com/package/@chest-gate/upstream-proxy) — generate a key-holding proxy for upstream APIs
- [`chesthq/apps`](https://github.com/chesthq/apps) — copy-paste skills, plugins, and upstream APIs

## License

MIT © Chest Gate
