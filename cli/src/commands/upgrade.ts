import { Command } from "commander";
import chalk from "chalk";
import { spawn } from "node:child_process";

const PACKAGE = "@chest-gate/cli";

export const upgradeCommand = new Command("upgrade")
  .description("Upgrade chest-gate to the latest version on npm")
  .option("--pm <manager>", "Package manager to use (npm | pnpm | yarn | bun)", "npm")
  .option("--check", "Only check the latest version, don't install")
  .action(async (opts: { pm: string; check?: boolean }) => {
    console.log(chalk.bold("\n  ⚡ Chest Upgrade\n"));

    const latest = await fetchLatest();
    if (!latest) {
      console.error(chalk.red("  Could not reach https://registry.npmjs.org. Are you online?\n"));
      process.exit(1);
    }

    // package.json is bundled into dist via tsc; read the version statically.
    const current = await currentVersion();

    console.log(chalk.gray("  Installed: ") + chalk.white(current ?? "unknown"));
    console.log(chalk.gray("  Latest:    ") + chalk.cyan(latest));
    console.log();

    const cmp = current ? compareSemver(current, latest) : -1;
    if (cmp >= 0) {
      const note = cmp === 0 ? "Already on the latest version." : "Installed version is ahead of npm (dev build).";
      console.log(chalk.green(`  ✓ ${note}\n`));
      return;
    }

    if (opts.check) {
      console.log(chalk.yellow(`  Update available. Run: chest-gate upgrade\n`));
      return;
    }

    const cmd = installCommand(opts.pm);
    console.log(chalk.gray("  Running: ") + chalk.white(cmd.join(" ")));
    console.log();

    const code = await run(cmd);
    if (code !== 0) {
      console.error(chalk.red(`\n  Upgrade failed (exit ${code}).`));
      console.error(chalk.gray(`  Try a different --pm, or run manually: ${cmd.join(" ")}\n`));
      process.exit(code ?? 1);
    }
    console.log(chalk.green(`\n  ✓ Upgraded ${PACKAGE} to ${latest}\n`));
  });

async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`);
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

async function currentVersion(): Promise<string | null> {
  try {
    // Bundled dist sits next to a copy of package.json in production installs.
    // Fall back to the source location for local dev.
    const candidates = [
      new URL("../../package.json", import.meta.url),
      new URL("../package.json", import.meta.url),
    ];
    for (const url of candidates) {
      try {
        const { readFile } = await import("node:fs/promises");
        const raw = await readFile(url, "utf-8");
        const parsed = JSON.parse(raw) as { version?: string };
        if (parsed.version) return parsed.version;
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v.replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

function installCommand(pm: string): string[] {
  switch (pm) {
    case "pnpm":
      return ["pnpm", "add", "-g", `${PACKAGE}@latest`];
    case "yarn":
      return ["yarn", "global", "add", `${PACKAGE}@latest`];
    case "bun":
      return ["bun", "add", "-g", `${PACKAGE}@latest`];
    case "npm":
    default:
      return ["npm", "install", "-g", `${PACKAGE}@latest`];
  }
}

function run(cmd: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(1));
  });
}
