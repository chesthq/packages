# @chest-gate/sdk

Drop-in `paidFetch()` that pays x402 gates from any agent — managed wallet
(Chest API key), Privy login, or local keypair.

```bash
npm install @chest-gate/sdk
```

## Quick start (managed wallet, no keys on disk)

```ts
import { paidFetch } from "@chest-gate/sdk";

const { body, receipt, payer } = await paidFetch(
  "https://gate.chest.sh/g/market-read/price/BTC",
  {
    mode: "api-key",
    apiKey: process.env.CHEST_API_KEY,        // mint at chest.sh/app/keys
    appSlug: "@alice/market-read",            // optional — declares the calling App
  },
);
```

`chest.sh` resolves the key → user → Privy-managed wallet, signs the x402
payload, returns the `xPayment` header. The gate atomically settles USDC
across provider, referrer, and protocol via the `chest_splitter` Anchor
program on Solana.

## Three credential modes

All three use the same `paidFetch(url, opts)` signature.

| Mode | Where the credential lives | Best for |
|---|---|---|
| **`api-key`** | `apiKey` option or `CHEST_API_KEY` env | deployed agents, MCP servers, CI jobs |
| **`privy`** | `~/.chest/auth.json` (written by `chest login`) | local CLI / dev |
| **`local`** | `~/.chest/agent.json` (Solana secret-key JSON) | self-custody, offline-signed |

`api-key` and `privy` modes are functionally identical at the wire level —
both POST the 402 challenge to `chest.sh/api/agent/sign` with a bearer token,
and chest.sh signs server-side via Privy. The only difference is where the
SDK reads the token from.

`local` mode signs locally; `chest.sh` is not in the path.

## Auto-detect

If `mode` is unset (or `"auto"`):

1. `apiKey` option provided  → `api-key`
2. `CHEST_API_KEY` env set   → `api-key`
3. `~/.chest/auth.json`      → `privy`
4. `~/.chest/agent.json`     → `local`
5. throws with a helpful message

You almost never need to pass `mode` explicitly.

## Options

```ts
type PaidFetchOptions = {
  init?: RequestInit;            // forwarded to fetch() for the initial request
  mode?: "api-key" | "privy" | "local" | "auto";
  apiKey?: string;               // ca_live_… — overrides file-based modes
  appSlug?: string;              // @author/app-name — analytics + future referrer resolution
  referrerWallet?: string;       // explicit referrer; overrides manifest resolution
  chestApi?: string;             // override https://chest.sh
  authFile?: string;             // override ~/.chest/auth.json (privy mode)
  keypairFile?: string;          // override ~/.chest/agent.json (local mode)
};
```

## Returns

```ts
type PaidFetchResult = {
  body: unknown;                 // gate response (parsed JSON or text)
  receipt: {                     // decoded x-payment-response header
    txSignature?: string;
    amount?: string | number;
    payer?: string;
  } | null;
  payer: string | null;          // wallet that paid
  mode: "api-key" | "privy" | "local";
};
```

## `appSlug` and the producer side

Pass `appSlug: "@alice/market-read"` when you're calling a gate on behalf of
an App (Claude skill, MCP server, agent integration). The server logs it
today and will resolve the **referrer wallet** from the App's manifest in a
future release — so the App's author earns a referral split on every paid
call routed through their integration.

If you want to route a referral split now, pass `referrerWallet` explicitly.

## Hook event types (`v0.2.0`)

The SDK re-exports the typed payloads emitted by the proxy's lifecycle
hooks, so any caller — a deployed proxy, a webhook handler, an indexer —
can import the same shapes:

```ts
import type { RequestEvent, SettledEvent } from "@chest-gate/sdk";
```

`RequestEvent` is fired before settlement (and can be rejected); `SettledEvent`
extends it with the on-chain tx signature and predicted split amounts. See
the [hook-logging example](../../examples/hook-logging) for end-to-end usage.

## See also

- Example: [`examples/api-key-agent`](../../examples/api-key-agent) — managed wallet client
- Example: [`examples/hook-logging`](../../examples/hook-logging) — proxy lifecycle hooks
- chest_splitter program (devnet): `9a6zrqau5xVEdxNqBUfL2G18WuryQbWeJScPAUHZvmmX`
- Repo: <https://github.com/smd00/chest-gate>

## License

MIT
