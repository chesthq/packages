import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { loadManifest } from "../manifest.js";

export const appCommand = new Command("app").description(
  "Manage Chest Gate App manifests (app.md authoring artifact)",
);

appCommand
  .command("validate")
  .description("Validate an app.md manifest against the schema")
  .argument("[path]", "Path to app.md", "./app.md")
  .action(async (path: string) => {
    const abs = resolve(process.cwd(), path);
    const result = await loadManifest(abs);

    if (!result.ok) {
      console.error(chalk.red(`✗ ${path} failed validation:`));
      for (const err of result.errors) {
        console.error(chalk.gray("  · ") + chalk.yellow(err.path) + chalk.gray(", ") + err.message);
      }
      process.exit(1);
    }

    const m = result.manifest;
    console.log(chalk.green(`✓ ${path} is valid`));
    console.log("");
    console.log(chalk.gray("  name           ") + chalk.white(m.name));
    console.log(chalk.gray("  author         ") + chalk.white(m.author));
    console.log(chalk.gray("  version        ") + chalk.white(m.version));
    console.log(chalk.gray("  description    ") + chalk.white(m.description));
    console.log(chalk.gray("  capabilityTags ") + chalk.white(m.capabilityTags.join(", ")));
    if (m.upstreamGates && m.upstreamGates.length > 0) {
      console.log(chalk.gray("  upstreamGates  ") + chalk.white(m.upstreamGates.join(", ")));
    }
    if (m.homepage) console.log(chalk.gray("  homepage       ") + chalk.white(m.homepage));
    if (m.repository) console.log(chalk.gray("  repository     ") + chalk.white(m.repository));
    if (m.license) console.log(chalk.gray("  license        ") + chalk.white(m.license));
    console.log(chalk.gray("  body           ") + chalk.white(`${m.body.length} chars of markdown`));
    console.log("");
    console.log(
      chalk.gray("Note: ") +
        chalk.gray(
          "payout wallet is resolved from the on-chain author record at publish time, not declared in app.md.",
        ),
    );
  });
