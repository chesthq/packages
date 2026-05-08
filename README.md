# packages

Public npm packages for [Chest Gate](https://chest.sh) — the x402 payment layer for APIs and AI agents on Solana.

| Package | Folder | What it does |
|---|---|---|
| [`@chest-gate/sdk`](https://www.npmjs.com/package/@chest-gate/sdk) | [`sdk/`](./sdk) | Drop-in `paidFetch()` that pays x402 gates from any agent. Managed wallet (API key) or local keypair. |
| [`@chest-gate/mcp`](https://www.npmjs.com/package/@chest-gate/mcp) | [`mcp/`](./mcp) | MCP server exposing Chest x402-gated APIs as tools for Claude Desktop, Cursor, etc. |
| [`@chest-gate/install`](https://www.npmjs.com/package/@chest-gate/install) | [`install/`](./install) | One-command installer for Chest Gate skills (`npx -y @chest-gate/install <slug>`). |
| [`@chest-gate/upstream-proxy`](https://www.npmjs.com/package/@chest-gate/upstream-proxy) | [`upstream-proxy/`](./upstream-proxy) | Run your own x402 gate locally; forwards to an upstream API and settles USDC payments. |

## Layout

Each top-level folder is a published package. No `packages/` wrapper.

## Develop

```bash
npm install
npm run build
```

Each package builds independently with its own `tsc`.

## Release

Tag-triggered, one tag → one package. Bump `version` in the package's own `package.json`, merge to `main`, then push a matching tag from `main`:

```bash
# example: shipping @chest-gate/sdk 0.2.2
git tag sdk-v0.2.2 && git push origin sdk-v0.2.2
```

Tag patterns: `sdk-v*`, `mcp-v*`, `install-v*`, `upstream-proxy-v*`. The publish workflow refuses if the tag version doesn't match `<folder>/package.json`.

Manual fallback (skip CI):

```bash
npm run release:sdk             # @chest-gate/sdk
npm run release:mcp             # @chest-gate/mcp
npm run release:install         # @chest-gate/install
npm run release:upstream-proxy  # @chest-gate/upstream-proxy
```

## Related

- [`chesthq/apps`](https://github.com/chesthq/apps) — copy-paste starter apps (skills, plugins, MCP servers, upstream APIs)
- [`smd00/chest-gate`](https://github.com/smd00/chest-gate) — the chest.sh dashboard, server, and proxy

## License

MIT.
