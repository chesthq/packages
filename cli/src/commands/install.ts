import { Command } from "commander";
import chalk from "chalk";
import { spawn } from "node:child_process";

const PACKAGE = "@chest-gate/install";

/**
 * Thin shim over `npx @chest-gate/install`. We don't import the installer
 * because it has zero npm deps by design — bundling it into the CLI would
 * drag every `chest-gate install` invocation through ~25MB of Solana SDK
 * cold-load. Shelling out keeps the lightweight code path lightweight.
 *
 * `npx -y` is a no-op fetch when @chest-gate/install is already installed
 * globally, so this stays cheap for repeat users.
 */
export const installCommand = new Command("install")
  .description("Install a published Chest Gate app (skill) into ~/.claude/skills/")
  .argument("<slug>", "App slug, e.g. `trading-decision`")
  .option("--force", "Remove an existing target before installing (destructive)")
  .option("--upgrade", "Rename an existing target to <name>.bak-<timestamp> first")
  .allowUnknownOption(true)
  .addHelpText(
    "after",
    `\nUnder the hood: \`npx -y ${PACKAGE} <slug> [flags]\`. Run that directly for the full flag list.\n`,
  )
  .action(async (slug: string, opts: { force?: boolean; upgrade?: boolean }, cmd: Command) => {
    const passthrough = cmd.args.slice(1);
    const flags = [
      ...(opts.force ? ["--force"] : []),
      ...(opts.upgrade ? ["--upgrade"] : []),
      ...passthrough,
    ];

    const code = await run(["npx", "-y", PACKAGE, slug, ...flags]);
    if (code !== 0) process.exit(code ?? 1);
  });

function run(argv: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
    child.on("close", (code) => resolve(code));
    child.on("error", (err) => {
      console.error(chalk.red(`  Error: ${err.message}`));
      resolve(1);
    });
  });
}
