# @chest-gate/mcp

[![npm](https://img.shields.io/npm/v/@chest-gate/mcp.svg)](https://www.npmjs.com/package/@chest-gate/mcp)
[![license](https://img.shields.io/npm/l/@chest-gate/mcp.svg)](./LICENSE)

> [Model Context Protocol](https://modelcontextprotocol.io) server that exposes [Chest](https://chest.sh) x402-gated APIs as tools to any MCP-capable agent (Claude Desktop, Cursor, Continue, etc.). Every paid call earns the configured `REFERRER_WALLET` an on-chain commission via the `chest_splitter` Solana program.

## Install

Run directly with `npx` — no global install needed.

```bash
npx -y @chest-gate/mcp
```

## Quickstart (Claude Desktop)

Add to `~/.config/claude/claude_desktop_config.json` (or the equivalent on Windows / macOS):

```json
{
  "mcpServers": {
    "chest": {
      "command": "npx",
      "args": ["-y", "@chest-gate/mcp"],
      "env": {
        "CHEST_API_KEY": "cg_live_...",
        "AGENT_WALLET_PRIVATE_KEY": "[1,2,3,...]"
      }
    }
  }
}
```

Mint a `CHEST_API_KEY` at [chest.sh/dashboard/keys](https://chest.sh/dashboard/keys) — your payout wallet is bound at key creation. Rotate by revoking and minting a new one.

Restart Claude. The four tools below appear automatically.

## Single-gate mode (`CHEST_SLUG`)

Set `CHEST_SLUG` to lock the MCP to one gate — matches the per-gate install snippet on chest.sh:

```json
"env": {
  "CHEST_API_KEY": "cg_live_...",
  "CHEST_SLUG":    "sentiment-api"
}
```

When set:
- `discover_apis` returns only that one gate.
- `call_api` defaults the `api` argument to `CHEST_SLUG`; passing a different slug errors.
- `analyze_token` is hidden (it fans out to specific slugs not in scope).

## Tools

| Tool | What it does |
|---|---|
| `discover_apis` | List every Chest-gated API (or just one in single-gate mode) with pricing, endpoints, category, and on-chain metadata (`network`, `referrerBps`, `protocolBps`, `splitConfigPda`, `allowUnsignedReferrers`, `verified`). Filter by category (`trading`, `ai`, `data`, `content`, `utility`). |
| `get_api_info` | Detail for one API including the discovery doc fetched live from the gate. |
| `call_api` | Make a GET/POST against a registered API. Pays via x402 on Solana automatically and attaches referrer attribution (Bearer key or ed25519 signature). |
| `analyze_token` | Convenience wrapper: parallel sentiment + technicals + liquidations for a token (~$0.011). Pass `deep: true` for funding rates, IV, and unlocks. *Hidden when `CHEST_SLUG` is set.* |
| `list_apps` | Browse installable Chest apps — skills, plugins, and MCP servers — that wrap one or more gates. Filter by `kind` and `verified`; page with `limit` / `offset`. |
| `get_app` | Full detail for one app, including its README and install snippets (`claudeCode`, `codex`, `cursor`, `mcpConfig`, `prompt`). |

## Environment

Two referrer-attribution modes. **Use `CHEST_API_KEY` unless you specifically want self-custodial signing** — it's simpler, the payout wallet is bound at key-mint time on the dashboard, and rotation is one click.

| Var | Required | Purpose |
|---|---|---|
| `CHEST_API_KEY` | recommended | Bearer key (`cg_live_...` / `cg_test_...`) minted at [chest.sh/dashboard/keys](https://chest.sh/dashboard/keys). Carries referrer attribution; payout wallet was committed at key creation. When set, `REFERRER_WALLET` and `REFERRER_PAYOUT_WALLET` are ignored. |
| `AGENT_WALLET_PRIVATE_KEY` | required for paid calls | Solana secret key paying x402 challenges. JSON array `[1,2,3,...]` or base64. Without it, only free endpoints work. |
| `CHEST_SLUG` | optional | Lock the MCP to a single gate. See [Single-gate mode](#single-gate-mode-chest_slug). |
| `CHEST_GATE_BASE_URL` | optional | Override the gate base. Defaults to `https://gate.chest.sh`. Each API resolves to `{base}/g/{slug}`. |
| `{SLUG}_GATE_URL` | optional | Per-API URL override (e.g. `SENTIMENT_GATE_URL`). Useful for local dev against a self-hosted gate. |

### Advanced: self-custodial referrer signing

If you'd rather not trust a server-side key store, drop `CHEST_API_KEY` and use these instead. The MCP signs an ed25519 claim per call; the server's `chest_splitter` program verifies it on-chain.

| Var | Required | Purpose |
|---|---|---|
| `REFERRER_WALLET` | when `CHEST_API_KEY` unset | Hot wallet pubkey that signs the referral claim. |
| `REFERRER_PAYOUT_WALLET` | optional | Cold wallet to receive the commission. Set this to separate signing risk from funds — a compromised hot key can't redirect commission. |

`REFERRER_WALLET` only proves ownership — it signs a canonical message containing the API slug, payment amount, and a 60-second time window. `REFERRER_PAYOUT_WALLET` commits the signed claim to a different wallet for payout.

Recommended setup:
- `REFERRER_WALLET` → hot key on the machine running the MCP server
- `REFERRER_PAYOUT_WALLET` → hardware wallet, never leaves cold storage

## Generate keys

```bash
solana-keygen new --outfile agent.json
export AGENT_WALLET_PRIVATE_KEY="$(cat agent.json)"
```

## Related

- [`@chest-gate/sdk`](https://www.npmjs.com/package/@chest-gate/sdk) — the underlying `paidFetch()` primitive
- [`@chest-gate/install`](https://www.npmjs.com/package/@chest-gate/install) — one-command installer for Chest Gate skills
- [`chesthq/apps`](https://github.com/chesthq/apps) — copy-paste skills, MCP servers, and upstream APIs
- [chest.sh dashboard](https://chest.sh) — mint API keys, configure payout wallet

## License

MIT © Chest Gate
