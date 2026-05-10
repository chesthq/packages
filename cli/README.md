# @chest-gate/cli

One command to monetise any API with x402 on Solana.

```bash
npx @chest-gate/cli init
npx @chest-gate/cli gate
npx @chest-gate/cli deploy
```

Or install globally and use the `chest-gate` binary:

```bash
npm i -g @chest-gate/cli
chest-gate --help
```

## Commands

### Setup

| Command | What it does |
| --- | --- |
| `chest-gate init` | Generate `chest.config.yaml` interactively, also creates `~/.chest/wallet.json` if missing |
| `chest-gate keypair [--show-mnemonic]` | Show or generate the deployer wallet at `~/.chest/wallet.json` |
| `chest-gate install <slug> [--force\|--upgrade]` | Install a published app (skill) into `~/.claude/skills/`. Shells out to `npx @chest-gate/install`. |
| `chest-gate upgrade [--pm npm\|pnpm\|yarn\|bun] [--check]` | Upgrade to the latest CLI from npm |

### Run & deploy

| Command | What it does |
| --- | --- |
| `chest-gate gate` | Run the local x402 reverse proxy against your config |
| `chest-gate deploy` | Push the gate to chest.sh, sign the deploy on-chain, init the splitter PDA if configured |
| `chest-gate status [--json]` | Show recent paid calls from the local SQLite store written by `gate` |

### Manage deployed gates

Re-running `chest-gate deploy` updates an existing gate in place (the server upserts on slug + deployer signature). The owner-scoped commands below all require `chest-gate login` first, the CLI token authenticates the request and the server checks that the token's wallet owns the slug.

| Command | What it does |
| --- | --- |
| `chest-gate gate list [--json]` | List gates deployed by the wallet you're logged in as |
| `chest-gate gate inspect <slug> [--json]` | Show the full owner view of a deployed gate (incl. payout wallet, full upstream, freebie) |
| `chest-gate gate logs <slug> [--limit n] [--before id] [--json]` | Recent paid calls for a gate, cursor-paginated |
| `chest-gate gate archive <slug>` | Archive a deployed gate (soft-delete; hides from listings) |
| `chest-gate gate unlist <slug> [--relist]` | Toggle the unlisted flag on a deployed gate |

### On-chain revenue split

| Command | What it does |
| --- | --- |
| `chest-gate split info --slug <slug>` | Read the on-chain `SplitConfig` PDA |
| `chest-gate split update --slug <slug> --referrer <pct>` | Update the referrer commission % (0–98.5) |

### App registry (`app.md`)

| Command | What it does |
| --- | --- |
| `chest-gate app validate [path]` | Validate an `app.md` manifest |
| `chest-gate app slug [path]` | Print the canonical `@author/name` slug (pipeable) |
| `chest-gate app publish [--dry-run]` | Publish to chest.sh, signed with `~/.chest/wallet.json` |
| `chest-gate app list [--limit n] [--offset n] [--json]` | List apps published by the wallet you're logged in as |
| `chest-gate app inspect <slug> [--json]` | Show the full owner view of a published app |
| `chest-gate app archive <slug>` | Archive a published app |
| `chest-gate app unlist <slug> [--relist]` | Toggle the unlisted flag on a published app |

### Account (CLI token)

The CLI token at `~/.chest/developer-token.json` (legacy: `credentials.json`) authenticates the owner-scoped read/manage commands above (`gate list`/`inspect`/`logs`/`archive`/`unlist`, `app list`/`inspect`/`archive`/`unlist`). It's also consumed by `@chest-gate/install` and downstream tooling. Wallet-signing commands (`deploy`, `app publish`, `split update`) still use `~/.chest/wallet.json` directly.

| Command | What it does |
| --- | --- |
| `chest-gate login [--no-browser] [--force]` | PKCE browser login, mints a CLI token |
| `chest-gate logout [--keep-remote]` | Revoke the token server-side and delete local creds |
| `chest-gate whoami [--json]` | Show the wallet and token currently signed in |

## Configure

`chest-gate init` writes a starter `chest.config.yaml`:

```yaml
name: market-data
upstream: http://localhost:8004
payoutWallet: <your-solana-pubkey>
network: devnet
port: 4004
freebie: 1
price: $0.01
session: 300
split:
  referrer: 10
```

`payoutWallet` receives the merchant cut. The deployer is the local wallet at `~/.chest/wallet.json` (the same wallet that signs `deploy`, `app publish`, `gate archive`, etc.). They can differ.

## Environment variables

| Var | Used by |
| --- | --- |
| `CHEST_SERVER` | Default API origin (default `https://gate.chest.sh`) |
| `CHEST_GATE_URL` | Default gate URL for `login`/`whoami` |
| `CHEST_WEB_URL` | Default web URL for `login` (default `https://chest.sh`) |
| `CHEST_DASHBOARD` | Dashboard origin printed in `app publish` (default `https://chest.sh`) |
| `CHEST_TOKEN` | CLI token (overrides `~/.chest/developer-token.json`) |
| `CHEST_WALLET_KEY` | Inline 64-byte JSON array of the deployer secret key (CI) |
| `CHEST_WALLET_KEY_PATH` | Path to a Solana keypair JSON file |
| `CHEST_USDC_MINT` | Override the USDC mint used by the splitter init |

## Known gaps

- `split` rotate authority, change protocol wallet, close PDA — needs Anchor program changes.

If you need any of these, please open an issue at <https://github.com/chesthq/packages/issues>.

## Documentation

Full docs: <https://chest.sh>

## License

MIT
