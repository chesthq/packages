import { Command } from "commander";
import chalk from "chalk";
import { ensureKeypair } from "../keypair.js";

export const keypairCommand = new Command("keypair")
  .description("Show or generate the fee-payer wallet")
  .option("--show-mnemonic", "Display the seed phrase (careful, don't share this)")
  .action(async (opts) => {
    console.log(chalk.bold("\n  ⚡ Chest Wallet\n"));

    const feePayer = await ensureKeypair();

    if (feePayer.created) {
      console.log(chalk.bgYellow.black("  ⚠  NEW WALLET CREATED, BACK IT UP  "));
      console.log();
      console.log(chalk.yellow("  A new Solana wallet was generated. If you lose the file or seed,"));
      console.log(chalk.yellow("  you lose access to deploys under this wallet and any SOL it holds."));
      console.log();
    }

    console.log(chalk.gray("  Solana address: ") + chalk.cyan(feePayer.address));
    console.log(chalk.gray("  Wallet file:    ") + chalk.white(feePayer.path));
    console.log();

    if (!opts.showMnemonic) {
      console.log(chalk.yellow("  ⚠  Back up your seed phrase. Run with --show-mnemonic to view it."));
      console.log(chalk.gray("     Anyone with this seed phrase controls this wallet."));
      console.log();
    }

    if (opts.showMnemonic) {
      console.log(chalk.yellow("  Seed phrase (keep this secret):"));
      console.log(chalk.white(`  ${feePayer.mnemonic}`));
      console.log();
      console.log(chalk.gray("  This seed phrase can derive wallets for Solana, Ethereum, and other chains."));
      console.log(chalk.gray("  Derivation path (Solana): m/44'/501'/0'/0'"));
    }

    console.log();
    console.log(
      chalk.yellow("  Fund this address with SOL for transaction fees.")
    );
    console.log(
      chalk.yellow("  On devnet: https://faucet.solana.com")
    );
    console.log(
      chalk.yellow("  On mainnet: send ~0.01 SOL")
    );
    console.log();
  });
