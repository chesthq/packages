# AGENTS.md

## Cursor Cloud specific instructions

This is an **npm workspaces monorepo** of published packages for [Chest Gate](https://chest.sh) — the x402 payment layer for APIs and AI agents on Solana. There is no running server or database; all packages are TypeScript libraries or CLI tools.

### Packages

| Package | Path | Type |
|---|---|---|
| `@chest-gate/sdk` | `sdk/` | Library (`paidFetch()`) |
| `@chest-gate/proxy` | `proxy/` | Library (x402 reverse proxy engine) |
| `@chest-gate/cli` | `cli/` | CLI binary (`chest-gate`) |
| `@chest-gate/mcp` | `mcp/` | MCP server binary (`chest-mcp`) |
| `@chest-gate/install` | `install/` | CLI binary (`chest-install`) |
| `@chest-gate/upstream-proxy` | `upstream-proxy/` | CLI scaffolder (`chest-upstream-proxy`) |
| `@chest-gate/auth-flow` | `auth-flow/` | Library (PKCE login) |

### Build order matters

`npm run build` (which runs `--workspaces --if-present`) does **not** respect inter-workspace dependency order. You must build in dependency order:

```bash
npm run build --workspace=sdk
npm run build --workspace=auth-flow
npm run build --workspace=mcp
npm run build --workspace=upstream-proxy
npm run build --workspace=proxy
npm run build --workspace=install
npm run build --workspace=cli
```

Leaf packages (sdk, auth-flow, mcp, upstream-proxy) have no intra-workspace deps and can build in any order. `proxy` depends on `sdk`. `cli` depends on `sdk`, `proxy`, and `auth-flow`. `install` depends on `auth-flow`.

### No test suite

There are currently no automated tests in any package. Validation is done via `tsc` (TypeScript compilation) and manual CLI usage.

### CI parity

CI (`.github/workflows/ci.yml`) runs `npm ci --ignore-scripts` then builds only: sdk, mcp, auth-flow, install, upstream-proxy. It does **not** build `proxy` or `cli` (proxy has a native dep `better-sqlite3` that needs build tools).

### Running CLIs locally

After building, run CLIs via node directly:
- `node cli/dist/index.js --help`
- `node mcp/dist/index.js` (starts MCP stdio server)
- `node upstream-proxy/dist/cli.js init <name> --target <url> --auth-header <header>`
- `node install/dist/index.js <slug>`

### Dev watch mode

Each package has `npm run dev --workspace=<name>` which runs `tsc --watch` (or `tsx` for mcp/install).
