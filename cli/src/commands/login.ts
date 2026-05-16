import { Command } from "commander";
import chalk from "chalk";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runDeviceGrant, DeviceGrantError } from "@chest-gate/auth-flow";
import {
  loadCredentials,
  saveCredentials,
  getDefaultGateUrl,
  getDefaultWebUrl,
  type Credentials,
} from "../credentials.js";

interface LoginOptions {
  webUrl?: string;
  gateUrl?: string;
  force?: boolean;
  noBrowser?: boolean;
}

export const loginCommand = new Command("login")
  .description("Sign in to Chest. Prints a code, opens chest.sh/device, returns a CLI token to this device.")
  .option("--web-url <url>", "Override chest.sh URL", getDefaultWebUrl())
  .option("--gate-url <url>", "Override gate.chest.sh URL", getDefaultGateUrl())
  .option("-f, --force", "Skip the 'already logged in' prompt")
  .option("--no-browser", "Print the URL instead of opening a browser")
  .action(async (opts: LoginOptions) => {
    console.log(chalk.bold("\n  ⚡ Chest Login\n"));

    const existing = await loadCredentials();
    if (existing && existing.source === "file" && !opts.force) {
      if (!stdin.isTTY) {
        console.error(
          chalk.red(
            "  Already logged in. Pass --force to mint a new token, or set CHEST_AGENT_TOKEN env var.\n",
          ),
        );
        process.exit(1);
      }
      console.log(
        chalk.gray(`  Already logged in as `) +
          chalk.cyan(existing.ownerWallet || existing.label) +
          chalk.gray(`.`),
      );
      console.log(
        chalk.gray("  Re-running mints a new token; the old one stays valid until revoked."),
      );
      const rl = createInterface({ input: stdin, output: stdout });
      const answer = await rl.question(chalk.gray("  Continue? (y/N) "));
      rl.close();
      if (answer.trim().toLowerCase() !== "y") {
        console.log(chalk.gray("\n  Cancelled.\n"));
        return;
      }
      console.log();
    }

    if (!stdin.isTTY && !process.env.CI_ALLOW_NON_TTY_LOGIN) {
      console.error(
        chalk.red("  Non-interactive shell detected. Set CHEST_AGENT_TOKEN instead of running `login`.\n"),
      );
      process.exit(1);
    }

    const gateUrl = (opts.gateUrl || getDefaultGateUrl()).replace(/\/$/, "");

    try {
      const result = await runDeviceGrant({
        gateUrl,
        hostname: hostname() || "unknown",
        openBrowser: opts.noBrowser !== true,
        onCodeIssued: ({ userCode, verificationUri, verificationUriComplete }) => {
          console.log(chalk.gray("  Your one-time code:"));
          console.log("    " + chalk.bold.cyan(userCode));
          console.log();
          if (opts.noBrowser) {
            console.log(chalk.gray("  Visit ") + chalk.cyan(verificationUriComplete));
          } else {
            console.log(
              chalk.gray("  Opening ") +
                chalk.cyan(verificationUri) +
                chalk.gray(" — or visit from any device:"),
            );
            console.log("    " + chalk.cyan(verificationUriComplete));
          }
          console.log();
          process.stdout.write(chalk.gray("  Waiting for authorization… "));
        },
      });
      console.log(chalk.green("✓"));

      const creds: Credentials = {
        version: 1,
        token: result.token,
        ownerWallet: result.ownerWallet,
        tokenId: result.tokenId,
        label: result.label,
        gateUrl,
        createdAt: new Date().toISOString(),
      };
      const path = await saveCredentials(creds);

      console.log();
      console.log(chalk.green("  ✓ Logged in as ") + chalk.cyan(result.ownerWallet));
      console.log(chalk.gray(`    Token label: `) + chalk.white(result.label));
      console.log(chalk.gray(`    Saved to:    `) + chalk.white(path));
      console.log();
      const webUrl = (opts.webUrl || getDefaultWebUrl()).replace(/\/$/, "");
      console.log(chalk.gray("  Manage tokens at ") + chalk.cyan(`${webUrl}/dashboard/agent-wallet`));
      console.log();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof DeviceGrantError) {
        console.log(chalk.red("✗"));
      }
      console.error(chalk.red(`\n  ✗ ${message}\n`));
      process.exit(1);
    }
  });
