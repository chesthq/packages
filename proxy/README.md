# @chest-gate/proxy

x402 reverse proxy engine for Chest. Powers `@chest-gate/cli` and the chest.sh cloud server. Use it directly if you want to embed an x402-paid gate inside your own Node service.

```bash
npm i @chest-gate/proxy
```

## Quick start

```ts
import { createProxy } from "@chest-gate/proxy";

const server = await createProxy({
  upstream: "http://localhost:8004",
  payoutWallet: "<your-solana-pubkey>",
  network: "devnet",
  port: 4004,
  routes: [{ method: "GET", pattern: "/price/:symbol", price: "$0.01" }],
});

await server.listen();
```

## What's exported

- `createProxy` — boot the x402 reverse proxy
- `createFacilitator` — Solana settlement signer
- `TransactionStore` — local SQLite store for paid calls
- `computeSplitAmounts`, `callDistribute` — on-chain revenue splitter
- `signDeployMessage`, `verifyDeploySignature` — gate-deploy signature scheme
- `signAppMessage`, `verifyAppSignature` — app-manifest signature scheme
- `generateApiKey`, `hashApiKey`, `extractReferrerKeyFromHeader`, `REFERRER_KEY_HEADER` — `cg_pub_live_*` referrer keys (sent on `X-Chest-Referrer-Key`, not `Authorization`)
- `resolveReferrer` — parse and verify referrer attribution
- Session JWT helpers, route matcher, type exports

## Documentation

Full docs: https://chest.sh

## License

MIT
