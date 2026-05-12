import { Command } from "commander";
import chalk from "chalk";
import { loadCredentials, deleteCredentials, getCredentialsPath } from "../credentials.js";

export const logoutCommand = new Command("logout")
  .description("Sign out: revoke the CLI token and remove local credentials.")
  .option("--keep-remote", "Delete local credentials but don't revoke the token on the server")
  .action(async (opts: { keepRemote?: boolean }) => {
    console.log(chalk.bold("\n  ⚡ Chest Logout\n"));

    const creds = await loadCredentials();
    if (!creds) {
      console.log(chalk.gray("  Not logged in.\n"));
      return;
    }

    if (creds.source === "env") {
      console.log(
        chalk.yellow("  CHEST_AGENT_TOKEN env var is set; logout doesn't unset env vars.\n")
      );
      return;
    }

    if (!opts.keepRemote && creds.tokenId && creds.gateUrl) {
      process.stdout.write(chalk.gray("  Revoking token on server… "));
      try {
        const res = await fetch(`${creds.gateUrl}/v1/cli/revoke`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${creds.token}`,
          },
          body: JSON.stringify({ tokenId: creds.tokenId }),
        });
        if (res.ok) {
          console.log(chalk.green("done"));
        } else {
          console.log(chalk.yellow(`skipped (${res.status})`));
        }
      } catch (err) {
        console.log(chalk.yellow(`skipped (${(err as Error).message})`));
      }
    }

    const removed = await deleteCredentials();
    if (removed) {
      console.log(chalk.green(`  ✓ Removed ${getCredentialsPath()}`));
    } else {
      console.log(chalk.gray(`  No credentials file at ${getCredentialsPath()}`));
    }
    console.log();
  });
