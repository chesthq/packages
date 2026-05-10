import { Command } from "commander";
import chalk from "chalk";
import pkg from "@coral-xyz/anchor";
const { AnchorProvider, Program, Wallet, setProvider } = pkg;
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ensureKeypair } from "../keypair.js";
import { RPC_URLS } from "../splitter-init.js";
import { api, ApiError, NotLoggedInError } from "../api.js";
import idl from "../chest_splitter_idl.json" with { type: "json" };

const PROGRAM_ID = new PublicKey("9a6zrqau5xVEdxNqBUfL2G18WuryQbWeJScPAUHZvmmX");
const MAX_REFERRER_BPS = 9850;

interface GateMeta {
  slug: string;
  network: string;
  splitConfigPda?: string | null;
  deployer: string;
}

/**
 * Resolve the canonical splitConfigPda + network for a slug by asking the
 * server. The PDA can't reliably be re-derived locally because the seed
 * authority is whatever wallet was used at `chest-gate deploy` time, which
 * isn't necessarily the local `~/.chest/wallet.json`.
 *
 * `--pda` shortcuts this lookup for users who already know the address
 * (and lets `split info` work without `chest-gate login`).
 */
async function resolveGateMeta(opts: {
  slug?: string;
  pda?: string;
  network?: string;
  server?: string;
}): Promise<{ pda: PublicKey; network: string }> {
  if (opts.pda) {
    return {
      pda: new PublicKey(opts.pda),
      network: normalizeNetwork(opts.network ?? "solana-devnet"),
    };
  }

  if (!opts.slug) {
    throw new Error("Pass --slug <slug> (or --pda <address> if you already know it).");
  }

  const gate = await api<GateMeta>(`/api/my-gates/${encodeURIComponent(opts.slug.toLowerCase())}`, {
    server: opts.server,
  });

  if (!gate.splitConfigPda) {
    throw new Error(
      `Gate "${opts.slug}" has no on-chain split config. Re-deploy with a \`split:\` block in chest.config.yaml.`,
    );
  }

  return {
    pda: new PublicKey(gate.splitConfigPda),
    network: normalizeNetwork(opts.network ?? gate.network),
  };
}

function normalizeNetwork(net: string): string {
  const n = net.toLowerCase().trim();
  if (n === "devnet" || n === "dev") return "solana-devnet";
  if (n === "mainnet" || n === "main" || n === "mainnet-beta") return "solana-mainnet";
  return n;
}

function rpcUrlFor(network: string): string {
  return (
    RPC_URLS[network] ??
    RPC_URLS[network.replace(/^solana-/, "")] ??
    RPC_URLS["solana-devnet"]
  );
}

async function loadProgram(network: string, keypair: Uint8Array) {
  const connection = new Connection(rpcUrlFor(network), "confirmed");
  const wallet = new Wallet(Keypair.fromSecretKey(keypair));
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  setProvider(provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { program: new Program(idl as any, provider), connection, wallet };
}

const splitInfoCommand = new Command("info")
  .description("Read the on-chain SplitConfig PDA for this deploy")
  .option("--slug <slug>", "deployment slug (server resolves the PDA)")
  .option("--pda <address>", "skip server lookup, read this PDA directly")
  .option("--network <net>", "solana network (devnet|mainnet); defaults to the gate's network")
  .option("--server <url>", "chest.sh API origin")
  .option("--json", "Emit machine-readable JSON")
  .action(
    async (opts: { slug?: string; pda?: string; network?: string; server?: string; json?: boolean }) => {
      try {
        const { pda, network } = await resolveGateMeta(opts);
        const feePayer = await ensureKeypair();
        const { program } = await loadProgram(network, feePayer.keypair);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cfg = (await (program.account as any).splitConfig.fetchNullable(pda)) as
          | {
              authority: PublicKey;
              merchantWallet: PublicKey;
              protocolWallet: PublicKey;
              referrerBps: number;
              protocolBps: number;
            }
          | null;

        if (!cfg) {
          console.error(chalk.red(`  Error: no split config account at ${pda.toBase58()} on ${network}.`));
          console.error(
            chalk.gray("  Either the slug was deployed without a split, or it lives on a different network."),
          );
          process.exit(1);
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({
              pda: pda.toBase58(),
              network,
              authority: cfg.authority.toBase58(),
              merchantWallet: cfg.merchantWallet.toBase58(),
              protocolWallet: cfg.protocolWallet.toBase58(),
              referrerBps: cfg.referrerBps,
              protocolBps: cfg.protocolBps,
            }) + "\n",
          );
          return;
        }

        console.log(chalk.bold("\n  ⚡ Split Config\n"));
        console.log(chalk.gray("  PDA:              ") + chalk.cyan(pda.toBase58()));
        console.log(chalk.gray("  Network:          ") + chalk.white(network));
        console.log(chalk.gray("  Authority:        ") + chalk.white(cfg.authority.toBase58()));
        console.log(chalk.gray("  Merchant wallet:  ") + chalk.white(cfg.merchantWallet.toBase58()));
        console.log(chalk.gray("  Protocol wallet:  ") + chalk.white(cfg.protocolWallet.toBase58()));
        console.log(
          chalk.gray("  Referrer bps:     ") +
            chalk.green(`${cfg.referrerBps} (${(cfg.referrerBps / 100).toFixed(2)}%)`),
        );
        console.log(
          chalk.gray("  Protocol bps:     ") +
            chalk.white(`${cfg.protocolBps} (${(cfg.protocolBps / 100).toFixed(2)}%)`),
        );
        console.log();
      } catch (err) {
        handleError(err, opts.slug);
        process.exit(1);
      }
    },
  );

const splitUpdateCommand = new Command("update")
  .description("Update the referrer commission % for this deploy")
  .requiredOption("--referrer <pct>", "new referrer commission in % (0–98.5)")
  .option("--slug <slug>", "deployment slug (server resolves the PDA)")
  .option("--pda <address>", "skip server lookup, update this PDA directly")
  .option("--network <net>", "solana network (devnet|mainnet); defaults to the gate's network")
  .option("--server <url>", "chest.sh API origin")
  .action(
    async (opts: { referrer: string; slug?: string; pda?: string; network?: string; server?: string }) => {
      const pct = parseFloat(opts.referrer);
      if (!Number.isFinite(pct) || pct < 0 || pct > 98.5) {
        console.error(chalk.red(`Referrer % out of range: ${opts.referrer} (must be 0–98.5)`));
        process.exit(1);
      }
      const newBps = Math.round(pct * 100);
      if (newBps > MAX_REFERRER_BPS) {
        console.error(chalk.red(`Referrer bps out of range: ${newBps} (max ${MAX_REFERRER_BPS})`));
        process.exit(1);
      }

      try {
        const { pda, network } = await resolveGateMeta(opts);
        const feePayer = await ensureKeypair();
        const { program, connection } = await loadProgram(network, feePayer.keypair);
        const authority = Keypair.fromSecretKey(feePayer.keypair);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing = (await (program.account as any).splitConfig.fetchNullable(pda)) as
          | { authority: PublicKey }
          | null;
        if (!existing) {
          console.error(chalk.red(`  Error: no split config account at ${pda.toBase58()} on ${network}.`));
          process.exit(1);
        }

        if (!existing.authority.equals(authority.publicKey)) {
          console.error(
            chalk.red(
              `  Error: this split is owned by ${existing.authority.toBase58()}, not your local wallet (${authority.publicKey.toBase58()}).`,
            ),
          );
          console.error(
            chalk.gray(
              "  `split update` requires the keypair that initialised the split. Re-run with the right --wallet-key, or import the right wallet to ~/.chest/wallet.json.",
            ),
          );
          process.exit(1);
        }

        // Probe RPC reachability before signing so users get a clean error
        // instead of a stack trace when devnet is offline.
        await connection.getSlot();

        console.log(
          chalk.gray(`  Updating referrer bps → ${newBps} (${pct.toFixed(2)}%) on ${network}...`),
        );

        const sig = await program.methods
          .updateReferrerBps(newBps)
          .accounts({
            authority: authority.publicKey,
            splitConfig: pda,
          })
          .rpc();

        console.log(chalk.green(`\n  ✓ Updated. Tx: ${sig}`));
        console.log(chalk.gray(`  PDA: ${pda.toBase58()}\n`));
      } catch (err) {
        handleError(err, opts.slug);
        process.exit(1);
      }
    },
  );

function handleError(err: unknown, slug?: string): void {
  if (err instanceof NotLoggedInError) {
    console.error(chalk.red(`  Error: ${err.message}`));
    console.error(chalk.gray("  Or pass --pda <address> to skip the server lookup."));
    return;
  }
  if (err instanceof ApiError) {
    console.error(chalk.red(`  Error ${err.status}: ${err.message}`));
    if (err.status === 401) {
      console.error(chalk.gray("  Re-run `chest-gate login`, or pass --pda <address>."));
    } else if (err.status === 403 && slug) {
      console.error(
        chalk.gray(`  Your wallet doesn't own slug "${slug}". Use --pda <address> to bypass the slug → PDA lookup.`),
      );
    } else if (err.status === 404 && slug) {
      console.error(chalk.gray(`  Slug "${slug}" not found.`));
    }
    return;
  }
  console.error(chalk.red(`  Error: ${(err as Error).message}`));
}

export const splitCommand = new Command("split")
  .description("Manage the on-chain revenue split for a deploy")
  .addCommand(splitInfoCommand)
  .addCommand(splitUpdateCommand);
