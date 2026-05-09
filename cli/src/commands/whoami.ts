import { Command } from "commander";
import chalk from "chalk";
import { loadCredentials } from "../credentials.js";

export const whoamiCommand = new Command("whoami")
  .description("Show the wallet and CLI token currently signed in on this device.")
  .action(async () => {
    const creds = await loadCredentials();
    if (!creds) {
      console.log(chalk.gray("\n  Not logged in. Run ") + chalk.white("chest-gate login") + chalk.gray(".\n"));
      process.exit(1);
    }

    if (creds.source === "env") {
      console.log();
      console.log(chalk.gray("  Source: ") + chalk.white("CHEST_TOKEN env var"));
      console.log(chalk.gray("  Gate:   ") + chalk.white(creds.gateUrl));
      console.log();
      // Best-effort resolve via /v1/cli/session.
      const session = await fetchSession(creds.gateUrl, creds.token);
      if (session) {
        console.log(chalk.green("  ✓ ") + chalk.cyan(session.ownerWallet));
        console.log(chalk.gray("    Token label: ") + chalk.white(session.label));
        if (session.lastUsedAt) {
          console.log(chalk.gray("    Last used:   ") + chalk.white(session.lastUsedAt));
        }
      } else {
        console.log(chalk.yellow("  Could not verify token with the gate."));
      }
      console.log();
      return;
    }

    console.log();
    console.log(chalk.green("  ✓ ") + chalk.cyan(creds.ownerWallet));
    console.log(chalk.gray("    Token label: ") + chalk.white(creds.label));
    console.log(chalk.gray("    Token id:    ") + chalk.white(creds.tokenId));
    console.log(chalk.gray("    Gate:        ") + chalk.white(creds.gateUrl));
    console.log(chalk.gray("    Logged in:   ") + chalk.white(creds.createdAt));

    const session = await fetchSession(creds.gateUrl, creds.token);
    if (session?.lastUsedAt) {
      console.log(chalk.gray("    Last used:   ") + chalk.white(session.lastUsedAt));
    }
    console.log();
  });

interface SessionResponse {
  ownerWallet: string;
  tokenId: string;
  label: string;
  lastUsedAt?: string;
}

async function fetchSession(gateUrl: string, token: string): Promise<SessionResponse | null> {
  try {
    const res = await fetch(`${gateUrl}/v1/cli/session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as SessionResponse;
  } catch {
    return null;
  }
}
