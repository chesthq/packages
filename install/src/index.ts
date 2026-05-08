#!/usr/bin/env node
/**
 * `npx @chest-gate/install <slug>` — one-command installer for Chest Gate skills.
 *
 * Looks up the slug at gate.chest.sh, parses sourceUrl (a GitHub tree URL),
 * shallow-clones the repo into a temp dir, copies the skill subpath to the
 * runtime folder (~/.claude/skills/<name> for kind=skill), then runs
 * `npm install` if package.json is present.
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
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const VERSION = "0.1.0";
const DEFAULT_API = "https://gate.chest.sh";
const KEYS_URL = "https://chest.sh/app/keys";
const AUTH_FILE = join(homedir(), ".chest", "auth.json");

type AppKind = "skill" | "plugin" | "mcp";

interface AppManifest {
  slug: string;
  name: string;
  kind: AppKind;
  version: string;
  sourceUrl: string | null;
  install: Record<string, string | undefined>;
}

function usage(): never {
  console.error(
    [
      `chest-install ${VERSION}`,
      "",
      "Usage:",
      "  npx @chest-gate/install <slug>",
      "",
      "Examples:",
      "  npx @chest-gate/install trading-bot",
      "",
      "Env:",
      "  CHEST_API   override registry (default: https://gate.chest.sh)",
      "  CHEST_HOME  override install root (default: ~/.claude/skills)",
    ].join("\n"),
  );
  process.exit(1);
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

function targetDir(kind: AppKind, name: string): string {
  const root =
    process.env.CHEST_HOME ?? join(homedir(), ".claude", "skills");
  if (kind !== "skill") {
    console.error(
      `\nThis installer currently only handles kind=skill. Got kind=${kind}.\n` +
        `Follow the manual install on the app's page for now.`,
    );
    process.exit(2);
  }
  return join(root, name);
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
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (args.length !== 1) usage();
  const slug = args[0];

  console.log(`\n  ⚡ chest install ${slug}\n`);

  const app = await fetchManifest(slug);
  if (!app.sourceUrl) {
    console.error(
      `\n${slug} has no sourceUrl in its manifest, can't install. Ask the\n` +
        `author to publish a sourceUrl pointing at a GitHub tree URL.`,
    );
    process.exit(2);
  }

  const parsed = parseGithubTreeUrl(app.sourceUrl);
  if (!parsed) {
    console.error(
      `\nsourceUrl is not a GitHub tree URL: ${app.sourceUrl}\n` +
        `Expected: https://github.com/<owner>/<repo>/tree/<ref>/<path>`,
    );
    process.exit(2);
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
    const target = targetDir(app.kind, skillName);

    if (existsSync(target)) {
      console.error(
        `\nTarget already exists: ${target}\n` +
          `Remove it first or set CHEST_HOME to a different root.`,
      );
      process.exit(2);
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
