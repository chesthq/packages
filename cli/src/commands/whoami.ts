import { Command } from "commander";
import chalk from "chalk";
import { loadCredentials } from "../credentials.js";

export const whoamiCommand = new Command("whoami")
  .description("Show the wallet and CLI token currently signed in on this device.")
  .option("--json", "Emit machine-readable JSON instead of formatted text")
  .action(async (opts: { json?: boolean }) => {
    const creds = await loadCredentials();
    if (!creds) {
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: false, error: "not-logged-in" }) + "\n");
        process.exit(1);
      }
      console.log(chalk.gray("\n  Not logged in. Run ") + chalk.white("chest-gate login") + chalk.gray(".\n"));
      process.exit(1);
    }

    const session = await fetchSession(creds.gateUrl, creds.token);

    if (opts.json) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          source: creds.source,
          ownerWallet: creds.source === "env" ? session?.ownerWallet ?? null : creds.ownerWallet,
          tokenId: creds.source === "env" ? session?.tokenId ?? null : creds.tokenId,
          label: creds.source === "env" ? session?.label ?? "CHEST_TOKEN env" : creds.label,
          gateUrl: creds.gateUrl,
          createdAt: creds.source === "env" ? null : creds.createdAt,
          lastUsedAt: session?.lastUsedAt ?? null,
        }) + "\n",
      );
      return;
    }

    if (creds.source === "env") {
      console.log();
      console.log(chalk.gray("  Source: ") + chalk.white("CHEST_TOKEN env var"));
      console.log(chalk.gray("  Gate:   ") + chalk.white(creds.gateUrl));
      console.log();
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
