#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import updateNotifier from "update-notifier";
import { gateCommand } from "./commands/gate.js";
import { deployCommand } from "./commands/deploy.js";
import { initCommand } from "./commands/init.js";
import { statusCommand } from "./commands/status.js";
import { keypairCommand } from "./commands/keypair.js";
import { splitCommand } from "./commands/split.js";
import { appCommand } from "./commands/app.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { whoamiCommand } from "./commands/whoami.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { installCommand } from "./commands/install.js";
import { callCommand } from "./commands/call.js";

const pkg = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf-8"),
) as { name: string; version: string };

updateNotifier({ pkg }).notify();

const program = new Command();

program
  .name("chest-gate")
  .description("One command to monetise any API with x402 on Solana")
  .version(pkg.version);

program.addCommand(callCommand);
program.addCommand(gateCommand);
program.addCommand(deployCommand);
program.addCommand(initCommand);
program.addCommand(statusCommand);
program.addCommand(keypairCommand);
program.addCommand(splitCommand);
program.addCommand(appCommand);
program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(whoamiCommand);
program.addCommand(upgradeCommand);
program.addCommand(installCommand);

program.parse();
