import { Command } from "commander";
import chalk from "chalk";
import { readFile } from "node:fs/promises";
import { Keypair } from "@solana/web3.js";
import { signDeployMessage } from "@chest-gate/proxy";
import { loadConfig, normalizeNetwork } from "../config.js";
import { ensureKeypair } from "../keypair.js";
import { initializeSplit } from "../splitter-init.js";

/**
 * Load the deployer wallet's secret key bytes. Required to sign the deploy
 * request, proves control of the deployer wallet (which owns the slug).
 *
 * The deployer can be different from the payout wallet: teams often sign with
 * a hot operational key but route revenue to a cold treasury.
 *
 * Priority:
 *   1. --wallet-key <path>, path to Solana keypair JSON (array of 64 bytes)
 *   2. CHEST_WALLET_KEY env, inline JSON array of 64 bytes
 *   3. CHEST_WALLET_KEY_PATH, path to keypair JSON (env fallback)
 */
/**
 * Resolve the deployer secret key, in priority order:
 *   1. CHEST_WALLET_KEY env (inline 64-byte JSON array, for CI)
 *   2. --wallet-key <path> or CHEST_WALLET_KEY_PATH (raw Solana keypair JSON)
 *   3. ~/.chest/wallet.json, the local wallet auto-created by `chest init`,
 *      `chest gate`, or `chest keypair`. This is what most users will hit.
 */
async function loadDeployerSecretKey(optsPath?: string): Promise<Uint8Array> {
  const inline = process.env.CHEST_WALLET_KEY;
  if (inline) {
    try {
      return new Uint8Array(JSON.parse(inline));
    } catch {
      throw new Error("CHEST_WALLET_KEY must be a JSON array of 64 bytes");
    }
  }

  const path = optsPath || process.env.CHEST_WALLET_KEY_PATH;
  if (path) {
    const raw = await readFile(path.replace(/^~/, process.env.HOME || ""), "utf-8");
    return new Uint8Array(JSON.parse(raw));
  }

  // Default: fall back to the local wallet at ~/.chest/wallet.json. This is
  // the wallet `chest init`, `chest gate`, and `chest keypair` already use.
  // ensureKeypair() returns the raw 64-byte secret key regardless of whether
  // the on-disk format is a flat array or the BIP-39-wrapped object.
  const local = await ensureKeypair();
  return local.keypair;
}

/**
 * Derive the slug the same way the server does when requestedSlug is omitted.
 * Must stay byte-identical with packages/server/src/index.ts so the signature
 * over `slug` matches the server's slug derivation.
 */
function deriveSlug(requestedSlug: string | undefined, upstream: string): string {
  const slug = requestedSlug || upstream
    .replace(/https?:\/\//, "")
    .replace(/[^a-z0-9]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 32);
  return slug.toLowerCase();
}

const DEFAULT_SERVER = process.env.CHEST_SERVER || "https://gate.chest.sh";

// Default devnet USDC mint, override with CHEST_USDC_MINT env var
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function getUsdcMint(network: string): string {
  if (process.env.CHEST_USDC_MINT) return process.env.CHEST_USDC_MINT;
  if (network.includes("mainnet")) return MAINNET_USDC_MINT;
  return DEVNET_USDC_MINT;
}

export const deployCommand = new Command("deploy")
  .description("Deploy your x402 proxy to Chest cloud, get a live URL")
  .option("--upstream <url>", "Your production API URL (e.g. https://myapi.vercel.app)")
  .option("-p, --price <amount>", "Price per request in USD (e.g. 0.01)")
  .option("-w, --payout-wallet <address>", "Payout wallet address, receives USDC from paying agents")
  .option(
    "--deployer <address>",
    "Deployer wallet address, signs deploy requests and owns the slug. Defaults to --payout-wallet."
  )
  .option(
    "--wallet-key <path>",
    "Path to Solana keypair JSON for the deployer wallet (used to sign deploys). " +
    "Fallback: CHEST_WALLET_KEY_PATH env or CHEST_WALLET_KEY inline JSON array."
  )
  .option(
    "--freebie <count>",
    "Number of free requests per IP before requiring payment. Defaults to chest.config.yaml `freebie:` or 0."
  )
  .option(
    "--network <network>",
    "Solana network (devnet, mainnet). Defaults to chest.config.yaml `network:` or devnet."
  )
  .option("--slug <slug>", "Custom slug for your URL (auto-generated if omitted)")
  .option(
    "--session <duration>",
    "Session duration after payment (seconds, or e.g. 5m, 1h). Defaults to chest.config.yaml `session:` or 5m."
  )
  .option("--server <url>", "Chest cloud server URL", DEFAULT_SERVER)
  .option("--config <path>", "Path to chest.config.yaml")
  .action(async (opts) => {
    console.log(chalk.bold("\n  ⚡ Chest Deploy\n"));

    // Try loading from config file. Pass --session through so the YAML value
    // wins when the flag wasn't explicitly overridden (commander always
    // populates the default, so we can't distinguish "user typed --session
    // 300" from "user passed nothing"; the YAML value should win in that case).
    const config = await loadConfig({
      wrap: opts.upstream,
      wallet: opts.payoutWallet,
      price: opts.price,
      freebie: opts.freebie,
      network: opts.network,
      session: opts.session,
      config: opts.config,
    });

    const upstream = opts.upstream || config.upstream;
    const wallet = opts.payoutWallet || config.wallet;
    const price = opts.price || String(config.defaultPrice);
    const network = normalizeNetwork(opts.network || config.network || "devnet");

    if (!upstream) {
      console.error(chalk.red("  Error: --upstream is required (your production API URL)"));
      process.exit(1);
    }

    if (!wallet) {
      console.error(chalk.red("  Error: --payout-wallet is required (your Solana wallet address)"));
      process.exit(1);
    }

    if (wallet === "YOUR_SOLANA_WALLET_ADDRESS") {
      console.error(chalk.red("  Error: payoutWallet is still the placeholder 'YOUR_SOLANA_WALLET_ADDRESS'."));
      console.error(chalk.gray("  Edit chest.config.yaml and set it to your Solana address, or pass --payout-wallet."));
      process.exit(1);
    }

    const server = opts.server;

    console.log(chalk.gray("  Deploying to Chest cloud...\n"));
    console.log(chalk.gray("  Upstream:  ") + chalk.white(upstream));
    console.log(chalk.gray("  Price:     ") + chalk.white(`$${price} per request`));
    console.log(chalk.gray("  Wallet:    ") + chalk.cyan(wallet));
    console.log(chalk.gray("  Network:   ") + chalk.white(network));
    console.log(chalk.gray("  Freebie:   ") + chalk.white(`${config.freebie} per IP`));
    console.log(chalk.gray("  Server:    ") + chalk.gray(server));

    // If split config is present, initialize the on-chain split program
    let splitFields: Record<string, string | number> = {};

    if (config.split) {
      console.log();
      console.log(chalk.gray("  Split enabled, initialising on-chain revenue share...\n"));
      console.log(
        chalk.gray("  Referrer commission: ") +
          chalk.white(`${config.split.referrerBps / 100}%`)
      );
      console.log(
        chalk.gray("  Protocol fee:        ") +
          chalk.white(`${config.split.protocolBps / 100}%`)
      );

      let feePayer;
      try {
        feePayer = await ensureKeypair();
      } catch (err) {
        console.error(chalk.red(`\n  Error loading fee-payer keypair: ${(err as Error).message}`));
        process.exit(1);
      }

      const slug =
        opts.slug ||
        upstream
          .replace(/https?:\/\//, "")
          .replace(/[^a-z0-9]/gi, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .substring(0, 32);

      const usdcMint = getUsdcMint(network);
      console.log(chalk.gray(`\n  Fee payer: `) + chalk.cyan(feePayer.address));
      console.log(chalk.gray(`  USDC mint: `) + chalk.gray(usdcMint));
      console.log(chalk.gray(`  Slug:      `) + chalk.white(slug));
      console.log();
      console.log(chalk.gray("  Sending initialize_split transaction..."));

      try {
        const splitResult = await initializeSplit({
          feePayerKeypair: feePayer.keypair,
          merchantWallet: wallet,
          usdcMintAddress: usdcMint,
          slug,
          referrerBps: config.split.referrerBps,
          network,
        });

        console.log(chalk.green("  ✓ Split initialised on-chain"));
        console.log(
          chalk.gray("    Split config PDA: ") +
            chalk.cyan(splitResult.splitConfigPda)
        );
        console.log(
          chalk.gray("    Vault PDA:        ") +
            chalk.cyan(splitResult.vaultPda)
        );
        console.log(
          chalk.gray("    Tx:               ") +
            chalk.gray(splitResult.txSignature)
        );

        splitFields = {
          vaultPda: splitResult.vaultPda,
          splitConfigPda: splitResult.splitConfigPda,
          merchantTokenAccount: splitResult.merchantTokenAccount,
          protocolTokenAccount: splitResult.protocolTokenAccount,
          referrerBps: config.split.referrerBps,
          protocolBps: config.split.protocolBps,
        };
      } catch (err) {
        console.error(
          chalk.red(`\n  Error initialising split: ${(err as Error).message}`)
        );
        process.exit(1);
      }
    }

    console.log();

    // Sign the deploy payload with the deployer wallet's secret key. The server
    // verifies this signature to prove the caller controls the deployer wallet,
    // and ties slug ownership to it.
    let deployerSecret: Uint8Array;
    try {
      deployerSecret = await loadDeployerSecretKey(opts.walletKey);
    } catch (err) {
      console.error(chalk.red(`  Error: ${(err as Error).message}`));
      process.exit(1);
    }

    // Derive deployer pubkey from the loaded secret key.
    const deployerFromKey = Keypair.fromSecretKey(deployerSecret).publicKey.toBase58();

    // If --deployer was supplied, it must match the loaded key.
    const deployer = opts.deployer || deployerFromKey;
    if (deployer !== deployerFromKey) {
      console.error(chalk.red(
        `  Error: --deployer (${deployer}) doesn't match the loaded keypair (${deployerFromKey}).`
      ));
      console.error(chalk.gray("  The signer must be the deployer. Either omit --deployer or load the matching keypair."));
      process.exit(1);
    }

    if (deployer !== wallet) {
      console.log(chalk.gray("  Deployer: ") + chalk.cyan(deployer) + chalk.gray(" (signer + slug owner)"));
      console.log(chalk.gray("  Payout:   ") + chalk.cyan(wallet) + chalk.gray(" (receives USDC)"));
    }

    const slug = deriveSlug(opts.slug, upstream);
    const priceMicros = Math.round(parseFloat(price) * 1_000_000);

    // Carry per-route price overrides (chest.config.yaml `routes:`) into the
    // signed deploy as v2. Empty list → v1 message format unchanged.
    const routePrices =
      config.routes && config.routes.length > 0
        ? config.routes.map((r) => ({
            path: r.path,
            priceMicros: Math.round(r.price * 1_000_000),
          }))
        : undefined;

    const deploySig = signDeployMessage(
      { deployer, payoutWallet: wallet, slug, upstream, priceMicros, network, routePrices },
      deployerSecret
    );

    try {
      const response = await fetch(`${server}/api/gates`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Deploy-Sig": deploySig,
        },
        body: JSON.stringify({
          upstream,
          wallet,
          deployer,
          slug,
          price,
          freebie: config.freebie,
          network,
          sessionDuration: config.session,
          routePrices,
          ...splitFields,
        }),
      });

      if (response.status === 401) {
        const errBody = await response.json() as any;
        console.error(chalk.red(`  Error: ${errBody.error || "Unauthorized"}`));
        if (errBody.hint) console.error(chalk.gray(`  ${errBody.hint}`));
        process.exit(1);
      }

      if (response.status === 403) {
        const errBody = await response.json() as any;
        console.error(chalk.red(`  Error: ${errBody.error || "Forbidden"}`));
        if (errBody.ownedBy) console.error(chalk.gray(`  Slug "${errBody.slug}" is owned by ${errBody.ownedBy}`));
        process.exit(1);
      }

      if (!response.ok) {
        const errBody = await response.json() as any;
        console.error(chalk.red(`  Error: ${errBody.error || response.statusText}`));
        process.exit(1);
      }

      const result = await response.json() as any;

      console.log(chalk.green("  ✓ Deployed!\n"));
      console.log(chalk.gray("  ─────────────────────────────────────────"));
      console.log(chalk.gray("  Live URL:  ") + chalk.bold.cyan(result.url));
      console.log(chalk.gray("  Slug:      ") + chalk.white(result.slug));
      console.log(chalk.gray("  Upstream:  ") + chalk.white(result.upstream));
      console.log(chalk.gray("  Price:     ") + chalk.white(`$${result.price}`));
      console.log(chalk.gray("  ─────────────────────────────────────────\n"));
      console.log(chalk.gray("  Agents can now pay and access your API at:"));
      console.log(chalk.white(`  ${result.url}\n`));

      if (config.split) {
        console.log(chalk.gray("  Agents earn commission by sending X-Referrer-Wallet header."));
        console.log(chalk.gray("  Commission rates visible at:"));
        console.log(chalk.white(`  ${result.url}.well-known/chest.json\n`));
      }

      console.log(chalk.gray("  View stats:"));
      console.log(chalk.gray(`  ${server}/api/gates/${result.slug}/stats\n`));
    } catch (err) {
      console.error(chalk.red(`  Error: Could not connect to ${server}`));
      console.error(chalk.gray(`  ${(err as Error).message}\n`));
      console.log(chalk.gray("  Is the Chest cloud server running? For local testing:"));
      console.log(chalk.gray("  cd packages/server && npm run dev\n"));
      process.exit(1);
    }
  });
