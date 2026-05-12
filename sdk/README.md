# @chest-gate/sdk

[![npm](https://img.shields.io/npm/v/@chest-gate/sdk.svg)](https://www.npmjs.com/package/@chest-gate/sdk)
[![license](https://img.shields.io/npm/l/@chest-gate/sdk.svg)](./LICENSE)

> Drop-in `paidFetch()` that pays [x402](https://x402.org) gates from any agent. One line replaces `fetch()`, the SDK signs the 402 challenge, settles USDC on Solana, and returns the response.

## Install

```bash
npm install @chest-gate/sdk
```

## Quickstart

Mint an agent token at [chest.sh/dashboard/agent-wallet](https://chest.sh/dashboard/agent-wallet), then:

```ts
import { paidFetch } from "@chest-gate/sdk";

const { body, receipt, payer } = await paidFetch(
  "https://gate.chest.sh/g/market-read/price/BTC",
  {
    mode: "agent-token",
    agentToken: process.env.CHEST_AGENT_TOKEN,
    appSlug: "market-read", // optional, declares the calling App
  },
);

console.log(body);                 // gate response
console.log(receipt.txSignature);  // on-chain settlement
```

`chest.sh` resolves the token, signs the x402 payload server-side from a Privy-managed wallet, and returns the gate response. Atomic 4-way USDC split (provider, referrer, protocol, remainder) settles via the `chest_splitter` Anchor program.

## Credential model

Two orthogonal axes:

- **Spending** — *who pays.* One of three modes below.
- **Attribution** — *who gets the cut.* `referrerKey`, `appSlug`, or `referrerWallet` (explicit beats implicit, in that order).

### Spending modes

| Mode | Where the credential lives | Best for |
|---|---|---|
| **`agent-token`** | `agentToken` option or `CHEST_AGENT_TOKEN` env | deployed agents, MCP servers, CI jobs |
| **`privy`** | `~/.chest/agent-token.json` (written by `chest-gate login`) | interactive dev sessions |
| **`local`** | `~/.chest/agent-keypair.json` (Solana secret-key JSON) | self-custody, offline-signed |

`agent-token` and `privy` post the 402 challenge to `chest.sh/api/agent/sign` and sign server-side via a Privy-managed wallet. `local` signs locally; `chest.sh` is not in the path.

If `mode` is unset (or `"auto"`), the SDK picks in this order:

1. `agentToken` option provided → `agent-token`
2. `CHEST_AGENT_TOKEN` env set → `agent-token`
3. `~/.chest/agent-token.json` exists → `privy`
4. `~/.chest/agent-keypair.json` exists → `local`
5. Throws with a helpful message

You almost never need to pass `mode` explicitly.

### Attribution

| Option | Header sent | Resolved to |
|---|---|---|
| `referrerKey: "cg_pub_…"` (or `CHEST_REFERRER_KEY` env) | `X-Chest-Referrer-Key` | Payout wallet bound at key creation. Safe to ship in distributed code. |
| `appSlug: "market-read"` (or `CHEST_APP_SLUG` env / nearest `app.md`) | `x-chest-app` | App's `authorWallet` from the apps registry. |
| `referrerWallet: "<pubkey>"` | `x-referrer-wallet` | The declared wallet (signature required for verified attribution). |

Precedence: `referrerKey` > `referrerWallet` > `appSlug`.

## Options

```ts
type PaidFetchOptions = {
  init?: RequestInit;          // forwarded to fetch() for the initial request
  mode?: "agent-token" | "privy" | "local" | "auto";
  agentToken?: string;         // ca_live_…, overrides file-based modes
  referrerKey?: string;        // cg_pub_…, attribution-only, safe to ship in code
  appSlug?: string;            // bare slug, e.g. "market-read"; if omitted, resolved from CHEST_APP_SLUG env or local app.md
  referrerWallet?: string;     // explicit referrer wallet
  chestApi?: string;           // override https://gate.chest.sh
  authFile?: string;           // override ~/.chest/agent-token.json (privy mode)
  keypairFile?: string;        // override ~/.chest/agent-keypair.json (local mode)
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
  mode: "agent-token" | "privy" | "local";
};
```

## `appSlug` and the producer side

Pass `appSlug: "market-read"` when you're calling a gate on behalf of a registered App (Claude skill, MCP server, agent integration). The server resolves the **referrer wallet** from the App's manifest, so the App's author earns a referral split on every paid call routed through their integration. The legacy `@author/app-name` form still works — the server normalises both to the same scope — but the bare slug is the canonical form.

You usually don't need to pass it explicitly. The SDK resolves `appSlug` in this order:

1. `appSlug` option in code — caller wins.
2. `CHEST_APP_SLUG` env var — production-friendly, works in any runtime.
3. Nearest `app.md` walking up from `cwd` — Node only, memoised, capped at 6 levels.

So in development, dropping a valid `app.md` next to your code is enough — the slug attaches itself to every `paidFetch` call. Set `CHEST_APP_SLUG_DISABLE=1` to opt out of filesystem discovery (e.g. running multiple unrelated apps from the same tree).

Get the canonical slug for an `app.md` with the CLI:

```bash
chest-gate app slug              # prints the canonical bare slug
export CHEST_APP_SLUG=$(chest-gate app slug)
```

Want to route a referral split immediately? Pass `referrerKey` or `referrerWallet` explicitly — both override `appSlug` resolution.

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
