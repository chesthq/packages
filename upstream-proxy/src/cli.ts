#!/usr/bin/env node
/**
 * @chest-gate/upstream-proxy, generate a key-holding proxy template.
 *
 * Goal: publisher wraps an upstream API behind a Chest gate without ever
 * handing the API key to chest. The generated proxy holds the key in its own
 * env (Vercel project, Cloudflare Workers secret, AWS Secrets Manager,
 * whatever the publisher already runs). chest gate's --upstream points at the
 * proxy URL. Best fit for APIs you own, run, or are explicitly licensed to
 * redistribute, many third-party providers' terms of service restrict
 * proxying, so check before wrapping someone else's commercial endpoint.
 *
 * Usage:
 *   npx @chest-gate/upstream-proxy init <name>
 *     --target https://api.example.com/v1
 *     --auth-header "x-api-key=$ENV:UPSTREAM_KEY"
 *     [--allow-paths "/v1/*"]
 *     [--strip-headers "authorization,cookie"]
 *
 * The generated directory is self-contained: its README explains how to set
 * the secret + push to Vercel/whatever, and the bundled handler enforces:
 *   - path allowlist (no open relay)
 *   - header strip (no smuggled creds from caller)
 *   - egress allowlist (only the configured target host; SSRF-proof)
 *   - response sanitisation (drops set-cookie / www-authenticate)
 *   - optional rate limit (protect publisher's third-party quota)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

interface InitOptions {
  name: string;
  target: string;
  authHeader: string;
  allowPaths?: string;
  stripHeaders?: string;
  outDir?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname is dist/ in production, src/ in dev, the template lives at
// ../template relative to either.
const TEMPLATE_DIR = resolvePath(__dirname, "..", "template");

const DEFAULT_STRIP = "authorization,cookie,x-api-key";

function usage(extra?: string): never {
  if (extra) console.error(chalk.red(`  ${extra}\n`));
  console.error(`Usage: chest-upstream-proxy init <name> [flags]

Required:
  --target <url>              Upstream API origin to wrap.
  --auth-header <name=value>  Header to inject. value may use $ENV:VARNAME.

Optional:
  --allow-paths <patterns>    CSV path allowlist (default "*", everything).
  --strip-headers <names>     CSV header names to strip from caller.
                              (default "${DEFAULT_STRIP}")
  --out <dir>                 Output directory (default ./<name>).

Example:
  chest-upstream-proxy init my-api \\
    --target https://api.example.com/v1 \\
    --auth-header "x-api-key=\\$ENV:UPSTREAM_KEY"
`);
  process.exit(1);
}

function parseFlags(argv: string[]): { command: string; options: Partial<InitOptions> } {
  const [command, ...rest] = argv;
  const options: Partial<InitOptions> = {};
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      if (!options.name) options.name = arg;
      else usage(`Unexpected positional argument: ${arg}`);
      i++;
      continue;
    }
    const flag = arg.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) {
      usage(`Flag --${flag} requires a value`);
    }
    switch (flag) {
      case "target": options.target = value; break;
      case "auth-header": options.authHeader = value; break;
      case "allow-paths": options.allowPaths = value; break;
      case "strip-headers": options.stripHeaders = value; break;
      case "out": options.outDir = value; break;
      default: usage(`Unknown flag --${flag}`);
    }
    i += 2;
  }
  return { command: command ?? "", options };
}

function validate(opts: Partial<InitOptions>): InitOptions {
  if (!opts.name) usage("Missing <name> positional argument.");
  if (!opts.target) usage("Missing --target flag.");
  if (!opts.authHeader) usage("Missing --auth-header flag.");
  try {
    new URL(opts.target!);
  } catch {
    usage(`--target must be a valid URL (got "${opts.target}").`);
  }
  if (!/^[a-z][a-z0-9_-]*=.+/.test(opts.authHeader!)) {
    usage(`--auth-header must be "name=value" (got "${opts.authHeader}").`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.name!)) {
    usage(`<name> must be lowercase alphanumeric + dashes (got "${opts.name}").`);
  }
  return {
    name: opts.name!,
    target: opts.target!,
    authHeader: opts.authHeader!,
    allowPaths: opts.allowPaths,
    stripHeaders: opts.stripHeaders ?? DEFAULT_STRIP,
    outDir: opts.outDir,
  };
}

/**
 * Substitute {{placeholders}} in template files. The set of placeholders is
 * deliberately small, adding more raises the surface area for bugs. Use
 * straightforward string replace; the templates aren't user-supplied content.
 */
function applyVars(input: string, vars: Record<string, string>): string {
  return input.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) return `{{${key}}}`;
    return vars[key];
  });
}

function copyTemplate(srcDir: string, dstDir: string, vars: Record<string, string>) {
  if (!existsSync(srcDir)) {
    throw new Error(`Template directory not found at ${srcDir}`);
  }
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    const dstPath = join(dstDir, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyTemplate(srcPath, dstPath, vars);
      continue;
    }
    const isText = /\.(ts|js|json|md|mjs|yaml|yml|env|gitignore)$/.test(entry) || entry === "README";
    if (isText) {
      const raw = readFileSync(srcPath, "utf8");
      writeFileSync(dstPath, applyVars(raw, vars), "utf8");
    } else {
      writeFileSync(dstPath, readFileSync(srcPath));
    }
  }
}

function init(opts: InitOptions) {
  const outDir = resolvePath(opts.outDir ?? opts.name);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    console.error(chalk.red(`  Error: ${outDir} already exists and is not empty.`));
    process.exit(1);
  }

  const [headerName, headerValue] = opts.authHeader.split("=", 2);
  // Detect $ENV:VARNAME refs and capture the env variable for the README.
  const envMatch = /^\$ENV:([A-Z][A-Z0-9_]*)$/.exec(headerValue);
  const envVarName = envMatch ? envMatch[1] : null;

  const targetUrl = new URL(opts.target);
  const targetOrigin = `${targetUrl.protocol}//${targetUrl.host}`;
  const targetPath = targetUrl.pathname.replace(/\/+$/, "");

  // JSON-encode strings before substituting so the values land safely inside
  // template source as JS string literals (handles quotes, backslashes, etc).
  const vars: Record<string, string> = {
    NAME: opts.name,
    TARGET_ORIGIN: targetOrigin,
    TARGET_PATH: targetPath,
    HEADER_NAME: JSON.stringify(headerName),
    HEADER_VALUE_LITERAL: envVarName
      ? `process.env.${envVarName} ?? ""`
      : JSON.stringify(headerValue),
    ENV_VAR_NAME: envVarName ?? "",
    ALLOW_PATHS_JSON: JSON.stringify(
      (opts.allowPaths ?? "*").split(",").map((s) => s.trim()).filter(Boolean),
    ),
    STRIP_HEADERS_JSON: JSON.stringify(
      opts.stripHeaders!.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    ),
  };

  copyTemplate(TEMPLATE_DIR, outDir, vars);

  console.log(chalk.green(`\n  ✓ Created ${opts.name} in ${outDir}\n`));
  console.log(chalk.gray("  Next steps:"));
  console.log(chalk.gray("  ─────────────────────────────────────────"));
  console.log(`  1. cd ${opts.name}`);
  console.log("  2. npm install");
  if (envVarName) {
    console.log(`  3. Set ${chalk.cyan(envVarName)} in your hosting provider's env`);
  }
  console.log(`  ${envVarName ? "4" : "3"}. Deploy (Vercel: ${chalk.cyan("vercel deploy")})`);
  console.log(`  ${envVarName ? "5" : "4"}. Wire it through chest:`);
  console.log(
    chalk.gray(
      `       chest deploy --upstream <your-deployed-url> --slug <slug> --price '$0.01'\n`,
    ),
  );
  console.log(chalk.gray("  Your API key never enters chest infrastructure.\n"));
}

const { command, options } = parseFlags(process.argv.slice(2));
switch (command) {
  case "init":
    init(validate(options));
    break;
  case "":
  case "--help":
  case "-h":
    usage();
  default:
    usage(`Unknown command: ${command}`);
}
