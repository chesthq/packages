import { Command } from "commander";
import chalk from "chalk";
import { TransactionStore } from "@chest-gate/proxy";

export const statusCommand = new Command("status")
  .description("Show proxy status and revenue summary")
  .option("--json", "Emit machine-readable JSON instead of formatted text")
  .action(async (opts: { json?: boolean }) => {
    let store: TransactionStore;
    try {
      store = new TransactionStore();
    } catch {
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: false, error: "no-data" }) + "\n");
        process.exit(1);
      }
      console.log(chalk.bold("\n  ⚡ Chest Status\n"));
      console.log(chalk.gray("  No transaction data found. Run `chest-gate gate` first.\n"));
      return;
    }

    const stats = store.getStats();
    store.close();

    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, stats }) + "\n");
      return;
    }

    console.log(chalk.bold("\n  ⚡ Chest Status\n"));
    console.log(chalk.white("  Revenue"));
    console.log(chalk.gray("  ─────────────────────────────────────────"));
    console.log(chalk.gray("  Total revenue:      ") + chalk.green(`$${stats.totalRevenue.toFixed(6)} USDC`));
    console.log(chalk.gray("  Settled payments:   ") + chalk.white(String(stats.settledTransactions)));
    console.log(chalk.gray("  Total requests:     ") + chalk.white(String(stats.totalTransactions)));
    console.log(chalk.gray("  Unique payers:      ") + chalk.white(String(stats.uniquePayers)));
    console.log();

    if (stats.topRoutes.length > 0) {
      console.log(chalk.white("  Top Routes"));
      console.log(chalk.gray("  ─────────────────────────────────────────"));
      for (const route of stats.topRoutes) {
        console.log(
          chalk.gray("  ") +
          chalk.white(route.route.padEnd(30)) +
          chalk.green(`$${route.revenue.toFixed(4)}`) +
          chalk.gray(` (${route.count} payments)`)
        );
      }
    }

    console.log();
  });
