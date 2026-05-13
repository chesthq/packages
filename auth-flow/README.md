# @chest-gate/auth-flow

[![npm](https://img.shields.io/npm/v/@chest-gate/auth-flow.svg)](https://www.npmjs.com/package/@chest-gate/auth-flow)
[![license](https://img.shields.io/npm/l/@chest-gate/auth-flow.svg)](./LICENSE)

> OAuth 2.0 Device Authorization Grant (RFC 8628) login flow for Chest Gate clients. Used by `chest-gate login` and `npx @chest-gate/install` to mint a per-device agent token via `chest.sh` without copy-pasting keys.

## Install

```bash
npm install @chest-gate/auth-flow
```

## Usage

```ts
import { runDeviceGrant } from "@chest-gate/auth-flow";
import { hostname } from "node:os";

const { token, ownerWallet, tokenId, label } = await runDeviceGrant({
  gateUrl: "https://gate.chest.sh",
  hostname: hostname(),
  onCodeIssued: ({ userCode, verificationUriComplete }) => {
    console.log(`Code: ${userCode}`);
    console.log(`Visit: ${verificationUriComplete}`);
  },
});

// token is a `ca_live_…` agent token, the same kind paste-flow users
// mint at chest.sh/dashboard/agent-wallet. Save it however you like.
```

The flow:

1. `POST /v1/cli/device/code` to request a short user code and a device code.
2. Print the user code and `chest.sh/device` URL (and optionally open the browser).
3. User signs in via their existing Privy session and approves the device.
4. The library polls `POST /v1/cli/device/token` with the device code until the user approves (or it expires).
5. On approval, the server returns the minted `ca_live_…` token.

The plaintext token only crosses the wire once (in the final token response). The device code never leaves your process. User codes are single-use and expire in a few minutes.

Replaces the previous PKCE loopback flow. The device grant works under SSH, Docker, CI, and any environment without a usable `127.0.0.1` — there's no local HTTP server, no port to bind, and no browser redirect target.

## API

```ts
function runDeviceGrant(args: DeviceGrantArgs): Promise<DeviceGrantResult>;

interface DeviceGrantArgs {
  gateUrl: string;       // gate.chest.sh base
  hostname: string;      // appears in token label
  openBrowser?: boolean; // default: true
  onCodeIssued?: (info: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresInSec: number;
  }) => void;
  timeoutMs?: number;    // default: 5 * 60 * 1000
}

interface DeviceGrantResult {
  token: string;         // ca_live_…
  ownerWallet: string;
  tokenId: string;
  label: string;
}
```

Throws `DeviceGrantError` (with a `kind` discriminator) on any failure.

## Why this exists

Chest Gate clients used to ask the user to paste a `ca_live_…` token from `chest.sh/app/keys`. The CLI graduated to a proper browser-confirm flow, and now uses the device grant so it works the same on every machine — desktop, SSH, Docker, CI. This package extracts that flow so the install CLI and any other client gets it for free, with the same UX the user already saw once.

## Related

- [`@chest-gate/cli`](https://www.npmjs.com/package/@chest-gate/cli) — main consumer (`chest-gate login`)
- [`@chest-gate/install`](https://www.npmjs.com/package/@chest-gate/install) — one-command app installer
- [`@chest-gate/sdk`](https://www.npmjs.com/package/@chest-gate/sdk) — `paidFetch()` for agents

## License

MIT © Chest Gate
