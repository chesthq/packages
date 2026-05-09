import { Command } from "commander";
import chalk from "chalk";
import { createProxy } from "@chest-gate/proxy";
import { loadConfig } from "../config.js";
import { ensureKeypair } from "../keypair.js";

export const gateCommand = new Command("gate")
  .description("Start the x402 payment proxy in front of your API")
  .option("-p, --price <amount>", "Price per request in USD (e.g. 0.01)")
  .option("-w, --payout-wallet <address>", "Payout wallet, Solana address that receives USDC from paying agents")
  .option("--wrap <url>", "Upstream API URL to proxy (e.g. localhost:3000)")
  .option("--port <port>", "Port to run the proxy on. Defaults to chest.config.yaml `port:` or 4020.")
  .option(
    "--freebie <count>",
    "Number of free requests per IP before requiring payment. Defaults to chest.config.yaml `freebie:` or 0."
  )
  .option(
    "--network <network>",
    "Solana network (devnet, mainnet, or full CAIP-2). Defaults to chest.config.yaml `network:` or devnet."
  )
  .option(
    "--session <duration>",
    "Session duration after payment (seconds, or e.g. 5m, 1h; 0 to disable). Defaults to chest.config.yaml `session:` or 5m."
  )
  .option("--config <path>", "Path to chest.config.yaml")
  .option("--dashboard", "Launch local dashboard alongside proxy")
  .action(async (opts) => {
    console.log(chalk.bold("\n  ⚡ Chest Gate\n"));

    // Load config from file or flags
    const config = await loadConfig(opts);

    if (!config.wallet) {
      console.error(chalk.red("  Error: --payout-wallet is required (your Solana address to receive USDC)"));
      process.exit(1);
    }

    if (!config.upstream) {
      console.error(chalk.red("  Error: --wrap is required (upstream API URL, e.g. localhost:3000)"));
      process.exit(1);
    }

    // Ensure fee-payer keypair exists
    const feePayer = await ensureKeypair();

    // Clear config display
    console.log(chalk.white("  Config"));
    console.log(chalk.gray("  ─────────────────────────────────────────"));
    console.log(chalk.gray("  Upstream:       ") + chalk.white(config.upstream));
    console.log(chalk.gray("  Network:        ") + chalk.white(config.network));
    console.log(chalk.gray("  Price:          ") + chalk.white(`$${config.defaultPrice} per request`));
    console.log(chalk.gray("  Freebie:        ") + chalk.white(`${config.freebie} requests per IP`));
    const sessionLabel = config.session > 0 ? `${Math.round(config.session / 60)} min after payment` : "disabled";
    console.log(chalk.gray("  Session:        ") + chalk.white(sessionLabel));
    if (config.routes.length > 0) {
      console.log(chalk.gray("  Routes:         ") + chalk.white(`${config.routes.length} custom routes`));
      for (const route of config.routes) {
        const priceLabel = route.price === 0 ? "free" : `$${route.price}`;
        console.log(chalk.gray("                  ") + chalk.gray(`${route.path} → ${priceLabel}`));
      }
    }
    console.log();

    // Wallet addresses, prominent and clear
    console.log(chalk.white("  Wallets"));
    console.log(chalk.gray("  ─────────────────────────────────────────"));
    console.log(chalk.gray("  Payment wallet: ") + chalk.cyan(config.wallet));
    console.log(chalk.gray("                  ") + chalk.gray("(your wallet, payments go here)"));
    console.log(chalk.gray("  Fee payer:      ") + chalk.yellow(feePayer.address));
    console.log(chalk.gray("                  ") + chalk.gray("(pays tx fees ~$0.00025 each)"));
    console.log(chalk.gray("  Keypair:        ") + chalk.gray(feePayer.path));
    console.log();

    // Fund warning
    if (config.network.includes("devnet")) {
      console.log(chalk.yellow("  ⚠ Fund fee-payer with devnet SOL:"));
      console.log(chalk.gray(`    solana airdrop 2 ${feePayer.address} --url devnet`));
      console.log(chalk.gray(`    or visit https://faucet.solana.com`));
    } else {
      console.log(chalk.yellow("  ⚠ Fund fee-payer with SOL for transaction fees:"));
      console.log(chalk.gray(`    Send ~0.01 SOL to ${feePayer.address}`));
    }
    console.log();

    // Start the proxy
    let proxy;
    try {
      proxy = await createProxy({
        name: config.name,
        upstream: config.upstream,
        wallet: config.wallet,
        network: config.network,
        port: config.port,
        freebie: config.freebie,
        defaultPrice: config.defaultPrice,
        routes: config.routes,
        feePayerKeypair: feePayer.keypair,
        sessionDuration: config.session,
        split: config.split?.splitConfigPda ? {
          referrerBps: config.split.referrerBps,
          protocolBps: config.split.protocolBps,
          splitConfigPda: config.split.splitConfigPda,
          protocolWallet: config.split.protocolWallet!,
          merchantTokenAccount: config.split.merchantTokenAccount!,
          protocolTokenAccount: config.split.protocolTokenAccount!,
          allowUnsignedReferrers: config.split.allowUnsignedReferrers,
        } : undefined,
      });
    } catch (err) {
      console.error(chalk.red(`  Error: ${(err as Error).message}`));
      process.exit(1);
    }

    console.log(chalk.gray("  ─────────────────────────────────────────"));
    console.log(
      chalk.green("  ✓ Proxy running at ") +
      chalk.bold.white(`http://localhost:${config.port}`)
    );
    console.log(
      chalk.gray(`    → Forwarding paid requests to ${config.upstream}`)
    );
    console.log();
    console.log(chalk.gray("  Endpoints:"));
    console.log(chalk.gray(`    Health:  http://localhost:${config.port}/__chest/health`));
    console.log(chalk.gray(`    Stats:   http://localhost:${config.port}/__chest/stats`));
    console.log();
    console.log(chalk.gray("  Press Ctrl+C to stop\n"));

    // Graceful shutdown
    process.on("SIGINT", () => {
      console.log(chalk.gray("\n  Shutting down...\n"));
      proxy.close();
      process.exit(0);
    });
  });
