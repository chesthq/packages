import { readFile, writeFile, mkdir, chmod, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CHEST_DIR = join(homedir(), ".chest");
const CREDENTIALS_PATH = join(CHEST_DIR, "developer-token.json");
const LEGACY_CREDENTIALS_PATH = join(CHEST_DIR, "credentials.json");

const DEFAULT_GATE_URL = "https://gate.chest.sh";

let _warnedLegacy = false;
function warnLegacyOnce(): void {
  if (_warnedLegacy) return;
  _warnedLegacy = true;
  process.emitWarning(
    `~/.chest/credentials.json is deprecated; rename to ~/.chest/developer-token.json.`,
    "DeprecationWarning",
  );
}

function resolveReadPath(): string | null {
  if (existsSync(CREDENTIALS_PATH)) return CREDENTIALS_PATH;
  if (existsSync(LEGACY_CREDENTIALS_PATH)) {
    warnLegacyOnce();
    return LEGACY_CREDENTIALS_PATH;
  }
  return null;
}

export interface Credentials {
  version: 1;
  token: string;
  ownerWallet: string;
  tokenId: string;
  label: string;
  gateUrl: string;
  createdAt: string;
}

export interface ResolvedCredentials extends Credentials {
  source: "env" | "file";
}

/**
 * Load credentials, preferring CHEST_TOKEN env over the on-disk file.
 * Returns null if neither is present.
 */
export async function loadCredentials(): Promise<ResolvedCredentials | null> {
  const envToken = process.env.CHEST_TOKEN?.trim();
  if (envToken) {
    return {
      version: 1,
      token: envToken,
      ownerWallet: "",
      tokenId: "",
      label: "CHEST_TOKEN env",
      gateUrl: process.env.CHEST_GATE_URL?.trim() || DEFAULT_GATE_URL,
      createdAt: "",
      source: "env",
    };
  }

  const path = resolveReadPath();
  if (!path) return null;

  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as Credentials;
  return { ...parsed, source: "file" };
}

export async function requireCredentials(): Promise<ResolvedCredentials> {
  const creds = await loadCredentials();
  if (!creds) {
    throw new Error("Not logged in. Run `chest-gate login` first.");
  }
  return creds;
}

export async function saveCredentials(creds: Credentials): Promise<string> {
  await mkdir(CHEST_DIR, { recursive: true, mode: 0o700 });
  await chmod(CHEST_DIR, 0o700).catch(() => {});
  await writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
  await chmod(CREDENTIALS_PATH, 0o600).catch(() => {});
  return CREDENTIALS_PATH;
}

export async function deleteCredentials(): Promise<boolean> {
  let removed = false;
  if (existsSync(CREDENTIALS_PATH)) {
    await unlink(CREDENTIALS_PATH);
    removed = true;
  }
  if (existsSync(LEGACY_CREDENTIALS_PATH)) {
    await unlink(LEGACY_CREDENTIALS_PATH);
    removed = true;
  }
  return removed;
}

export function getCredentialsPath(): string {
  return CREDENTIALS_PATH;
}

export function getDefaultGateUrl(): string {
  return process.env.CHEST_GATE_URL?.trim() || DEFAULT_GATE_URL;
}

export function getDefaultWebUrl(): string {
  return process.env.CHEST_WEB_URL?.trim() || "https://chest.sh";
}
