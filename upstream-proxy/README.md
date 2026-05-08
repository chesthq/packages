# @chest-gate/upstream-proxy

[![npm](https://img.shields.io/npm/v/@chest-gate/upstream-proxy.svg)](https://www.npmjs.com/package/@chest-gate/upstream-proxy)
[![license](https://img.shields.io/npm/l/@chest-gate/upstream-proxy.svg)](./LICENSE)

> Scaffolds a key-holding proxy for [Chest Gate](https://chest.sh). When you wrap an upstream API behind a chest gate, the publisher's API key has to live somewhere — this CLI generates a tiny self-contained Hono proxy you deploy yourself, so the key stays in your env, **never in chest.sh's infrastructure**.

```
agent ──▶ gate.chest.sh/g/<slug>/* ──▶ your proxy ──▶ upstream API
                                            │
                                  injects your auth header
```

> **Before you proxy a third-party API:** check that the provider's terms of service permit proxying access to your own end-users. Some plans require a redistribution or reseller license. This pattern works best with APIs you own, run, or are explicitly licensed to redistribute.

## Quickstart

```bash
npx @chest-gate/upstream-proxy@latest init my-api \
  --target https://api.example.com/v1 \
  --auth-header "x-api-key=\$ENV:UPSTREAM_KEY"
```

Drops a `./my-api/` directory you can deploy to Vercel as-is. Set `UPSTREAM_KEY` in your hosting env, deploy, then point a chest gate at the deployed URL.

## What the generated proxy enforces (per request)

1. **Path allowlist** — rejects requests outside the patterns you allowed.
2. **Header strip** — drops caller-supplied `authorization` / `cookie` / `x-api-key*` from the inbound request before forwarding.
3. **Auth inject** — adds exactly one upstream auth header, value sourced from `process.env`.
4. **Egress allowlist** — only the configured `--target` host is callable. SSRF-proof.
5. **Response sanitisation** — `set-cookie` and `www-authenticate` stripped from upstream responses.

## Wire it through Chest

```bash
# After deploying the generated proxy:
chest deploy --upstream https://my-api.vercel.app --slug my-api --price '$0.01'
```

Now agents pay USDC per call to `gate.chest.sh/g/my-api/*`, your proxy injects the key and forwards, and the upstream never sees the agent's wallet.

## CLI flags

| Flag | Required | Description |
|---|---|---|
| `<name>` (positional) | yes | Output directory + package name. Lowercase alphanumeric + dashes. |
| `--target <url>` | yes | Upstream API origin. |
| `--auth-header <name=value>` | yes | Header to inject. Value may use `$ENV:VARNAME` to read from env at runtime. |
| `--allow-paths <patterns>` | no | CSV path allowlist. Default `*` (everything). |
| `--strip-headers <names>` | no | CSV header names to strip from caller. Default `authorization,cookie,x-api-key`. |
| `--out <dir>` | no | Output directory. Default `./<name>`. |

## Generated proxy stack

- [Hono](https://hono.dev) on Vercel Edge — global, fast cold start
- Strict per-request allowlist + egress lock
- Zero state, zero secrets in code, zero chest.sh dependency at runtime

## Threat model

The full threat model, alternatives considered (vault tier, BYO Lambda, Cloudflare Workers), and the path to a hosted-vault tier are documented in the design notes. Want a copy? Open an issue at [chesthq/packages](https://github.com/chesthq/packages/issues).

## Related

- [`@chest-gate/sdk`](https://www.npmjs.com/package/@chest-gate/sdk) — drop-in `paidFetch()` for callers
- [`@chest-gate/mcp`](https://www.npmjs.com/package/@chest-gate/mcp) — MCP server exposing chest.sh APIs as tools
- [`chesthq/apps`](https://github.com/chesthq/apps) — example upstream APIs you can put behind a gate

## License

MIT © Chest Gate
