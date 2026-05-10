import { Command } from "commander";
import chalk from "chalk";
import { createProxy } from "@chest-gate/proxy";
import { loadConfig } from "../config.js";
import { ensureKeypair } from "../keypair.js";
import { runManageAction } from "../manage.js";
import { api, ApiError, NotLoggedInError } from "../api.js";
import { printKeyValues } from "../format.js";

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
  .action(async (opts) => {
    console.log(chalk.bold("\n  ⚡ Chest Gate\n"));

    // Load config from file or flags
    const config = await loadConfig(opts);

    if (!config.wallet) {
      console.error(chalk.red("  Error: --payout-wallet is required (your Solana address to receive USDC)"));
      process.exit(1);
    }

    if (config.wallet === "YOUR_SOLANA_WALLET_ADDRESS") {
      console.error(chalk.red("  Error: payoutWallet is still the placeholder 'YOUR_SOLANA_WALLET_ADDRESS'."));
      console.error(chalk.gray("  Edit chest.config.yaml and set it to your Solana address, or pass --payout-wallet."));
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

gateCommand
  .command("archive")
  .description("Archive a deployed gate (soft-delete; hides from listings).")
  .argument("<slug>", "Gate slug to archive")
  .option("--server <url>", "chest.sh API origin")
  .action(async (slug: string, opts: { server?: string }) => {
    console.log(chalk.bold("\n  ⚡ Chest Gate Archive\n"));
    await runManageAction({ kind: "gate", op: "archive", slug, server: opts.server });
  });

gateCommand
  .command("unlist")
  .description("Toggle the unlisted flag on a deployed gate (use --relist to undo).")
  .argument("<slug>", "Gate slug")
  .option("--relist", "Re-list (clears the unlisted flag)")
  .option("--server <url>", "chest.sh API origin")
  .action(
    async (slug: string, opts: { relist?: boolean; server?: string }) => {
      console.log(chalk.bold("\n  ⚡ Chest Gate Unlist\n"));
      await runManageAction({
        kind: "gate",
        op: "unlist",
        slug,
        server: opts.server,
        unlisted: !opts.relist,
      });
    },
  );

// ── Owner-scoped queries (require `chest-gate login`) ────────────────────

interface GateOwnerView {
  slug: string;
  upstream: string;
  wallet: string;
  deployer: string;
  network: string;
  defaultPrice?: number;
  freebie: number;
  unlisted?: boolean;
  archivedAt?: string | null;
  createdAt?: string;
  endpointCount?: number;
}

gateCommand
  .command("list")
  .description("List gates deployed by the wallet you're logged in as.")
  .option("--server <url>", "chest.sh API origin")
  .option("--json", "Emit machine-readable JSON")
  .action(async (opts: { server?: string; json?: boolean }) => {
    try {
      const result = await api<{ deployments: GateOwnerView[] }>("/api/my-gates", {
        server: opts.server,
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify(result) + "\n");
        return;
      }
      console.log(chalk.bold("\n  ⚡ Your Gates\n"));
      if (result.deployments.length === 0) {
        console.log(chalk.gray("  No gates deployed by this wallet yet.\n"));
        return;
      }
      for (const g of result.deployments) {
        const tags = [
          g.archivedAt ? chalk.red("archived") : null,
          g.unlisted ? chalk.yellow("unlisted") : null,
        ].filter(Boolean).join(" ");
        console.log(chalk.cyan("  " + g.slug) + (tags ? "  " + tags : ""));
        console.log(chalk.gray("    upstream: ") + chalk.white(g.upstream));
        console.log(chalk.gray("    network:  ") + chalk.white(g.network));
        if (typeof g.defaultPrice === "number") {
          console.log(chalk.gray("    price:    ") + chalk.white(`$${g.defaultPrice.toFixed(6)}`));
        }
        console.log();
      }
    } catch (err) {
      handleApiError(err);
      process.exit(1);
    }
  });

gateCommand
  .command("inspect")
  .description("Show the full owner view of a deployed gate.")
  .argument("<slug>", "Gate slug")
  .option("--server <url>", "chest.sh API origin")
  .option("--json", "Emit machine-readable JSON")
  .action(async (slug: string, opts: { server?: string; json?: boolean }) => {
    try {
      const gate = await api<GateOwnerView & Record<string, unknown>>(
        `/api/my-gates/${encodeURIComponent(slug.toLowerCase())}`,
        { server: opts.server },
      );
      if (opts.json) {
        process.stdout.write(JSON.stringify(gate) + "\n");
        return;
      }
      console.log(chalk.bold(`\n  ⚡ Gate: ${gate.slug}\n`));
      printKeyValues(gate);
      console.log();
    } catch (err) {
      handleApiError(err, slug);
      process.exit(1);
    }
  });

interface GateLogRow {
  id: number;
  slug: string;
  txSignature: string | null;
  payerWallet: string | null;
  route: string | null;
  amountUsdc: number | null;
  state: string;
  createdAt: string;
  settledAt: string | null;
}

gateCommand
  .command("logs")
  .description("Show recent paid calls for a deployed gate (you must own it).")
  .argument("<slug>", "Gate slug")
  .option("--limit <n>", "Rows per page (max 200)", "50")
  .option("--before <id>", "Cursor (transaction id) for older rows")
  .option("--server <url>", "chest.sh API origin")
  .option("--json", "Emit machine-readable JSON")
  .action(
    async (
      slug: string,
      opts: { limit: string; before?: string; server?: string; json?: boolean },
    ) => {
      const qs = new URLSearchParams();
      qs.set("limit", opts.limit);
      if (opts.before) qs.set("before", opts.before);
      const path = `/api/my-gates/${encodeURIComponent(slug.toLowerCase())}/logs?${qs}`;
      try {
        const result = await api<{
          slug: string;
          transactions: GateLogRow[];
          nextCursor: number | null;
        }>(path, { server: opts.server });
        if (opts.json) {
          process.stdout.write(JSON.stringify(result) + "\n");
          return;
        }
        console.log(chalk.bold(`\n  ⚡ Logs for ${result.slug}\n`));
        if (result.transactions.length === 0) {
          console.log(chalk.gray("  No transactions yet.\n"));
          return;
        }
        for (const t of result.transactions) {
          const amount = t.amountUsdc != null ? `$${t.amountUsdc.toFixed(6)}` : "—";
          const stateColor =
            t.state === "settled" ? chalk.green : t.state === "failed" ? chalk.red : chalk.yellow;
          console.log(
            chalk.gray("  ") +
              chalk.white(t.createdAt.padEnd(25)) +
              stateColor(t.state.padEnd(10)) +
              chalk.cyan(amount.padEnd(12)) +
              chalk.white(t.route ?? "—"),
          );
          if (t.payerWallet) console.log(chalk.gray("    payer: ") + chalk.gray(t.payerWallet));
          if (t.txSignature) console.log(chalk.gray("    tx:    ") + chalk.gray(t.txSignature));
        }
        if (result.nextCursor) {
          console.log();
          console.log(chalk.gray(`  Older rows: --before ${result.nextCursor}`));
        }
        console.log();
      } catch (err) {
        handleApiError(err, slug);
        process.exit(1);
      }
    },
  );

function handleApiError(err: unknown, slug?: string): void {
  if (err instanceof NotLoggedInError) {
    console.error(chalk.red(`  Error: ${err.message}`));
    return;
  }
  if (err instanceof ApiError) {
    console.error(chalk.red(`  Error ${err.status}: ${err.message}`));
    if (err.status === 401) {
      console.error(chalk.gray("  Re-run `chest-gate login` to mint a fresh token."));
    } else if (err.status === 403 && slug) {
      console.error(
        chalk.gray(`  Your wallet doesn't own slug "${slug}". Log in with the deployer wallet.`),
      );
    } else if (err.status === 404 && slug) {
      console.error(chalk.gray(`  Slug "${slug}" not found.`));
    }
    return;
  }
  console.error(chalk.red(`  Error: ${(err as Error).message}`));
}
