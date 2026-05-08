#!/usr/bin/env node
/**
 * `npx @chest-gate/install <slug>` — one-command installer for Chest Gate apps.
 *
 * Resolves a slug against gate.chest.sh, parses sourceUrl (a GitHub tree URL),
 * shallow-clones the repo into a temp dir, copies the skill subpath to the
 * runtime folder (~/.claude/skills/<name>), then runs `npm install` if a
 * package.json is present.
 *
 * For app kinds we can't auto-install yet (plugin, mcp, source-less skill),
 * the CLI reads the rest of the manifest — name, kind, tagline, description,
 * readme, homepage — and prints them so the user has somewhere to go. The
 * install command stays uniform across every published app; the fallback
 * keeps it from feeling like a lookup failure.
 *
 * No npm deps; uses git + standard Node built-ins.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const VERSION = "0.2.0";
const DEFAULT_API = "https://gate.chest.sh";
const KEYS_URL = "https://chest.sh/app/keys";
const AUTH_FILE = join(homedir(), ".chest", "auth.json");

type AppKind = "skill" | "plugin" | "mcp";

interface AppManifest {
  slug: string;
  name: string;
  kind: AppKind;
  version: string;
  tagline: string;
  description: string;
  readme: string;
  endpoints: string[];
  sourceUrl: string | null;
  homepageUrl: string | null;
  install: Record<string, string | undefined>;
}

const HELP_TEXT = [
  `chest-install ${VERSION}`,
  "",
  "Usage:",
  "  npx @chest-gate/install <slug> [flags]",
  "",
  "Flags:",
  "  -h, --help  show this help and exit",
  "  --force     remove an existing target before installing (destructive)",
  "  --upgrade   rename an existing target to <name>.bak-<timestamp> first",
  "",
  "Examples:",
  "  npx @chest-gate/install trading-bot",
  "  npx @chest-gate/install trading-bot --upgrade",
  "  npx @chest-gate/install trading-bot --force",
  "",
  "Env:",
  "  CHEST_API      override registry (default: https://gate.chest.sh)",
  "  CHEST_HOME     override install root (default: ~/.claude/skills)",
  "  CHEST_API_KEY  ca_live_ token (skips interactive auth prompt)",
].join("\n");

function printHelp(): never {
  console.log(HELP_TEXT);
  process.exit(0);
}

function usage(): never {
  console.error(HELP_TEXT);
  process.exit(1);
}

interface CliFlags {
  force: boolean;
  upgrade: boolean;
}

function parseFlags(argv: string[]): { positional: string[]; flags: CliFlags } {
  const positional: string[] = [];
  const flags: CliFlags = { force: false, upgrade: false };
  for (const a of argv) {
    if (a === "-h" || a === "--help") printHelp();
    else if (a === "--force") flags.force = true;
    else if (a === "--upgrade") flags.upgrade = true;
    else if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      usage();
    } else positional.push(a);
  }
  return { positional, flags };
}

function parseGithubTreeUrl(
  url: string,
): { owner: string; repo: string; ref: string; subpath: string } | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/.exec(
    url,
  );
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: m[3], subpath: m[4].replace(/\/$/, "") };
}

function readSkillName(dir: string, fallback: string): string {
  const skillMd = join(dir, "SKILL.md");
  if (!existsSync(skillMd)) return fallback;
  const body = readFileSync(skillMd, "utf-8");
  const fm = body.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return fallback;
  const name = fm[1].match(/^name:\s*(.+?)\s*$/m);
  return name ? name[1].trim() : fallback;
}

function targetDir(name: string): string {
  const root =
    process.env.CHEST_HOME ?? join(homedir(), ".claude", "skills");
  return join(root, name);
}

// Print everything we know about the app and exit. Used when the CLI can't
// auto-install (non-skill kinds, source-less skills, non-GitHub sources)
// so the user has the author-controlled context — readme, description,
// homepage — without it feeling like a lookup failure.
function showManifestAndExit(app: AppManifest, reason: string): never {
  const homepage = app.homepageUrl || `https://chest.sh/x/${app.slug}`;
  console.log(`\n  ${app.name}  (${app.kind}, v${app.version})`);
  if (app.tagline) console.log(`  ${app.tagline}`);
  console.log();
  console.log(`  ${reason}`);
  if (app.description) {
    console.log();
    for (const line of app.description.split("\n")) console.log(`  ${line}`);
  }
  if (app.readme) {
    const lines = app.readme.split("\n");
    const head = lines.slice(0, 20);
    console.log();
    for (const line of head) console.log(`  ${line}`);
    if (lines.length > head.length) console.log("  …");
  }
  console.log();
  console.log(`  Homepage: ${homepage}`);
  console.log();
  process.exit(2);
}

interface AuthFile {
  token: string;
  apiUrl: string;
}

function parseAuthInput(raw: string): AuthFile | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("ca_live_")) {
    return { token: trimmed, apiUrl: "https://chest.sh" };
  }
  try {
    const parsed = JSON.parse(trimmed) as { token?: unknown; apiUrl?: unknown };
    if (typeof parsed.token === "string" && parsed.token.startsWith("ca_live_")) {
      const apiUrl = typeof parsed.apiUrl === "string" ? parsed.apiUrl : "https://chest.sh";
      return { token: parsed.token, apiUrl };
    }
  } catch {
    // not JSON
  }
  return null;
}

async function promptForAuth(): Promise<void> {
  const envKey = process.env.CHEST_API_KEY;
  if (envKey && envKey.startsWith("ca_live_")) {
    console.log(`  auth:    using CHEST_API_KEY from env`);
    return;
  }
  if (existsSync(AUTH_FILE)) {
    console.log(`  auth:    ${AUTH_FILE} already exists — leaving it alone`);
    return;
  }
  if (!process.stdin.isTTY) {
    console.log(`  auth:    skipped (non-interactive). Mint at ${KEYS_URL} and save to ${AUTH_FILE}`);
    return;
  }

  console.log(`\n  Mint a key at ${KEYS_URL}`);
  console.log(`  Paste the ca_live_ key or the full JSON below (Enter to skip).`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await rl.question("  > ");
  } finally {
    rl.close();
  }

  if (!answer.trim()) {
    console.log(`  auth:    skipped — set up later by saving the key to ${AUTH_FILE}`);
    return;
  }

  const auth = parseAuthInput(answer);
  if (!auth) {
    console.log(`  auth:    couldn't find a ca_live_ token in that input — skipped.`);
    console.log(`           Save it manually to ${AUTH_FILE}`);
    return;
  }

  mkdirSync(join(homedir(), ".chest"), { recursive: true });
  writeFileSync(AUTH_FILE, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  chmodSync(AUTH_FILE, 0o600);
  console.log(`  auth:    saved → ${AUTH_FILE}`);
}

async function fetchManifest(slug: string): Promise<AppManifest> {
  const api = process.env.CHEST_API ?? DEFAULT_API;
  const url = `${api}/api/apps/${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`\nRegistry lookup failed (${res.status}): ${url}`);
    process.exit(2);
  }
  return (await res.json()) as AppManifest;
}

async function main() {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  if (positional.length !== 1) usage();
  if (flags.force && flags.upgrade) {
    console.error("--force and --upgrade are mutually exclusive.");
    process.exit(1);
  }
  const slug = positional[0];

  console.log(`\n  ⚡ chest install ${slug}\n`);

  const app = await fetchManifest(slug);

  if (app.kind !== "skill") {
    showManifestAndExit(
      app,
      `Auto-install for kind=${app.kind} isn't supported yet — see the homepage for setup instructions.`,
    );
  }
  if (!app.sourceUrl) {
    showManifestAndExit(
      app,
      "This app doesn't have a GitHub source registered yet, so the CLI can't auto-install it.",
    );
  }
  const parsed = parseGithubTreeUrl(app.sourceUrl);
  if (!parsed) {
    showManifestAndExit(
      app,
      `sourceUrl is not a GitHub tree URL (${app.sourceUrl}). Expected: https://github.com/<owner>/<repo>/tree/<ref>/<path>`,
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), "chest-install-"));
  try {
    console.log(`  source:  github.com/${parsed.owner}/${parsed.repo}@${parsed.ref}`);
    console.log(`  path:    ${parsed.subpath}`);
    process.stdout.write("  cloning... ");
    const clone = spawnSync(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        parsed.ref,
        `https://github.com/${parsed.owner}/${parsed.repo}.git`,
        tmp,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    if (clone.status !== 0) {
      console.error(`failed\n${clone.stderr?.toString() ?? ""}`);
      process.exit(2);
    }
    console.log("ok");

    const sourceDir = join(tmp, parsed.subpath);
    if (!existsSync(sourceDir)) {
      console.error(
        `\nSubpath ${parsed.subpath} does not exist in the cloned repo.`,
      );
      process.exit(2);
    }

    const fallbackName = parsed.subpath.split("/").pop() ?? slug;
    const skillName = readSkillName(sourceDir, fallbackName);
    const target = targetDir(skillName);

    if (existsSync(target)) {
      if (flags.force) {
        rmSync(target, { recursive: true, force: true });
        console.log(`  removed: ${target} (--force)`);
      } else if (flags.upgrade) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backup = `${target}.bak-${stamp}`;
        renameSync(target, backup);
        console.log(`  backed up: ${backup}`);
      } else {
        console.error(
          `\nTarget already exists: ${target}\n` +
            `Re-run with --upgrade to back it up to <name>.bak-<timestamp>,\n` +
            `or --force to remove it first. Or set CHEST_HOME to a different root.`,
        );
        process.exit(2);
      }
    }

    mkdirSync(target, { recursive: true });
    cpSync(sourceDir, target, { recursive: true });
    console.log(`  copied:  ${target}`);

    if (existsSync(join(target, "package.json"))) {
      console.log(`  npm install...`);
      const inst = spawnSync("npm", ["install", "--silent"], {
        cwd: target,
        stdio: "inherit",
      });
      if (inst.status !== 0) {
        console.error(
          `\nnpm install failed in ${target}. Skill files are in place;\n` +
            `re-run \`npm install\` there manually.`,
        );
        process.exit(2);
      }
    }

    console.log(`\n  ✓ installed ${app.name} → ${target}`);

    await promptForAuth();

    if (app.install.prompt) {
      console.log(`\n  next:    ${app.install.prompt}\n`);
    } else {
      console.log();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
