import { Command } from "commander";
import chalk from "chalk";
import pkg from "@coral-xyz/anchor";
const { AnchorProvider, Program, Wallet, setProvider } = pkg;
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ensureKeypair } from "../keypair.js";
import { computeSlugHash, RPC_URLS } from "../splitter-init.js";
import idl from "../chest_splitter_idl.json" with { type: "json" };

const PROGRAM_ID = new PublicKey("9a6zrqau5xVEdxNqBUfL2G18WuryQbWeJScPAUHZvmmX");
const MAX_REFERRER_BPS = 9850;

function deriveSplitConfigPda(authority: PublicKey, slug: string): PublicKey {
  const slugHash = computeSlugHash(slug);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("split"), authority.toBuffer(), slugHash],
    PROGRAM_ID
  );
  return pda;
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

async function resolveSlug(cliSlug: string | undefined): Promise<string> {
  if (cliSlug) return cliSlug;
  throw new Error("Pass --slug <slug> (the deployed slug, e.g. 'my-api')");
}

const splitInfoCommand = new Command("info")
  .description("Read the on-chain SplitConfig PDA for this deploy")
  .option("--slug <slug>", "deployment slug (required)")
  .option("--network <net>", "solana network (devnet|mainnet)", "solana-devnet")
  .action(async (opts) => {
    const feePayer = await ensureKeypair();
    const slug = await resolveSlug(opts.slug);
    const { program } = await loadProgram(opts.network, feePayer.keypair);
    const authority = new PublicKey(feePayer.address);
    const pda = deriveSplitConfigPda(authority, slug);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = (await (program.account as any).splitConfig.fetch(pda)) as {
      authority: PublicKey;
      merchantWallet: PublicKey;
      protocolWallet: PublicKey;
      referrerBps: number;
      protocolBps: number;
    };

    console.log(chalk.bold("\n  ⚡ Split Config\n"));
    console.log(chalk.gray("  PDA:              ") + chalk.cyan(pda.toBase58()));
    console.log(chalk.gray("  Authority:        ") + chalk.white(cfg.authority.toBase58()));
    console.log(chalk.gray("  Merchant wallet:  ") + chalk.white(cfg.merchantWallet.toBase58()));
    console.log(chalk.gray("  Protocol wallet:  ") + chalk.white(cfg.protocolWallet.toBase58()));
    console.log(
      chalk.gray("  Referrer bps:     ") +
        chalk.green(`${cfg.referrerBps} (${(cfg.referrerBps / 100).toFixed(2)}%)`)
    );
    console.log(
      chalk.gray("  Protocol bps:     ") +
        chalk.white(`${cfg.protocolBps} (${(cfg.protocolBps / 100).toFixed(2)}%)`)
    );
    console.log();
  });

const splitUpdateCommand = new Command("update")
  .description("Update the referrer commission % for this deploy")
  .requiredOption("--referrer <pct>", "new referrer commission in % (0–98.5)")
  .option("--slug <slug>", "deployment slug (required)")
  .option("--network <net>", "solana network (devnet|mainnet)", "solana-devnet")
  .action(async (opts) => {
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

    const feePayer = await ensureKeypair();
    const slug = await resolveSlug(opts.slug);
    const { program, connection } = await loadProgram(opts.network, feePayer.keypair);
    const authority = Keypair.fromSecretKey(feePayer.keypair);
    const pda = deriveSplitConfigPda(authority.publicKey, slug);

    const existing = await connection.getAccountInfo(pda);
    if (!existing) {
      console.error(
        chalk.red(`No split config at ${pda.toBase58()}. Run 'chest-gate deploy' first.`)
      );
      process.exit(1);
    }

    console.log(
      chalk.gray(`  Updating referrer bps → ${newBps} (${pct.toFixed(2)}%) for slug '${slug}'...`)
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
  });

export const splitCommand = new Command("split")
  .description("Manage the on-chain revenue split for a deploy")
  .addCommand(splitInfoCommand)
  .addCommand(splitUpdateCommand);
