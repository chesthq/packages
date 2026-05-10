# @chest-gate/auth-flow

[![npm](https://img.shields.io/npm/v/@chest-gate/auth-flow.svg)](https://www.npmjs.com/package/@chest-gate/auth-flow)
[![license](https://img.shields.io/npm/l/@chest-gate/auth-flow.svg)](./LICENSE)

> PKCE loopback login flow for Chest Gate clients. Used by `chest-gate login` and `npx @chest-gate/install` to mint a per-device agent token via `chest.sh` without copy-pasting keys.

## Install

```bash
npm install @chest-gate/auth-flow
```

## Usage

```ts
import { runPkceLogin } from "@chest-gate/auth-flow";
import { hostname } from "node:os";

const { token, ownerWallet, tokenId, label } = await runPkceLogin({
  webUrl: "https://chest.sh",
  gateUrl: "https://gate.chest.sh",
  hostname: hostname(),
  onListen: ({ loginUrl }) => {
    console.log(`Visit if your browser doesn't open: ${loginUrl}`);
  },
});

// token is a `ca_live_…` agent token, the same kind paste-flow users
// mint at chest.sh/dashboard/agent-wallet. Save it however you like.
```

The flow:

1. Generate PKCE verifier + challenge + state.
2. Bind a loopback HTTP server on `127.0.0.1` (random port by default).
3. Open the user's browser to `chest.sh/cli/login?state=…&challenge=…&port=…&hostname=…`.
4. User confirms in their existing Privy session.
5. `chest.sh` redirects the browser to `http://127.0.0.1:<port>/callback?code=…&state=…`.
6. The library `POST /v1/cli/exchange { code, verifier }` and returns the minted token.

The plaintext token only crosses the wire once (in the exchange response). The verifier never leaves your process. Codes are single-use and expire in 2 minutes.

## API

```ts
function runPkceLogin(args: PkceLoginArgs): Promise<PkceLoginResult>;

interface PkceLoginArgs {
  webUrl: string;        // chest.sh base
  gateUrl: string;       // gate.chest.sh base
  hostname: string;      // appears in token label
  desiredPort?: number;  // default: random
  openBrowser?: boolean; // default: true
  onListen?: (info: { loginUrl: string; port: number }) => void;
  timeoutMs?: number;    // default: 5 * 60 * 1000
}

interface PkceLoginResult {
  token: string;         // ca_live_…
  ownerWallet: string;
  tokenId: string;
  label: string;
}
```

Throws `PkceLoginError` (with a `kind` discriminator) on any failure.

## Why this exists

Chest Gate clients used to ask the user to paste a `ca_live_…` token from `chest.sh/app/keys`. The CLI graduated to a proper browser-confirm flow last release. This package extracts that flow so the install CLI and any other client gets it for free, with the same UX the user already saw once.

## Related

- [`@chest-gate/cli`](https://www.npmjs.com/package/@chest-gate/cli) — main consumer (`chest-gate login`)
- [`@chest-gate/install`](https://www.npmjs.com/package/@chest-gate/install) — one-command app installer
- [`@chest-gate/sdk`](https://www.npmjs.com/package/@chest-gate/sdk) — `paidFetch()` for agents

## License

MIT © Chest Gate
