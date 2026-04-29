# @chest-gate/upstream-proxy

Generate a key-holding proxy template for [Chest Gate](https://chest.sh).

When you wrap an upstream API behind a Chest gate, the publisher's API key has to live somewhere. This CLI generates a tiny, self-contained Hono proxy you deploy to Vercel — your key lives in your env, **never in chest's infrastructure**.

```
agent ──▶ gate.chest.sh/g/<slug>/* ──▶ your proxy ──▶ upstream API
                                            │
                                  injects your auth header
```

> **Before you proxy a third-party API:** check that the provider's terms of service permit proxying access to your own end-users. Some plans require a redistribution or reseller license; works best with APIs you own, run, or are explicitly licensed to redistribute.

## Install + run

```bash
npx @chest-gate/upstream-proxy@latest init my-api \
  --target https://api.example.com/v1 \
  --auth-header "x-api-key=\$ENV:UPSTREAM_KEY"
```

This drops a directory you can deploy to Vercel as-is.

## What the generated proxy enforces, per request

1. **Path allowlist** — rejects requests outside the patterns you allowed.
2. **Header strip** — drops caller-supplied `authorization` / `cookie` / `x-api-key*` from the inbound request before forwarding.
3. **Auth inject** — adds exactly one upstream auth header, value sourced from `process.env`.
4. **Egress allowlist** — only the configured `--target` host is callable. SSRF-proof.
5. **Response sanitisation** — `set-cookie` and `www-authenticate` stripped from upstream responses.

## Wire it through Chest

```bash
# After deploying the proxy:
chest deploy --upstream https://my-api.vercel.app --slug my-api --price '$0.01'
```

Now agents pay USDC per call to `gate.chest.sh/g/my-api/*`, your proxy injects the key and forwards, and the upstream never sees the agent's wallet.

## CLI flags

| Flag | Required | Description |
|---|---|---|
| `<name>` (positional) | yes | Output directory + package name. Lowercase alphanumeric + dashes. |
| `--target <url>` | yes | Upstream API origin. |
| `--auth-header <name=value>` | yes | Header to inject. Value may use `$ENV:VARNAME` to read from env. |
| `--allow-paths <patterns>` | no | CSV path allowlist. Default `*` (everything). |
| `--strip-headers <names>` | no | CSV header names to strip from caller. Default `authorization,cookie,x-api-key`. |
| `--out <dir>` | no | Output directory. Default `./<name>`. |

## Threat model + architectural rationale

See [`scope-upstream-proxy.md`](https://github.com/smd00/chest-gate/blob/main/docs/chest-gate/scope-upstream-proxy.md) for the full threat model, alternatives considered, and phasing toward a hosted vault tier.

## License

MIT.
