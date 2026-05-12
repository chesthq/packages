import { readFile, writeFile, mkdir, chmod, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CHEST_DIR = join(homedir(), ".chest");
const CREDENTIALS_PATH = join(CHEST_DIR, "agent-token.json");

const DEFAULT_GATE_URL = "https://gate.chest.sh";

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
 * Load credentials, preferring CHEST_AGENT_TOKEN env over the on-disk file.
 * Returns null if neither is present.
 */
export async function loadCredentials(): Promise<ResolvedCredentials | null> {
  const envToken = process.env.CHEST_AGENT_TOKEN?.trim();
  if (envToken) {
    return {
      version: 1,
      token: envToken,
      ownerWallet: "",
      tokenId: "",
      label: "CHEST_AGENT_TOKEN env",
      gateUrl: process.env.CHEST_GATE_URL?.trim() || DEFAULT_GATE_URL,
      createdAt: "",
      source: "env",
    };
  }

  if (!existsSync(CREDENTIALS_PATH)) return null;

  const raw = await readFile(CREDENTIALS_PATH, "utf-8");
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
  if (!existsSync(CREDENTIALS_PATH)) return false;
  await unlink(CREDENTIALS_PATH);
  return true;
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
