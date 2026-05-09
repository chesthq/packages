import { Command } from "commander";
import chalk from "chalk";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { stringify as stringifyYaml } from "yaml";
import { ensureKeypair } from "../keypair.js";

/**
 * Parse a session duration string into seconds.
 * Accepts plain numbers ("300") or suffixed forms ("5m", "1h", "30s").
 * Falls back to 300 (5 minutes) on bad input.
 */
function parseDuration(input: string): number {
  const s = input.trim().toLowerCase();
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/);
  if (!match) return 300;
  const n = parseFloat(match[1]);
  if (!Number.isFinite(n) || n < 0) return 300;
  const unit = match[2] ?? "s";
  if (unit.startsWith("h")) return Math.round(n * 3600);
  if (unit.startsWith("m") && unit !== "ms") return Math.round(n * 60);
  return Math.round(n);
}

export const initCommand = new Command("init")
  .description("Create a chest.config.yaml interactively")
  .option("-o, --output <path>", "Output file path", "chest.config.yaml")
  .option("-y, --yes", "Accept defaults without prompting")
  .action(async (opts) => {
    console.log(chalk.bold("\n  ⚡ Chest Init\n"));

    const outputPath = opts.output;

    if (existsSync(outputPath) && !opts.yes) {
      const rl = createInterface({ input: stdin, output: stdout });
      const answer = await rl.question(chalk.yellow(`  ${outputPath} already exists. Overwrite? (y/N) `));
      rl.close();
      if (answer.toLowerCase() !== "y") {
        console.log(chalk.gray("\n  Cancelled.\n"));
        return;
      }
    }

    const rl = createInterface({ input: stdin, output: stdout });

    const ask = async (question: string, defaultVal: string): Promise<string> => {
      const answer = await rl.question(chalk.gray(`  ${question}`) + chalk.gray(` (${defaultVal}) `));
      return answer.trim() || defaultVal;
    };

    console.log(chalk.gray("  Answer a few questions to generate your config.\n"));

    // Questions
    const name = await ask("Project name?", "My API");
    const upstream = await ask("Upstream API URL?", "http://localhost:3000");
    const wallet = await ask("Payout wallet (Solana address that receives USDC)?", "");
    const network = await ask("Network?", "devnet");
    const price = await ask("Default price per request (USD)?", "0.01");
    const freebie = await ask("Free requests per IP before charging?", "10");
    const sessionRaw = await ask(
      "Session duration after payment? (seconds, or e.g. 5m, 1h)",
      "5m"
    );
    const session = parseDuration(sessionRaw);
    const port = await ask("Proxy port?", "4020");

    // Routes
    console.log();
    console.log(chalk.gray("  Add custom route pricing? (Enter blank path to finish)"));

    const routes: Array<{ path: string; price: string }> = [];
    let addingRoutes = true;

    while (addingRoutes) {
      const routePath = await ask("Route path (e.g. POST /api/generate)?", "");
      if (!routePath) {
        addingRoutes = false;
        break;
      }
      const routePrice = await ask(`Price for ${routePath}?`, price);
      routes.push({ path: routePath, price: `$${routePrice.replace(/^\$/, "")}` });
    }

    // Splits
    console.log();
    console.log(
      chalk.gray(
        "  Revenue splits let agents/MCPs that route traffic to your API earn a commission."
      )
    );
    console.log(
      chalk.gray(
        "  Splits are enforced on-chain (extra setup tx on first deploy). Skip if unsure."
      )
    );
    const splitAnswer = await ask("Enable revenue splits? (y/N)", "n");
    let referrerPercent: number | undefined;
    if (splitAnswer.trim().toLowerCase().startsWith("y")) {
      const referrerRaw = await ask("Referrer commission %?", "10");
      const parsed = parseFloat(referrerRaw);
      referrerPercent = Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
    }

    rl.close();

    // Build config
    const config: Record<string, unknown> = {
      name,
      upstream,
      payoutWallet: wallet || "YOUR_SOLANA_WALLET_ADDRESS",
      network,
      port: parseInt(port, 10),
      freebie: parseInt(freebie, 10),
      price: `$${price.replace(/^\$/, "")}`,
      session,
    };

    if (routes.length > 0) {
      config.routes = routes;
    }

    // Only the merchant-controlled fields go in the YAML at init time. The
    // protocol % is hardcoded in the program; on-chain PDAs are populated
    // automatically by `chest deploy` after the splitter init transaction.
    if (referrerPercent !== undefined) {
      config.split = { referrer: referrerPercent };
    }

    // Write
    const splitNote = referrerPercent !== undefined
      ? "# Revenue split, only active after `chest deploy` (on-chain).\n"
      : "";
    const rawYaml = stringifyYaml(config, { lineWidth: 0 });
    const yamlBody = splitNote
      ? rawYaml.replace(/^split:/m, `${splitNote}split:`)
      : rawYaml;
    const yamlContent =
      `# Chest Gate Configuration, generated ${new Date().toISOString().split("T")[0]}\n` +
      "#\n" +
      "# payoutWallet receives USDC. Deployer is your local key at\n" +
      "# ~/.chest/wallet.json (see: chest keypair). They can differ.\n\n" +
      yamlBody;

    await writeFile(outputPath, yamlContent);

    console.log();
    console.log(chalk.green(`  ✓ Created ${outputPath}`));
    console.log();

    console.log(chalk.gray("  Prefer a browser? Deploy without the CLI at:"));
    console.log(chalk.cyan("    https://chest.sh/dashboard/gates/new"));
    console.log(chalk.gray("  Sign in with email or connect Phantom, no local wallet needed."));
    console.log();

    // Ensure keypair exists
    const feePayer = await ensureKeypair();

    if (feePayer.created) {
      console.log(chalk.bgYellow.black("  ⚠  NEW WALLET CREATED, BACK IT UP  "));
      console.log();
      console.log(chalk.yellow("  A new Solana wallet was generated for you and saved to:"));
      console.log(chalk.white(`    ${feePayer.path}`));
      console.log();
      console.log(chalk.yellow("  Address: ") + chalk.cyan(feePayer.address));
      console.log();
      console.log(chalk.yellow("  This wallet owns your slug on Chest. If you lose this file,"));
      console.log(chalk.yellow("  you lose access to deploys under this slug, and any SOL it holds."));
      console.log();
      console.log(chalk.yellow("  Reveal the seed phrase (copy it somewhere safe):"));
      console.log(chalk.white("    chest-gate keypair --show-mnemonic"));
      console.log();
    }

    console.log(chalk.gray("  Next steps:"));
    console.log(chalk.gray(`    1. Edit ${outputPath} if needed`));
    if (wallet === "" || wallet === "YOUR_SOLANA_WALLET_ADDRESS") {
      console.log(chalk.yellow(`    2. Set payoutWallet in ${outputPath}`));
    }
    console.log(chalk.gray(`    ${wallet ? "2" : "3"}. Run: `) + chalk.white("chest-gate gate"));
    console.log();
  });
