import { Command } from "commander";
import chalk from "chalk";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runPkceLogin, PkceLoginError } from "@chest-gate/auth-flow";
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
  port?: string;
  force?: boolean;
  noBrowser?: boolean;
}

export const loginCommand = new Command("login")
  .description("Sign in to Chest. Opens a browser, returns a CLI token to this device.")
  .option("--web-url <url>", "Override chest.sh URL", getDefaultWebUrl())
  .option("--gate-url <url>", "Override gate.chest.sh URL", getDefaultGateUrl())
  .option("--port <port>", "Loopback port (default: random)")
  .option("-f, --force", "Skip the 'already logged in' prompt")
  .option("--no-browser", "Print the URL instead of opening a browser")
  .action(async (opts: LoginOptions) => {
    console.log(chalk.bold("\n  ⚡ Chest Login\n"));

    const existing = await loadCredentials();
    if (existing && existing.source === "file" && !opts.force) {
      if (!stdin.isTTY) {
        console.error(
          chalk.red("  Already logged in. Pass --force to mint a new token, or set CHEST_AGENT_TOKEN env var.\n")
        );
        process.exit(1);
      }
      console.log(
        chalk.gray(`  Already logged in as `) +
          chalk.cyan(existing.ownerWallet || existing.label) +
          chalk.gray(`.`)
      );
      console.log(
        chalk.gray("  Re-running mints a new token; the old one stays valid until revoked.")
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
        chalk.red("  Non-interactive shell detected. Set CHEST_AGENT_TOKEN instead of running `login`.\n")
      );
      process.exit(1);
    }

    const webUrl = (opts.webUrl || getDefaultWebUrl()).replace(/\/$/, "");
    const gateUrl = (opts.gateUrl || getDefaultGateUrl()).replace(/\/$/, "");

    const portArg = opts.port ? parseInt(opts.port, 10) : 0;
    if (opts.port && (!Number.isFinite(portArg) || portArg < 0 || portArg > 65535)) {
      console.error(chalk.red(`  Invalid --port: ${opts.port}`));
      process.exit(1);
    }

    let result;
    try {
      result = await runPkceLogin({
        webUrl,
        gateUrl,
        hostname: hostname() || "unknown",
        desiredPort: portArg,
        openBrowser: opts.noBrowser !== true,
        onListen: ({ loginUrl, port }) => {
          console.log(chalk.gray("  Opening browser to authorize this device…"));
          console.log(chalk.gray("  If it doesn't open, visit:"));
          console.log(chalk.cyan(`    ${loginUrl}`));
          console.log();
          console.log(chalk.gray(`  Listening on http://127.0.0.1:${port}/callback`));
          console.log();
          process.stdout.write(chalk.gray("  Exchanging code… "));
        },
      });
      console.log(chalk.green("done"));
    } catch (err) {
      if (err instanceof PkceLoginError && err.kind === "exchange") {
        console.log(chalk.red("failed"));
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  ✗ ${message}\n`));
      process.exit(1);
    }

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
    console.log(chalk.gray("  Manage tokens at ") + chalk.cyan(`${webUrl}/dashboard/agent-wallet`));
    console.log();
  });
