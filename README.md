# packages

Public npm packages for [Chest Gate](https://chest.sh) — the x402 payment layer for APIs and AI agents on Solana.

| Package | Folder | What it does |
|---|---|---|
| [`@chest-gate/cli`](https://www.npmjs.com/package/@chest-gate/cli) | [`cli/`](./cli) | The `chest-gate` binary. One command to monetise any API with x402 (`init`, `gate`, `deploy`, `status`, `keypair`, `split`, `app`). |
| [`@chest-gate/sdk`](https://www.npmjs.com/package/@chest-gate/sdk) | [`sdk/`](./sdk) | Drop-in `paidFetch()` that pays x402 gates from any agent. Managed wallet (API key) or local keypair. |
| [`@chest-gate/proxy`](https://www.npmjs.com/package/@chest-gate/proxy) | [`proxy/`](./proxy) | x402 reverse proxy engine. Embed it to run your own paid gate, or call its lower-level signers and stores directly. |
| [`@chest-gate/mcp`](https://www.npmjs.com/package/@chest-gate/mcp) | [`mcp/`](./mcp) | MCP server exposing Chest x402-gated APIs as tools for Claude Desktop, Cursor, etc. |
| [`@chest-gate/install`](https://www.npmjs.com/package/@chest-gate/install) | [`install/`](./install) | One-command installer for Chest Gate apps (`npx -y @chest-gate/install <slug>`). |
| [`@chest-gate/upstream-proxy`](https://www.npmjs.com/package/@chest-gate/upstream-proxy) | [`upstream-proxy/`](./upstream-proxy) | Templated key-holding proxy: wrap an upstream API without exposing keys to chest gate. |

## Layout

Each top-level folder is a published package. No `packages/` wrapper.

## Develop

```bash
npm install
npm run build
```

Each package builds independently with its own `tsc`.

## Related

- [`chesthq/apps`](https://github.com/chesthq/apps) — copy-paste starter apps (skills, plugins, MCP servers, upstream APIs)
- [`smd00/chest-gate`](https://github.com/smd00/chest-gate) — the chest.sh dashboard and server

## License

MIT.
