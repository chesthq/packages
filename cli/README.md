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

| Command | What it does |
| --- | --- |
| `chest-gate init` | Generate `chest.config.yaml` for the current API |
| `chest-gate keypair` | Create or import the deployer wallet at `~/.chest/wallet.json` |
| `chest-gate gate` | Run the local x402 reverse proxy against your config |
| `chest-gate deploy` | Push the gate to chest.sh, sign the deploy on-chain |
| `chest-gate status` | Show recent paid calls from the local transaction store |
| `chest-gate split` | Inspect or update the on-chain revenue split (referrer cut) |
| `chest-gate app` | Publish or update an app entry in the chest.sh registry |

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

`payoutWallet` receives the merchant cut. The deployer is the local wallet at `~/.chest/wallet.json`. They can differ.

## Documentation

Full docs: https://chest.sh

## License

MIT
