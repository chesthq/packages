#!/usr/bin/env node

import { Command } from "commander";
import { gateCommand } from "./commands/gate.js";
import { deployCommand } from "./commands/deploy.js";
import { initCommand } from "./commands/init.js";
import { statusCommand } from "./commands/status.js";
import { keypairCommand } from "./commands/keypair.js";
import { splitCommand } from "./commands/split.js";
import { appCommand } from "./commands/app.js";

const program = new Command();

program
  .name("chest-gate")
  .description("One command to monetise any API with x402 on Solana")
  .version("0.2.0");

program.addCommand(gateCommand);
program.addCommand(deployCommand);
program.addCommand(initCommand);
program.addCommand(statusCommand);
program.addCommand(keypairCommand);
program.addCommand(splitCommand);
program.addCommand(appCommand);

program.parse();
